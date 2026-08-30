create extension if not exists pgcrypto;

-- ============================================================
-- 3.1 profiles
-- ============================================================
create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,

  first_name text,
  date_of_birth date,
  locale text not null default 'en-US',
  timezone text,

  current_life_period text,
  current_life_substage text,

  onboarding_status text not null default 'not_started'
    check (onboarding_status in (
      'not_started', 'router_in_progress', 'router_completed',
      'period_in_progress', 'completed'
    )),

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- ============================================================
-- 3.2 birth_events — конкретное событие родов
--
-- Это стабильная сущность. Повторный вход в послеродовой период
-- после тех же родов находит ту же запись по (user_id, occurred_on),
-- поэтому дети не дублируются из-за новой строки user_lifecycle.
-- ============================================================
create table public.birth_events (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  occurred_on date not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(user_id, occurred_on)
);

-- ============================================================
-- 3.3 user_lifecycle
-- ============================================================
create table public.user_lifecycle (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,

  life_period text not null,
  life_substage text,
  birth_event_id uuid references public.birth_events(id) on delete set null,

  status text not null default 'active' check (status in ('active','ended')),
  source text not null check (source in ('onboarding','manual','system')),

  routing_confidence text
    check (routing_confidence is null or routing_confidence in ('LOW','MEDIUM','HIGH')),
  additional_contexts jsonb not null default '[]'::jsonb,
  period_selected_manually boolean not null default false,

  started_at timestamptz not null default now(),
  ended_at timestamptz,
  created_at timestamptz not null default now()
);

create unique index one_active_lifecycle_per_user
on public.user_lifecycle(user_id) where status = 'active';

-- ============================================================
-- 3.4 onboarding_definitions
-- ============================================================
create table public.onboarding_definitions (
  id uuid primary key default gen_random_uuid(),
  onboarding_key text not null,
  life_period text not null,
  version integer not null,
  locale text not null,
  schema jsonb not null,
  status text not null default 'draft' check (status in ('draft','published','archived')),
  published_at timestamptz,
  created_at timestamptz not null default now(),
  unique(onboarding_key, version, locale)
);

-- ============================================================
-- 3.5 onboarding_sessions
-- ============================================================
create table public.onboarding_sessions (
  id uuid primary key default gen_random_uuid(),

  user_id uuid not null references public.profiles(id) on delete cascade,
  definition_id uuid not null references public.onboarding_definitions(id),

  onboarding_key text not null,
  life_period text not null,
  status text not null default 'in_progress'
    check (status in ('in_progress','completed','abandoned','superseded')),

  prefill_source_session_id uuid references public.onboarding_sessions(id),

  -- Заполняются только у завершённой сессии lifecycle_router.
  -- Они делают prefill одноразовым и аудируемым.
  prefill_consumed_at timestamptz,
  prefill_consumed_by_session_id uuid references public.onboarding_sessions(id) on delete set null,

  current_section_id text,
  last_answered_field_id text,

  started_at timestamptz not null default now(),
  last_activity_at timestamptz not null default now(),
  completed_at timestamptz,
  created_at timestamptz not null default now(),

  unique (id, user_id),
  check (
    (prefill_consumed_at is null and prefill_consumed_by_session_id is null)
    or
    (prefill_consumed_at is not null and prefill_consumed_by_session_id is not null
      and onboarding_key = 'lifecycle_router')
  )
);

create unique index one_in_progress_session_per_key
on public.onboarding_sessions(user_id, onboarding_key) where status = 'in_progress';

-- ============================================================
-- 3.6 onboarding_answers
-- ============================================================
create table public.onboarding_answers (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null,
  user_id uuid not null,
  field_id text not null,
  answer_value jsonb not null,
  answer_type text not null,
  sensitivity_level text not null default 'standard'
    check (sensitivity_level in ('standard','health','highly_sensitive')),
  source text not null default 'user' check (source in ('user','router_prefill')),
  answered_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(session_id, field_id),
  foreign key (session_id, user_id)
    references public.onboarding_sessions(id, user_id) on delete cascade
);

-- ============================================================
-- 3.7 profile_snapshots
-- ============================================================
create table public.profile_snapshots (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  source_session_id uuid references public.onboarding_sessions(id),
  life_period text not null,
  profile_version integer not null default 1,
  profile_data jsonb not null,
  safety_flags jsonb not null default '{}'::jsonb,
  generated_by text not null,
  generated_at timestamptz not null default now(),
  is_current boolean not null default false
);

create unique index one_current_profile_snapshot
on public.profile_snapshots(user_id, life_period) where is_current = true;

-- ============================================================
-- 3.8 user_children — производная проекция детей конкретных родов
--
-- Перед каждой синхронизацией набор текущего birth_event удаляется
-- и строится заново. Источник истины — onboarding_answers.
-- ============================================================
create table public.user_children (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  birth_event_id uuid not null references public.birth_events(id) on delete cascade,
  child_index integer not null check (child_index >= 1),
  display_name text,
  status text not null default 'unknown'
    check (status in ('home','hospital','both','not_with_me','deceased','unknown')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(user_id, birth_event_id, child_index)
);

-- ============================================================
-- 4.1 get_question_def
-- ============================================================
create or replace function public.get_question_def(p_definition_id uuid, p_field_id text)
returns jsonb
language sql stable security definer set search_path = public
as $$
  select q.question
  from public.onboarding_definitions d
  cross join lateral jsonb_array_elements(d.schema -> 'sections') s(section)
  cross join lateral jsonb_array_elements(s.section -> 'questions') q(question)
  where d.id = p_definition_id and q.question ->> 'field_id' = p_field_id
  limit 1;
$$;

-- ============================================================
-- 4.2 resolve_child_indices
-- NULL = число неизвестно; '{}' = живых детей нет; {1,2} = индексы.
-- ============================================================
create or replace function public.resolve_child_indices(p_session_id uuid, p_question jsonb)
returns int[]
language plpgsql stable security definer set search_path = public
as $$
declare
  v_ans jsonb;
  v_map jsonb;
  v_n int;
  v_status jsonb;
  v_result int[] := '{}';
  v_i int;
begin
  if not (p_question ? 'repeat_count_from') then
    return null;
  end if;

  select answer_value into v_ans
  from public.onboarding_answers
  where session_id = p_session_id
    and field_id = p_question ->> 'repeat_count_from';

  if v_ans is null or v_ans ? 'reason' then
    return null;
  end if;

  v_map := p_question -> 'repeat_count_map';
  if v_map is not null and v_map ? coalesce(v_ans ->> 'value', '') then
    v_n := (v_map ->> (v_ans ->> 'value'))::int;
  elsif p_question ? 'repeat_count_exact_from' then
    select answer_value into v_ans
    from public.onboarding_answers
    where session_id = p_session_id
      and field_id = p_question ->> 'repeat_count_exact_from';

    if v_ans is not null
       and not (v_ans ? 'reason')
       and jsonb_typeof(v_ans -> 'value') = 'number' then
      v_n := (v_ans ->> 'value')::int;
    end if;
  end if;

  if v_n is null or v_n < 1 then
    return null;
  end if;

  if coalesce(p_question ->> 'repeat_scope', 'all') = 'living'
     and p_question ? 'living_status_from' then
    select answer_value into v_status
    from public.onboarding_answers
    where session_id = p_session_id
      and field_id = p_question ->> 'living_status_from';
  end if;

  for v_i in 1 .. v_n loop
    if v_status is null
       or coalesce(v_status -> 'by_child' ->> v_i::text, '') <> 'deceased' then
      v_result := array_append(v_result, v_i);
    end if;
  end loop;

  return v_result;
end;
$$;

-- ============================================================
-- 4.3 evaluate_condition
-- Единый рекурсивный движок show_if.
-- ============================================================
create or replace function public.evaluate_condition(p_session_id uuid, p_condition jsonb)
returns boolean
language plpgsql stable security definer set search_path = public
as $$
declare
  v_item jsonb;
  v_answer jsonb;
  v_num numeric;
begin
  if jsonb_typeof(p_condition) is distinct from 'object' then
    return false;
  end if;

  if p_condition ? 'all' then
    if jsonb_typeof(p_condition -> 'all') is distinct from 'array'
       or jsonb_array_length(p_condition -> 'all') = 0 then
      return false;
    end if;
    for v_item in select value from jsonb_array_elements(p_condition -> 'all') loop
      if not public.evaluate_condition(p_session_id, v_item) then
        return false;
      end if;
    end loop;
    return true;
  end if;

  if p_condition ? 'any' then
    if jsonb_typeof(p_condition -> 'any') is distinct from 'array'
       or jsonb_array_length(p_condition -> 'any') = 0 then
      return false;
    end if;
    for v_item in select value from jsonb_array_elements(p_condition -> 'any') loop
      if public.evaluate_condition(p_session_id, v_item) then
        return true;
      end if;
    end loop;
    return false;
  end if;

  if p_condition ? 'not' then
    return not public.evaluate_condition(p_session_id, p_condition -> 'not');
  end if;

  if not (p_condition ? 'field_id') then
    return false;
  end if;

  select answer_value into v_answer
  from public.onboarding_answers
  where session_id = p_session_id
    and field_id = p_condition ->> 'field_id';

  if p_condition ? 'exists' then
    return (v_answer is not null) = ((p_condition ->> 'exists')::boolean);
  end if;

  -- Этот оператор намеренно проверяется до общего отказа для skip-ответов.
  if p_condition ? 'reason_in' then
    return v_answer is not null
       and v_answer ? 'reason'
       and (p_condition -> 'reason_in') ? coalesce(v_answer ->> 'reason', '');
  end if;

  if v_answer is null or v_answer ? 'reason' then
    return false;
  end if;

  if p_condition ? 'in' then
    return (p_condition -> 'in') ? coalesce(v_answer ->> 'value', '');
  end if;

  if p_condition ? 'not_in' then
    return not ((p_condition -> 'not_in') ? coalesce(v_answer ->> 'value', ''));
  end if;

  if p_condition ? 'selected_any_in' then
    if jsonb_typeof(v_answer -> 'selected') is distinct from 'array' then
      return false;
    end if;
    return exists (
      select 1
      from jsonb_array_elements_text(v_answer -> 'selected') x(value)
      where (p_condition -> 'selected_any_in') ? x.value
    );
  end if;

  if p_condition ? 'selected_all_in' then
    if jsonb_typeof(v_answer -> 'selected') is distinct from 'array'
       or jsonb_typeof(p_condition -> 'selected_all_in') is distinct from 'array'
       or jsonb_array_length(p_condition -> 'selected_all_in') = 0 then
      return false;
    end if;
    -- Все значения, перечисленные в условии, должны присутствовать в ответе.
    return not exists (
      select 1
      from jsonb_array_elements_text(p_condition -> 'selected_all_in') required(value)
      where not ((v_answer -> 'selected') ? required.value)
    );
  end if;

  if p_condition ? 'by_child_any_in' then
    if jsonb_typeof(v_answer -> 'by_child') is distinct from 'object' then
      return false;
    end if;
    return exists (
      select 1
      from jsonb_each_text(v_answer -> 'by_child') x(key, value)
      where (p_condition -> 'by_child_any_in') ? x.value
    );
  end if;

  if p_condition ? 'by_child_all_in' then
    if jsonb_typeof(v_answer -> 'by_child') is distinct from 'object'
       or (select count(*) from jsonb_object_keys(v_answer -> 'by_child')) = 0 then
      return false;
    end if;
    -- Каждое фактическое значение ребёнка должно входить в разрешённый набор.
    return not exists (
      select 1
      from jsonb_each_text(v_answer -> 'by_child') x(key, value)
      where not ((p_condition -> 'by_child_all_in') ? x.value)
    );
  end if;

  if p_condition ? 'number_gte' or p_condition ? 'number_lte' then
    if jsonb_typeof(v_answer -> 'value') is distinct from 'number' then
      return false;
    end if;
    v_num := (v_answer ->> 'value')::numeric;
    if p_condition ? 'number_gte'
       and v_num < (p_condition ->> 'number_gte')::numeric then
      return false;
    end if;
    if p_condition ? 'number_lte'
       and v_num > (p_condition ->> 'number_lte')::numeric then
      return false;
    end if;
    return true;
  end if;

  return false;
end;
$$;

-- ============================================================
-- 4.4 is_question_visible
-- ============================================================
create or replace function public.is_question_visible(p_session_id uuid, p_question jsonb)
returns boolean
language plpgsql stable security definer set search_path = public
as $$
declare
  v_idx int[];
begin
  if (p_question ->> 'format') in ('per_child_single_choice','per_child_short_text') then
    v_idx := public.resolve_child_indices(p_session_id, p_question);
    if v_idx is null or array_length(v_idx, 1) is null then
      return false;
    end if;
  end if;

  if not (p_question ? 'show_if') then
    return true;
  end if;

  return public.evaluate_condition(p_session_id, p_question -> 'show_if');
end;
$$;

-- ============================================================
-- 4.5 validate_answer_value
-- ============================================================
create or replace function public.validate_answer_value(
  p_session_id uuid,
  p_question jsonb,
  p_answer_value jsonb
)
returns text
language plpgsql stable security definer set search_path = public
as $$
declare
  v_format text := p_question ->> 'format';
  v_options jsonb := p_question -> 'options';
  v_required boolean := coalesce((p_question ->> 'required')::boolean, false);
  v_elem jsonb;
  v_row jsonb;
  v_k text;
  v_v text;
  v_cnt int;
  v_idx int[];
  v_seen text[];
  v_date date;
  v_num numeric;
begin
  if jsonb_typeof(p_answer_value) is distinct from 'object' then
    return 'answer_must_be_object';
  end if;

  if p_answer_value ? 'reason' then
    if (p_answer_value ->> 'reason') not in ('prefer_not_to_answer', 'do_not_know') then
      return 'unknown_reason';
    end if;
    if v_required and not coalesce((p_question ->> 'skippable')::boolean, true) then
      return 'required_question_cannot_be_skipped';
    end if;
    return null;
  end if;

  if v_format = 'single_choice' then
    if jsonb_typeof(p_answer_value -> 'value') is distinct from 'string' then
      return 'single_choice_requires_string_value';
    end if;
    if v_options is not null and not (v_options ? (p_answer_value ->> 'value')) then
      return 'invalid_option: ' || (p_answer_value ->> 'value');
    end if;

  elsif v_format = 'multi_choice' then
    if jsonb_typeof(p_answer_value -> 'selected') is distinct from 'array' then
      return 'multi_choice_requires_selected_array';
    end if;
    v_cnt := jsonb_array_length(p_answer_value -> 'selected');
    if v_required and v_cnt = 0 then
      return 'multi_choice_required_but_empty';
    end if;
    if p_question ? 'max_select' and v_cnt > (p_question ->> 'max_select')::int then
      return 'too_many_options: ' || v_cnt || ' > ' || (p_question ->> 'max_select');
    end if;
    v_seen := '{}';
    for v_elem in select value from jsonb_array_elements(p_answer_value -> 'selected') loop
      if jsonb_typeof(v_elem) is distinct from 'string' then
        return 'multi_choice_items_must_be_strings';
      end if;
      v_v := v_elem #>> '{}';
      if v_v = any(v_seen) then
        return 'duplicate_option: ' || v_v;
      end if;
      v_seen := array_append(v_seen, v_v);
      if v_options is not null and not (v_options ? v_v) then
        return 'invalid_option: ' || v_v;
      end if;
    end loop;

  elsif v_format = 'per_child_single_choice' then
    if jsonb_typeof(p_answer_value -> 'by_child') is distinct from 'object' then
      return 'per_child_requires_by_child_object';
    end if;
    v_idx := public.resolve_child_indices(p_session_id, p_question);
    if v_idx is null then
      return 'child_count_unknown: use the general variant of this question';
    end if;
    if array_length(v_idx, 1) is null then
      return 'no_living_children: this question is not applicable';
    end if;

    for v_k, v_elem in select key, value from jsonb_each(p_answer_value -> 'by_child') loop
      if v_k !~ '^[0-9]+$' then
        return 'child_key_must_be_number: ' || v_k;
      end if;
      if not (v_k::int = any(v_idx)) then
        return 'child_index_not_expected: ' || v_k;
      end if;
      if jsonb_typeof(v_elem) is distinct from 'string' then
        return 'per_child_choice_requires_string for child ' || v_k;
      end if;
      v_v := v_elem #>> '{}';
      if v_options is not null and not (v_options ? v_v) then
        return 'invalid_option for child ' || v_k || ': ' || v_v;
      end if;
    end loop;

    if v_required and
       (select count(*) from jsonb_object_keys(p_answer_value -> 'by_child')) <> array_length(v_idx, 1) then
      return 'answer_required_for_every_child';
    end if;

  elsif v_format = 'per_child_short_text' then
    if jsonb_typeof(p_answer_value -> 'by_child') is distinct from 'object' then
      return 'per_child_requires_by_child_object';
    end if;
    v_idx := public.resolve_child_indices(p_session_id, p_question);
    if v_idx is null then
      return 'child_count_unknown';
    end if;
    if array_length(v_idx, 1) is null then
      return 'no_living_children: this question is not applicable';
    end if;

    for v_k, v_elem in select key, value from jsonb_each(p_answer_value -> 'by_child') loop
      if v_k !~ '^[0-9]+$' then
        return 'child_key_must_be_number: ' || v_k;
      end if;
      if not (v_k::int = any(v_idx)) then
        return 'child_index_not_expected: ' || v_k;
      end if;
      if jsonb_typeof(v_elem) is distinct from 'string' then
        return 'per_child_short_text_requires_string for child ' || v_k;
      end if;
      v_v := v_elem #>> '{}';
      if length(v_v) > coalesce((p_question ->> 'max_length')::int, 50) then
        return 'text_too_long for child ' || v_k;
      end if;
      if v_required and btrim(v_v) = '' then
        return 'text_required_for_child ' || v_k;
      end if;
    end loop;

    if v_required and
       (select count(*) from jsonb_object_keys(p_answer_value -> 'by_child')) <> array_length(v_idx, 1) then
      return 'answer_required_for_every_child';
    end if;

  elsif v_format = 'paired_choice' then
    if jsonb_typeof(p_answer_value -> 'rows') is distinct from 'object' then
      return 'paired_choice_requires_rows_object';
    end if;
    for v_k, v_elem in select key, value from jsonb_each(p_answer_value -> 'rows') loop
      if jsonb_typeof(v_elem) is distinct from 'string' then
        return 'paired_choice_requires_string in row ' || v_k;
      end if;
      v_v := v_elem #>> '{}';
      v_row := null;
      select r.row into v_row
      from jsonb_array_elements(p_question -> 'rows') r(row)
      where r.row ->> 'row_id' = v_k
      limit 1;
      if v_row is null then
        return 'unknown_row: ' || v_k;
      end if;
      if not (v_row -> 'options' ? v_v) then
        return 'invalid_option in row ' || v_k || ': ' || v_v;
      end if;
    end loop;
    if v_required and
       (select count(*) from jsonb_object_keys(p_answer_value -> 'rows'))
       <> jsonb_array_length(p_question -> 'rows') then
      return 'answer_required_for_every_row';
    end if;

  elsif v_format = 'number' then
    if jsonb_typeof(p_answer_value -> 'value') is distinct from 'number' then
      return 'number_requires_numeric_value';
    end if;
    v_num := (p_answer_value ->> 'value')::numeric;
    if coalesce((p_question ->> 'integer')::boolean, false) and trunc(v_num) <> v_num then
      return 'integer_required';
    end if;
    if p_question ? 'min' and v_num < (p_question ->> 'min')::numeric then
      return 'below_min';
    end if;
    if p_question ? 'max' and v_num > (p_question ->> 'max')::numeric then
      return 'above_max';
    end if;

  elsif v_format in ('date', 'date_confirm') then
    if jsonb_typeof(p_answer_value -> 'date') is distinct from 'string' then
      return 'date_required';
    end if;
    begin
      v_date := (p_answer_value ->> 'date')::date;
    exception when others then
      return 'invalid_date: ' || (p_answer_value ->> 'date');
    end;

    if (p_question ->> 'date_constraint') = 'past_or_today' and v_date > current_date then
      return 'date_must_be_past_or_today';
    end if;
    if (p_question ->> 'date_constraint') = 'future_or_today' and v_date < current_date then
      return 'date_must_be_future_or_today';
    end if;
    if p_question ? 'max_future_days'
       and v_date > current_date + (p_question ->> 'max_future_days')::int then
      return 'date_too_far_in_future';
    end if;
    if p_question ? 'max_past_days'
       and v_date < current_date - (p_question ->> 'max_past_days')::int then
      return 'date_too_far_in_past';
    end if;

    if v_format = 'date_confirm' then
      if jsonb_typeof(p_answer_value -> 'confirmed') is distinct from 'boolean' then
        return 'date_confirm_requires_confirmed_boolean';
      end if;
      if (p_answer_value ->> 'confirmed')::boolean is not true then
        return 'date_must_be_confirmed';
      end if;
    end if;

  elsif v_format = 'short_text' then
    if jsonb_typeof(p_answer_value -> 'text') is distinct from 'string' then
      return 'short_text_requires_string';
    end if;
    if length(p_answer_value ->> 'text') > coalesce((p_question ->> 'max_length')::int, 200) then
      return 'text_too_long';
    end if;
    if v_required and btrim(p_answer_value ->> 'text') = '' then
      return 'short_text_required_but_empty';
    end if;

  else
    return 'unsupported_format: ' || coalesce(v_format, 'null');
  end if;

  return null;
end;
$$;

-- ============================================================
-- 4.6 unwrap_answer
-- ============================================================
create or replace function public.unwrap_answer(p_answer jsonb)
returns jsonb
language sql immutable
as $$
  select case
    when jsonb_typeof(p_answer) = 'object' and p_answer ? 'value'
         and (select count(*) from jsonb_object_keys(p_answer)) = 1 then p_answer -> 'value'
    when jsonb_typeof(p_answer) = 'object' and p_answer ? 'selected'
         and (select count(*) from jsonb_object_keys(p_answer)) = 1 then p_answer -> 'selected'
    when jsonb_typeof(p_answer) = 'object' and p_answer ? 'by_child'
         and (select count(*) from jsonb_object_keys(p_answer)) = 1 then p_answer -> 'by_child'
    when jsonb_typeof(p_answer) = 'object' and p_answer ? 'rows'
         and (select count(*) from jsonb_object_keys(p_answer)) = 1 then p_answer -> 'rows'
    when jsonb_typeof(p_answer) = 'object' and p_answer ? 'text'
         and (select count(*) from jsonb_object_keys(p_answer)) = 1 then p_answer -> 'text'
    when jsonb_typeof(p_answer) = 'object' and p_answer ? 'date' then p_answer -> 'date'
    else p_answer
  end;
$$;

-- ============================================================
-- 4.7 validate_onboarding_session
-- ============================================================
create or replace function public.validate_onboarding_session(p_session_id uuid)
returns text[]
language plpgsql stable security definer set search_path = public
as $$
declare
  v_definition_id uuid;
  v_missing text[] := '{}';
  v_q jsonb;
begin
  select definition_id into v_definition_id
  from public.onboarding_sessions
  where id = p_session_id and user_id = auth.uid();

  if v_definition_id is null then
    raise exception 'session_not_found';
  end if;

  for v_q in
    select q.question
    from public.onboarding_definitions d
    cross join lateral jsonb_array_elements(d.schema -> 'sections') s(section)
    cross join lateral jsonb_array_elements(s.section -> 'questions') q(question)
    where d.id = v_definition_id
      and coalesce((q.question ->> 'required')::boolean, false) = true
  loop
    if public.is_question_visible(p_session_id, v_q)
       and not exists (
         select 1 from public.onboarding_answers
         where session_id = p_session_id
           and field_id = v_q ->> 'field_id'
       ) then
      v_missing := array_append(v_missing, v_q ->> 'field_id');
    end if;
  end loop;

  return v_missing;
end;
$$;

-- ============================================================
-- 4.8 jsonb_set_deep
-- ============================================================
create or replace function public.jsonb_set_deep(p_target jsonb, p_path text[], p_value jsonb)
returns jsonb
language plpgsql immutable
as $$
declare
  v_result jsonb := p_target;
  v_i int;
  v_sub text[];
begin
  for v_i in 1 .. array_length(p_path, 1) - 1 loop
    v_sub := p_path[1:v_i];
    if jsonb_typeof(v_result #> v_sub) is distinct from 'object' then
      v_result := jsonb_set(v_result, v_sub, '{}'::jsonb, true);
    end if;
  end loop;
  return jsonb_set(v_result, p_path, p_value, true);
end;
$$;

-- ============================================================
-- 4.9 build_profile_data
-- ============================================================
create or replace function public.build_profile_data(p_session_id uuid)
returns jsonb
language plpgsql stable security definer set search_path = public
as $$
declare
  v_definition_id uuid;
  v_profile jsonb := '{}'::jsonb;
  v_row record;
  v_q jsonb;
  v_path text;
begin
  select definition_id into v_definition_id
  from public.onboarding_sessions where id = p_session_id;

  for v_row in
    select field_id, answer_value
    from public.onboarding_answers
    where session_id = p_session_id
    order by field_id
  loop
    v_q := public.get_question_def(v_definition_id, v_row.field_id);
    v_path := v_q ->> 'profile_path';
    if v_path is null then
      v_profile := public.jsonb_set_deep(
        v_profile, array['raw', v_row.field_id], public.unwrap_answer(v_row.answer_value)
      );
    else
      v_profile := public.jsonb_set_deep(
        v_profile, string_to_array(v_path, '.'), public.unwrap_answer(v_row.answer_value)
      );
    end if;
  end loop;

  return v_profile;
end;
$$;

-- ============================================================
-- 4.10 sync_user_children
-- Полное delete + insert для конкретного birth_event.
-- ============================================================
create or replace function public.sync_user_children(p_session_id uuid)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  v_user_id uuid;
  v_definition_id uuid;
  v_q jsonb;
  v_count_ans jsonb;
  v_map jsonb;
  v_n int;
  v_status jsonb;
  v_shared_status jsonb;
  v_shared_status_value text;
  v_shared_mapped_status text;
  v_names jsonb;
  v_birth_date_ans jsonb;
  v_birth_date date;
  v_birth_event_id uuid;
  v_i int;
  v_status_val text;
  v_name text;
begin
  select user_id, definition_id
  into v_user_id, v_definition_id
  from public.onboarding_sessions
  where id = p_session_id;

  select q.question into v_q
  from public.onboarding_definitions d
  cross join lateral jsonb_array_elements(d.schema -> 'sections') s(section)
  cross join lateral jsonb_array_elements(s.section -> 'questions') q(question)
  where d.id = v_definition_id
    and coalesce((q.question ->> 'is_child_count')::boolean, false)
  limit 1;

  if v_q is null then
    return;
  end if;

  select answer_value into v_birth_date_ans
  from public.onboarding_answers
  where session_id = p_session_id
    and field_id = v_q ->> 'birth_event_date_from';

  if v_birth_date_ans is null
     or v_birth_date_ans ? 'reason'
     or jsonb_typeof(v_birth_date_ans -> 'date') is distinct from 'string' then
    raise exception 'birth_event_date_missing';
  end if;

  v_birth_date := (v_birth_date_ans ->> 'date')::date;

  insert into public.birth_events(user_id, occurred_on)
  values (v_user_id, v_birth_date)
  on conflict (user_id, occurred_on) do update
    set updated_at = now()
  returning id into v_birth_event_id;

  update public.user_lifecycle
  set birth_event_id = v_birth_event_id
  where user_id = v_user_id and status = 'active';

  select answer_value into v_count_ans
  from public.onboarding_answers
  where session_id = p_session_id
    and field_id = v_q ->> 'field_id';

  v_map := v_q -> 'repeat_count_map';
  if v_count_ans is not null and not (v_count_ans ? 'reason') then
    if v_map is not null and v_map ? coalesce(v_count_ans ->> 'value', '') then
      v_n := (v_map ->> (v_count_ans ->> 'value'))::int;
    elsif v_q ? 'repeat_count_exact_from' then
      select answer_value into v_count_ans
      from public.onboarding_answers
      where session_id = p_session_id
        and field_id = v_q ->> 'repeat_count_exact_from';
      if v_count_ans is not null
         and not (v_count_ans ? 'reason')
         and jsonb_typeof(v_count_ans -> 'value') = 'number' then
        v_n := (v_count_ans ->> 'value')::int;
      end if;
    end if;
  end if;

  -- Полная пересборка: очищенное имя или уменьшенное количество
  -- не оставляют старых производных данных.
  delete from public.user_children
  where user_id = v_user_id and birth_event_id = v_birth_event_id;

  if v_n is null or v_n < 1 then
    return;
  end if;

  if v_q ? 'child_status_from' then
    select answer_value into v_status
    from public.onboarding_answers
    where session_id = p_session_id
      and field_id = v_q ->> 'child_status_from';
  end if;

  if v_q ? 'shared_child_status_from' then
    select answer_value into v_shared_status
    from public.onboarding_answers
    where session_id = p_session_id
      and field_id = v_q ->> 'shared_child_status_from';

    v_shared_status_value := v_shared_status ->> 'value';
    if v_q ? 'shared_status_map'
       and (v_q -> 'shared_status_map') ? coalesce(v_shared_status_value, '') then
      v_shared_mapped_status := v_q -> 'shared_status_map' ->> v_shared_status_value;
    end if;
  end if;

  if v_q ? 'child_names_from' then
    select answer_value into v_names
    from public.onboarding_answers
    where session_id = p_session_id
      and field_id = v_q ->> 'child_names_from';
  end if;

  for v_i in 1 .. v_n loop
    v_status_val := coalesce(
      v_status -> 'by_child' ->> v_i::text,
      v_shared_mapped_status,
      'unknown'
    );

    if v_status_val not in ('home','hospital','both','not_with_me','deceased') then
      v_status_val := 'unknown';
    end if;

    v_name := nullif(btrim(v_names -> 'by_child' ->> v_i::text), '');

    insert into public.user_children(
      user_id, birth_event_id, child_index, display_name, status
    ) values (
      v_user_id, v_birth_event_id, v_i, v_name, v_status_val
    );
  end loop;
end;
$$;

-- ============================================================
-- 4.11 validate_show_if_condition
-- Проверка структуры show_if при публикации схемы.
-- ============================================================
create or replace function public.validate_show_if_condition(p_condition jsonb, p_ids text[])
returns text
language plpgsql immutable security definer set search_path = public
as $$
declare
  v_item jsonb;
  v_err text;
  v_field text;
  v_ops int := 0;
  v_struct_ops int := 0;
  v_value jsonb;
begin
  if jsonb_typeof(p_condition) is distinct from 'object' then
    return 'condition_must_be_object';
  end if;

  v_struct_ops :=
    case when p_condition ? 'all' then 1 else 0 end +
    case when p_condition ? 'any' then 1 else 0 end +
    case when p_condition ? 'not' then 1 else 0 end;

  if v_struct_ops > 1 then
    return 'condition_cannot_mix_all_any_not';
  end if;

  if v_struct_ops = 1 and p_condition ? 'field_id' then
    return 'condition_cannot_mix_group_and_leaf';
  end if;

  if p_condition ? 'all' then
    if jsonb_typeof(p_condition -> 'all') is distinct from 'array'
       or jsonb_array_length(p_condition -> 'all') = 0 then
      return 'all_requires_nonempty_array';
    end if;
    for v_item in select value from jsonb_array_elements(p_condition -> 'all') loop
      v_err := public.validate_show_if_condition(v_item, p_ids);
      if v_err is not null then return v_err; end if;
    end loop;
    return null;
  end if;

  if p_condition ? 'any' then
    if jsonb_typeof(p_condition -> 'any') is distinct from 'array'
       or jsonb_array_length(p_condition -> 'any') = 0 then
      return 'any_requires_nonempty_array';
    end if;
    for v_item in select value from jsonb_array_elements(p_condition -> 'any') loop
      v_err := public.validate_show_if_condition(v_item, p_ids);
      if v_err is not null then return v_err; end if;
    end loop;
    return null;
  end if;

  if p_condition ? 'not' then
    if jsonb_typeof(p_condition -> 'not') is distinct from 'object' then
      return 'not_requires_condition_object';
    end if;
    return public.validate_show_if_condition(p_condition -> 'not', p_ids);
  end if;

  v_field := p_condition ->> 'field_id';
  if v_field is null or btrim(v_field) = '' then
    return 'leaf_condition_without_field_id';
  end if;
  if not (v_field = any(p_ids)) then
    return 'condition_field_not_found: ' || v_field;
  end if;

  v_ops :=
    case when p_condition ? 'in' then 1 else 0 end +
    case when p_condition ? 'not_in' then 1 else 0 end +
    case when p_condition ? 'reason_in' then 1 else 0 end +
    case when p_condition ? 'selected_any_in' then 1 else 0 end +
    case when p_condition ? 'selected_all_in' then 1 else 0 end +
    case when p_condition ? 'by_child_any_in' then 1 else 0 end +
    case when p_condition ? 'by_child_all_in' then 1 else 0 end +
    case when p_condition ? 'number_gte' then 1 else 0 end +
    case when p_condition ? 'number_lte' then 1 else 0 end +
    case when p_condition ? 'exists' then 1 else 0 end;

  -- gte + lte разрешены вместе как один числовой диапазон.
  if (p_condition ? 'number_gte') and (p_condition ? 'number_lte') then
    v_ops := v_ops - 1;
  end if;

  if v_ops <> 1 then
    return 'leaf_condition_requires_exactly_one_operator_family: ' || v_field;
  end if;

  foreach v_value in array array[
    p_condition -> 'in',
    p_condition -> 'not_in',
    p_condition -> 'reason_in',
    p_condition -> 'selected_any_in',
    p_condition -> 'selected_all_in',
    p_condition -> 'by_child_any_in',
    p_condition -> 'by_child_all_in'
  ] loop
    if v_value is not null then
      if jsonb_typeof(v_value) is distinct from 'array'
         or jsonb_array_length(v_value) = 0 then
        return 'set_operator_requires_nonempty_array: ' || v_field;
      end if;
      if exists (
        select 1 from jsonb_array_elements(v_value) x(value)
        where jsonb_typeof(x.value) is distinct from 'string'
      ) then
        return 'set_operator_values_must_be_strings: ' || v_field;
      end if;
    end if;
  end loop;

  if p_condition ? 'reason_in' and exists (
    select 1 from jsonb_array_elements_text(p_condition -> 'reason_in') x(value)
    where x.value not in ('prefer_not_to_answer','do_not_know')
  ) then
    return 'reason_in_contains_unknown_reason: ' || v_field;
  end if;

  if p_condition ? 'exists'
     and jsonb_typeof(p_condition -> 'exists') is distinct from 'boolean' then
    return 'exists_requires_boolean: ' || v_field;
  end if;
  if p_condition ? 'number_gte'
     and jsonb_typeof(p_condition -> 'number_gte') is distinct from 'number' then
    return 'number_gte_requires_number: ' || v_field;
  end if;
  if p_condition ? 'number_lte'
     and jsonb_typeof(p_condition -> 'number_lte') is distinct from 'number' then
    return 'number_lte_requires_number: ' || v_field;
  end if;
  if p_condition ? 'number_gte' and p_condition ? 'number_lte'
     and (p_condition ->> 'number_gte')::numeric > (p_condition ->> 'number_lte')::numeric then
    return 'number_range_is_reversed: ' || v_field;
  end if;

  return null;
end;
$$;

-- ============================================================
-- 5.1 start_onboarding
-- ============================================================
create or replace function public.start_onboarding(
  p_onboarding_key text,
  p_locale text,
  p_prefill_from_session_id uuid default null
)
returns uuid
language plpgsql security definer set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_definition_id uuid;
  v_life_period text;
  v_session_id uuid;
  v_q jsonb;
  v_src_val jsonb;
  v_err text;
  v_latest_router_id uuid;
  v_consumed_by uuid;
begin
  if v_user_id is null then
    raise exception 'not_authenticated';
  end if;

  select id into v_session_id
  from public.onboarding_sessions
  where user_id = v_user_id
    and onboarding_key = p_onboarding_key
    and status = 'in_progress';

  if v_session_id is not null then
    return v_session_id;
  end if;

  select id, life_period into v_definition_id, v_life_period
  from public.onboarding_definitions
  where onboarding_key = p_onboarding_key
    and locale = p_locale
    and status = 'published'
  order by version desc
  limit 1;

  if v_definition_id is null then
    raise exception 'no_published_definition for % / %', p_onboarding_key, p_locale;
  end if;

  if p_onboarding_key <> 'lifecycle_router' then
    if not exists (
      select 1 from public.profiles
      where id = v_user_id
        and current_life_period = v_life_period
        and onboarding_status = 'period_in_progress'
    ) then
      raise exception 'period_transition_required';
    end if;
  end if;

  if p_prefill_from_session_id is not null then
    if p_onboarding_key = 'lifecycle_router' then
      raise exception 'router_cannot_be_prefilled_from_router';
    end if;

    select id into v_latest_router_id
    from public.onboarding_sessions
    where user_id = v_user_id
      and onboarding_key = 'lifecycle_router'
      and status = 'completed'
    order by completed_at desc nulls last, id desc
    limit 1;

    if v_latest_router_id is distinct from p_prefill_from_session_id then
      raise exception 'invalid_prefill_source: must be the latest completed router session';
    end if;

    select prefill_consumed_by_session_id
    into v_consumed_by
    from public.onboarding_sessions
    where id = p_prefill_from_session_id
      and user_id = v_user_id
      and onboarding_key = 'lifecycle_router'
      and status = 'completed'
    for update;

    if not found then
      raise exception 'invalid_prefill_source';
    end if;

    if v_consumed_by is not null then
      select id into v_session_id
      from public.onboarding_sessions
      where id = v_consumed_by
        and user_id = v_user_id
        and onboarding_key = p_onboarding_key
        and status = 'in_progress';

      if v_session_id is not null then
        return v_session_id;
      end if;

      raise exception 'prefill_source_already_consumed';
    end if;
  end if;

  begin
    insert into public.onboarding_sessions(
      user_id, definition_id, onboarding_key, life_period, prefill_source_session_id
    ) values (
      v_user_id, v_definition_id, p_onboarding_key, v_life_period, p_prefill_from_session_id
    ) returning id into v_session_id;
  exception when unique_violation then
    select id into v_session_id
    from public.onboarding_sessions
    where user_id = v_user_id
      and onboarding_key = p_onboarding_key
      and status = 'in_progress';
    return v_session_id;
  end;

  if p_prefill_from_session_id is not null then
    update public.onboarding_sessions
    set prefill_consumed_at = now(),
        prefill_consumed_by_session_id = v_session_id
    where id = p_prefill_from_session_id;

    for v_q in
      select q.question
      from public.onboarding_definitions d
      cross join lateral jsonb_array_elements(d.schema -> 'sections') s(section)
      cross join lateral jsonb_array_elements(s.section -> 'questions') q(question)
      where d.id = v_definition_id
        and q.question ? 'prefill_from'
        and coalesce(q.question ->> 'prefill_mode', 'hint_only') = 'copy'
    loop
      select answer_value into v_src_val
      from public.onboarding_answers
      where session_id = p_prefill_from_session_id
        and field_id = v_q ->> 'prefill_from';

      if v_src_val is not null
         and public.is_question_visible(v_session_id, v_q) then
        v_err := public.validate_answer_value(v_session_id, v_q, v_src_val);
        if v_err is null then
          insert into public.onboarding_answers(
            session_id, user_id, field_id, answer_value,
            answer_type, sensitivity_level, source
          ) values (
            v_session_id, v_user_id, v_q ->> 'field_id', v_src_val,
            v_q ->> 'format', coalesce(v_q ->> 'sensitivity_level', 'standard'),
            'router_prefill'
          ) on conflict (session_id, field_id) do nothing;
        end if;
      end if;
    end loop;
  end if;

  if p_onboarding_key = 'lifecycle_router' then
    update public.profiles
    set onboarding_status = 'router_in_progress', updated_at = now()
    where id = v_user_id
      and onboarding_status in ('not_started','router_completed','completed');
  end if;

  return v_session_id;
end;
$$;

-- ============================================================
-- 5.2 save_onboarding_answer
-- Очистка зависимых ответов происходит ЗДЕСЬ, в той же транзакции,
-- и транзитивно: A скрывает B, B скрывает C — очистятся оба.
-- Отдельной RPC clear_dependent_answers больше нет.
-- ============================================================
create or replace function public.save_onboarding_answer(
  p_session_id uuid,
  p_field_id text,
  p_answer_value jsonb
)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_definition_id uuid;
  v_q jsonb;
  v_err text;
  v_removed int;
  v_pass int := 0;
begin
  select definition_id into v_definition_id from public.onboarding_sessions
  where id = p_session_id and user_id = v_user_id and status = 'in_progress';

  if v_definition_id is null then
    raise exception 'session_not_found_or_not_editable';
  end if;

  v_q := public.get_question_def(v_definition_id, p_field_id);
  if v_q is null then
    raise exception 'unknown_field_id: %', p_field_id;
  end if;

  if not public.is_question_visible(p_session_id, v_q) then
    raise exception 'question_not_visible: %', p_field_id;
  end if;

  v_err := public.validate_answer_value(p_session_id, v_q, p_answer_value);
  if v_err is not null then
    raise exception 'invalid_answer for %: %', p_field_id, v_err;
  end if;

  insert into public.onboarding_answers (
    session_id, user_id, field_id, answer_value, answer_type, sensitivity_level, source
  ) values (
    p_session_id, v_user_id, p_field_id, p_answer_value,
    v_q ->> 'format', coalesce(v_q ->> 'sensitivity_level', 'standard'), 'user'
  )
  on conflict (session_id, field_id) do update set
    answer_value = excluded.answer_value,
    answer_type = excluded.answer_type,
    sensitivity_level = excluded.sensitivity_level,
    updated_at = now();

  -- транзитивная очистка: повторяем, пока есть что удалять
  loop
    v_pass := v_pass + 1;
    exit when v_pass > 20;   -- защита от циклических show_if

    with all_q as (
      select q.question
      from public.onboarding_definitions d
      cross join lateral jsonb_array_elements(d.schema -> 'sections') s(section)
      cross join lateral jsonb_array_elements(s.section -> 'questions') q(question)
      where d.id = v_definition_id and q.question ? 'show_if'
    ),
    to_delete as (
      select a.id
      from public.onboarding_answers a
      join all_q on all_q.question ->> 'field_id' = a.field_id
      where a.session_id = p_session_id
        and not public.is_question_visible(p_session_id, all_q.question)
    )
    delete from public.onboarding_answers x using to_delete d where x.id = d.id;

    get diagnostics v_removed = row_count;
    exit when v_removed = 0;
  end loop;

  update public.onboarding_sessions
  set last_answered_field_id = p_field_id, last_activity_at = now()
  where id = p_session_id;
end;
$$;

-- ============================================================
-- 5.3 complete_onboarding
-- ============================================================
create or replace function public.complete_onboarding(p_session_id uuid)
returns uuid
language plpgsql security definer set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_life_period text;
  v_onboarding_key text;
  v_missing text[];
  v_snapshot_id uuid;
  v_profile_data jsonb;
  v_version int;
begin
  select life_period, onboarding_key into v_life_period, v_onboarding_key
  from public.onboarding_sessions
  where id = p_session_id and user_id = v_user_id and status = 'in_progress';

  if v_life_period is null then
    raise exception 'session_not_found_or_already_completed';
  end if;

  if v_onboarding_key = 'lifecycle_router' then
    raise exception 'use_complete_lifecycle_router_for_router_sessions';
  end if;

  v_missing := public.validate_onboarding_session(p_session_id);
  if array_length(v_missing, 1) > 0 then
    raise exception 'required_answers_missing: %', array_to_string(v_missing, ',');
  end if;

  v_profile_data := public.build_profile_data(p_session_id);

  update public.onboarding_sessions
  set status = 'completed', completed_at = now() where id = p_session_id;

  update public.profile_snapshots set is_current = false
  where user_id = v_user_id and life_period = v_life_period and is_current = true;

  select coalesce(max(profile_version), 0) + 1 into v_version
  from public.profile_snapshots where user_id = v_user_id and life_period = v_life_period;

  insert into public.profile_snapshots (
    user_id, source_session_id, life_period, profile_version,
    profile_data, generated_by, is_current
  ) values (
    v_user_id, p_session_id, v_life_period, v_version,
    v_profile_data, 'rpc:complete_onboarding', true
  ) returning id into v_snapshot_id;

  -- обновляем записи детей, если анкета их описывает
  perform public.sync_user_children(p_session_id);

  update public.profiles
  set onboarding_status = 'completed', updated_at = now() where id = v_user_id;

  return v_snapshot_id;
end;
$$;

-- ============================================================
-- 5.4 confirm_period_transition
-- Идемпотентна: повторный вызов не плодит записи в истории.
-- ============================================================
create or replace function public.confirm_period_transition(
  p_onboarding_key text,
  p_locale text,
  p_life_substage text default null,
  p_source text default 'onboarding',
  p_routing_confidence text default null,
  p_additional_contexts jsonb default '[]'::jsonb,
  p_period_selected_manually boolean default false,
  p_prefill_from_session_id uuid default null
)
returns uuid
language plpgsql security definer set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_life_period text;
  v_session_id uuid;
  v_active_period text;
  v_active_substage text;
begin
  if v_user_id is null then
    raise exception 'not_authenticated';
  end if;

  -- блокируем строку пользователя: два одновременных запроса
  -- не создадут две записи периода
  perform 1 from public.profiles where id = v_user_id for update;

  select life_period into v_life_period
  from public.onboarding_definitions
  where onboarding_key = p_onboarding_key and locale = p_locale and status = 'published'
  order by version desc limit 1;

  if v_life_period is null then
    raise exception 'no_published_definition for % / %', p_onboarding_key, p_locale;
  end if;
  if v_life_period = 'lifecycle_router' then
    raise exception 'router_is_not_a_life_period';
  end if;

  select life_period, life_substage into v_active_period, v_active_substage
  from public.user_lifecycle where user_id = v_user_id and status = 'active';

  -- идемпотентность: тот же период и тот же подэтап, сессия уже есть
  if v_active_period is not distinct from v_life_period
     and v_active_substage is not distinct from p_life_substage then
    select id into v_session_id from public.onboarding_sessions
    where user_id = v_user_id and onboarding_key = p_onboarding_key and status = 'in_progress';
    if v_session_id is not null then
      return v_session_id;
    end if;
  end if;

  if v_active_period is distinct from v_life_period
     or v_active_substage is distinct from p_life_substage then
    update public.user_lifecycle set status = 'ended', ended_at = now()
    where user_id = v_user_id and status = 'active';

    insert into public.user_lifecycle (
      user_id, life_period, life_substage, source,
      routing_confidence, additional_contexts, period_selected_manually
    ) values (
      v_user_id, v_life_period, p_life_substage, p_source,
      p_routing_confidence, p_additional_contexts, p_period_selected_manually
    );
  end if;

  update public.profiles
  set current_life_period = v_life_period,
      current_life_substage = p_life_substage,
      onboarding_status = 'period_in_progress',
      updated_at = now()
  where id = v_user_id;

  v_session_id := public.start_onboarding(p_onboarding_key, p_locale, p_prefill_from_session_id);
  return v_session_id;
end;
$$;

-- ============================================================
-- 5.5 complete_lifecycle_router
-- Переносит стабильные данные в profiles по profile_column.
-- ============================================================
create or replace function public.complete_lifecycle_router(p_session_id uuid)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_onboarding_key text;
  v_definition_id uuid;
  v_missing text[];
  v_q jsonb;
  v_col text;
  v_val jsonb;
begin
  select onboarding_key, definition_id into v_onboarding_key, v_definition_id
  from public.onboarding_sessions
  where id = p_session_id and user_id = v_user_id and status = 'in_progress';

  if v_onboarding_key is null then
    raise exception 'session_not_found_or_already_completed';
  end if;
  if v_onboarding_key <> 'lifecycle_router' then
    raise exception 'not_a_router_session';
  end if;

  v_missing := public.validate_onboarding_session(p_session_id);
  if array_length(v_missing, 1) > 0 then
    raise exception 'required_answers_missing: %', array_to_string(v_missing, ',');
  end if;

  -- перенос стабильных полей в profiles
  for v_q in
    select q.question
    from public.onboarding_definitions d
    cross join lateral jsonb_array_elements(d.schema -> 'sections') s(section)
    cross join lateral jsonb_array_elements(s.section -> 'questions') q(question)
    where d.id = v_definition_id and q.question ? 'profile_column'
  loop
    v_col := v_q ->> 'profile_column';
    select answer_value into v_val from public.onboarding_answers
    where session_id = p_session_id and field_id = v_q ->> 'field_id';

    if v_val is not null and not (v_val ? 'reason') then
      if v_col = 'first_name' then
        update public.profiles set first_name = coalesce(v_val ->> 'text', v_val ->> 'value'),
               updated_at = now() where id = v_user_id;
      elsif v_col = 'date_of_birth' then
        update public.profiles set date_of_birth = (v_val ->> 'date')::date,
               updated_at = now() where id = v_user_id;
      elsif v_col = 'locale' then
        update public.profiles set locale = coalesce(v_val ->> 'value', locale),
               updated_at = now() where id = v_user_id;
      end if;
      -- колонки вне этого списка игнорируются намеренно:
      -- динамический UPDATE по имени колонки из схемы открыл бы
      -- возможность записать в current_life_period через анкету
    end if;
  end loop;

  update public.onboarding_sessions
  set status = 'completed', completed_at = now() where id = p_session_id;

  update public.profiles
  set onboarding_status = 'router_completed', updated_at = now() where id = v_user_id;
end;
$$;

-- ============================================================
-- 5.6 update_basic_profile
-- ============================================================
create or replace function public.update_basic_profile(
  p_first_name text default null,
  p_locale text default null,
  p_timezone text default null
)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
begin
  if v_user_id is null then
    raise exception 'not_authenticated';
  end if;

  update public.profiles
  set first_name = coalesce(p_first_name, first_name),
      locale = coalesce(p_locale, locale),
      timezone = coalesce(p_timezone, timezone),
      updated_at = now()
  where id = v_user_id;
end;
$$;

-- ============================================================
-- 5.7 publish_onboarding_definition
-- ============================================================
create or replace function public.publish_onboarding_definition(p_definition_id uuid)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  v_schema jsonb;
  v_q jsonb;
  v_ref_q jsonb;
  v_item jsonb;
  v_ids text[] := '{}';
  v_paths text[] := '{}';
  v_fid text;
  v_path text;
  v_fmt text;
  v_ref text;
  v_err text;
  v_count_sources int := 0;
  v_seen text[];
  v_row_ids text[];
  v_text text;
  v_num numeric;
begin
  select schema into v_schema
  from public.onboarding_definitions
  where id = p_definition_id;

  if v_schema is null then
    raise exception 'definition_not_found';
  end if;

  if jsonb_typeof(v_schema -> 'sections') is distinct from 'array' then
    raise exception 'schema_sections_must_be_array';
  end if;

  -- Первый проход: IDs, форматы и локальные свойства.
  for v_q in
    select q.question
    from jsonb_array_elements(v_schema -> 'sections') s(section)
    cross join lateral jsonb_array_elements(s.section -> 'questions') q(question)
  loop
    v_fid := v_q ->> 'field_id';
    v_fmt := v_q ->> 'format';

    if v_fid is null or btrim(v_fid) = '' then
      raise exception 'question_without_field_id';
    end if;
    if v_fid = any(v_ids) then
      raise exception 'duplicate_field_id: %', v_fid;
    end if;
    v_ids := array_append(v_ids, v_fid);

    if v_fmt is null or v_fmt not in (
      'single_choice','multi_choice','per_child_single_choice',
      'per_child_short_text','paired_choice','number',
      'date','date_confirm','short_text'
    ) then
      raise exception 'unsupported_format_in_schema: % (%)', coalesce(v_fmt,'null'), v_fid;
    end if;

    if v_fmt in ('single_choice','multi_choice','per_child_single_choice') then
      if jsonb_typeof(v_q -> 'options') is distinct from 'array'
         or jsonb_array_length(v_q -> 'options') = 0 then
        raise exception 'choice_question_without_options: %', v_fid;
      end if;
      v_seen := '{}';
      for v_item in select value from jsonb_array_elements(v_q -> 'options') loop
        if jsonb_typeof(v_item) is distinct from 'string' then
          raise exception 'choice_option_must_be_string: %', v_fid;
        end if;
        v_text := v_item #>> '{}';
        if btrim(v_text) = '' then
          raise exception 'choice_option_cannot_be_empty: %', v_fid;
        end if;
        if v_text = any(v_seen) then
          raise exception 'duplicate_choice_option: % / %', v_fid, v_text;
        end if;
        v_seen := array_append(v_seen, v_text);
      end loop;
    end if;

    if v_fmt = 'paired_choice' then
      if jsonb_typeof(v_q -> 'rows') is distinct from 'array'
         or jsonb_array_length(v_q -> 'rows') = 0 then
        raise exception 'paired_choice_without_rows: %', v_fid;
      end if;
      v_row_ids := '{}';
      for v_item in select value from jsonb_array_elements(v_q -> 'rows') loop
        v_text := v_item ->> 'row_id';
        if coalesce(btrim(v_text),'') = ''
           or jsonb_typeof(v_item -> 'options') is distinct from 'array'
           or jsonb_array_length(v_item -> 'options') = 0 then
          raise exception 'invalid_paired_choice_row: %', v_fid;
        end if;
        if v_text = any(v_row_ids) then
          raise exception 'duplicate_paired_choice_row: % / %', v_fid, v_text;
        end if;
        v_row_ids := array_append(v_row_ids, v_text);

        v_seen := '{}';
        for v_ref_q in select value from jsonb_array_elements(v_item -> 'options') loop
          if jsonb_typeof(v_ref_q) is distinct from 'string' then
            raise exception 'paired_choice_option_must_be_string: % / %', v_fid, v_text;
          end if;
          v_ref := v_ref_q #>> '{}';
          if btrim(v_ref) = '' or v_ref = any(v_seen) then
            raise exception 'invalid_or_duplicate_paired_choice_option: % / %', v_fid, v_text;
          end if;
          v_seen := array_append(v_seen, v_ref);
        end loop;
      end loop;
    end if;

    if v_fmt in ('per_child_single_choice','per_child_short_text') then
      if not (v_q ? 'repeat_count_from') then
        raise exception 'per_child_without_repeat_count_from: %', v_fid;
      end if;
      if jsonb_typeof(v_q -> 'repeat_count_map') is distinct from 'object' then
        raise exception 'per_child_without_repeat_count_map: %', v_fid;
      end if;
      for v_item in select value from jsonb_each(v_q -> 'repeat_count_map') loop
        if jsonb_typeof(v_item) is distinct from 'number' then
          raise exception 'invalid_repeat_count_map: %', v_fid;
        end if;
        v_num := (v_item #>> '{}')::numeric;
        if v_num < 1 or trunc(v_num) <> v_num then
          raise exception 'invalid_repeat_count_map: %', v_fid;
        end if;
      end loop;
      if coalesce(v_q ->> 'repeat_scope','all') not in ('all','living') then
        raise exception 'invalid_repeat_scope: %', v_fid;
      end if;
      if (v_q ->> 'repeat_scope') = 'living' and not (v_q ? 'living_status_from') then
        raise exception 'living_repeat_without_status_source: %', v_fid;
      end if;
    end if;

    if v_fmt in ('date','date_confirm') then
      if coalesce(v_q ->> 'date_constraint','any') not in ('any','past_or_today','future_or_today') then
        raise exception 'invalid_date_constraint: %', v_fid;
      end if;
      if v_q ? 'max_future_days' then
        if jsonb_typeof(v_q -> 'max_future_days') is distinct from 'number'
           or (v_q ->> 'max_future_days')::numeric < 0
           or trunc((v_q ->> 'max_future_days')::numeric) <> (v_q ->> 'max_future_days')::numeric then
          raise exception 'invalid_max_future_days: %', v_fid;
        end if;
      end if;
      if v_q ? 'max_past_days' then
        if jsonb_typeof(v_q -> 'max_past_days') is distinct from 'number'
           or (v_q ->> 'max_past_days')::numeric < 0
           or trunc((v_q ->> 'max_past_days')::numeric) <> (v_q ->> 'max_past_days')::numeric then
          raise exception 'invalid_max_past_days: %', v_fid;
        end if;
      end if;
    end if;

    if v_fmt = 'number' then
      if v_q ? 'integer' and jsonb_typeof(v_q -> 'integer') is distinct from 'boolean' then
        raise exception 'integer_flag_must_be_boolean: %', v_fid;
      end if;
      if v_q ? 'min' and jsonb_typeof(v_q -> 'min') is distinct from 'number' then
        raise exception 'number_min_must_be_numeric: %', v_fid;
      end if;
      if v_q ? 'max' and jsonb_typeof(v_q -> 'max') is distinct from 'number' then
        raise exception 'number_max_must_be_numeric: %', v_fid;
      end if;
      if v_q ? 'min' and v_q ? 'max'
         and (v_q ->> 'min')::numeric > (v_q ->> 'max')::numeric then
        raise exception 'number_range_is_reversed: %', v_fid;
      end if;
    end if;

    if v_q ? 'max_length' then
      if jsonb_typeof(v_q -> 'max_length') is distinct from 'number'
         or (v_q ->> 'max_length')::numeric < 1
         or trunc((v_q ->> 'max_length')::numeric) <> (v_q ->> 'max_length')::numeric then
        raise exception 'invalid_max_length: %', v_fid;
      end if;
    end if;

    if v_q ? 'max_select' then
      if v_fmt <> 'multi_choice'
         or jsonb_typeof(v_q -> 'max_select') is distinct from 'number'
         or (v_q ->> 'max_select')::numeric < 1
         or trunc((v_q ->> 'max_select')::numeric) <> (v_q ->> 'max_select')::numeric then
        raise exception 'invalid_max_select: %', v_fid;
      end if;
    end if;

    if v_q ? 'profile_column'
       and (v_q ->> 'profile_column') not in ('first_name','date_of_birth','locale') then
      raise exception 'unsupported_profile_column: % (%)', v_q ->> 'profile_column', v_fid;
    end if;

    v_path := v_q ->> 'profile_path';
    if v_path is not null then
      if v_path = any(v_paths) then
        raise exception 'duplicate_profile_path: % (%)', v_path, v_fid;
      end if;
      v_paths := array_append(v_paths, v_path);
    end if;

    if coalesce((v_q ->> 'is_child_count')::boolean, false) then
      v_count_sources := v_count_sources + 1;
      if not (v_q ? 'birth_event_date_from') then
        raise exception 'child_count_without_birth_event_date_from: %', v_fid;
      end if;
      if not (v_q ? 'shared_child_status_from')
         or jsonb_typeof(v_q -> 'shared_status_map') is distinct from 'object' then
        raise exception 'child_count_without_shared_status_mapping: %', v_fid;
      end if;
    end if;
  end loop;

  if v_count_sources > 1 then
    raise exception 'more_than_one_child_count_source';
  end if;

  -- Второй проход: все межвопросные ссылки и show_if.
  for v_q in
    select q.question
    from jsonb_array_elements(v_schema -> 'sections') s(section)
    cross join lateral jsonb_array_elements(s.section -> 'questions') q(question)
  loop
    v_fid := v_q ->> 'field_id';

    if v_q ? 'show_if' then
      v_err := public.validate_show_if_condition(v_q -> 'show_if', v_ids);
      if v_err is not null then
        raise exception 'invalid_show_if for %: %', v_fid, v_err;
      end if;
    end if;

    foreach v_ref in array array[
      v_q ->> 'repeat_count_from',
      v_q ->> 'repeat_count_exact_from',
      v_q ->> 'living_status_from',
      v_q ->> 'birth_event_date_from',
      v_q ->> 'child_status_from',
      v_q ->> 'shared_child_status_from',
      v_q ->> 'child_names_from'
    ] loop
      if v_ref is not null and not (v_ref = any(v_ids)) then
        raise exception 'referenced_field_not_found: % -> %', v_fid, v_ref;
      end if;
    end loop;

    if v_q ? 'repeat_count_from' then
      select q2.question into v_ref_q
      from jsonb_array_elements(v_schema -> 'sections') s2(section)
      cross join lateral jsonb_array_elements(s2.section -> 'questions') q2(question)
      where q2.question ->> 'field_id' = v_q ->> 'repeat_count_from'
      limit 1;
      if v_ref_q ->> 'format' <> 'single_choice' then
        raise exception 'repeat_count_source_must_be_single_choice: %', v_fid;
      end if;
    end if;

    if v_q ? 'repeat_count_exact_from' then
      select q2.question into v_ref_q
      from jsonb_array_elements(v_schema -> 'sections') s2(section)
      cross join lateral jsonb_array_elements(s2.section -> 'questions') q2(question)
      where q2.question ->> 'field_id' = v_q ->> 'repeat_count_exact_from'
      limit 1;
      if v_ref_q ->> 'format' <> 'number' then
        raise exception 'repeat_count_exact_source_must_be_number: %', v_fid;
      end if;
    end if;

    if v_q ? 'living_status_from' then
      select q2.question into v_ref_q
      from jsonb_array_elements(v_schema -> 'sections') s2(section)
      cross join lateral jsonb_array_elements(s2.section -> 'questions') q2(question)
      where q2.question ->> 'field_id' = v_q ->> 'living_status_from'
      limit 1;
      if v_ref_q ->> 'format' <> 'per_child_single_choice' then
        raise exception 'living_status_source_must_be_per_child_single_choice: %', v_fid;
      end if;
    end if;

    if v_q ? 'birth_event_date_from' then
      select q2.question into v_ref_q
      from jsonb_array_elements(v_schema -> 'sections') s2(section)
      cross join lateral jsonb_array_elements(s2.section -> 'questions') q2(question)
      where q2.question ->> 'field_id' = v_q ->> 'birth_event_date_from'
      limit 1;
      if v_ref_q ->> 'format' not in ('date','date_confirm') then
        raise exception 'birth_event_date_source_must_be_date: %', v_fid;
      end if;
    end if;

    if v_q ? 'child_status_from' then
      select q2.question into v_ref_q
      from jsonb_array_elements(v_schema -> 'sections') s2(section)
      cross join lateral jsonb_array_elements(s2.section -> 'questions') q2(question)
      where q2.question ->> 'field_id' = v_q ->> 'child_status_from'
      limit 1;
      if v_ref_q ->> 'format' <> 'per_child_single_choice' then
        raise exception 'child_status_source_must_be_per_child_single_choice: %', v_fid;
      end if;
    end if;

    if v_q ? 'shared_child_status_from' then
      select q2.question into v_ref_q
      from jsonb_array_elements(v_schema -> 'sections') s2(section)
      cross join lateral jsonb_array_elements(s2.section -> 'questions') q2(question)
      where q2.question ->> 'field_id' = v_q ->> 'shared_child_status_from'
      limit 1;
      if v_ref_q ->> 'format' <> 'single_choice' then
        raise exception 'shared_child_status_source_must_be_single_choice: %', v_fid;
      end if;
    end if;

    if v_q ? 'child_names_from' then
      select q2.question into v_ref_q
      from jsonb_array_elements(v_schema -> 'sections') s2(section)
      cross join lateral jsonb_array_elements(s2.section -> 'questions') q2(question)
      where q2.question ->> 'field_id' = v_q ->> 'child_names_from'
      limit 1;
      if v_ref_q ->> 'format' <> 'per_child_short_text' then
        raise exception 'child_names_source_must_be_per_child_short_text: %', v_fid;
      end if;
    end if;
  end loop;

  update public.onboarding_definitions
  set status = 'published', published_at = now()
  where id = p_definition_id;
end;
$$;

-- ============================================================
-- 5.8 mark_abandoned_sessions — служебная, только cron
-- ============================================================
create or replace function public.mark_abandoned_sessions()
returns void
language sql security definer set search_path = public
as $$
  update public.onboarding_sessions
  set status = 'abandoned'
  where status = 'in_progress' and last_activity_at < now() - interval '14 days';
$$;

-- ============================================================
-- 5.9 handle_new_user
-- ============================================================
create or replace function public.handle_new_user()
returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  insert into public.profiles (id) values (new.id) on conflict (id) do nothing;
  return new;
end;
$$;

create trigger on_auth_user_created
after insert on auth.users
for each row execute function public.handle_new_user();

-- пользовательские RPC
revoke all on function public.start_onboarding(text, text, uuid) from public, anon;
grant execute on function public.start_onboarding(text, text, uuid) to authenticated;

revoke all on function public.save_onboarding_answer(uuid, text, jsonb) from public, anon;
grant execute on function public.save_onboarding_answer(uuid, text, jsonb) to authenticated;

revoke all on function public.confirm_period_transition(text, text, text, text, text, jsonb, boolean, uuid) from public, anon;
grant execute on function public.confirm_period_transition(text, text, text, text, text, jsonb, boolean, uuid) to authenticated;

revoke all on function public.complete_onboarding(uuid) from public, anon;
grant execute on function public.complete_onboarding(uuid) to authenticated;

revoke all on function public.complete_lifecycle_router(uuid) from public, anon;
grant execute on function public.complete_lifecycle_router(uuid) to authenticated;

revoke all on function public.update_basic_profile(text, text, text) from public, anon;
grant execute on function public.update_basic_profile(text, text, text) to authenticated;

-- внутренние функции
revoke all on function public.get_question_def(uuid, text) from public, anon, authenticated;
revoke all on function public.resolve_child_indices(uuid, jsonb) from public, anon, authenticated;
revoke all on function public.evaluate_condition(uuid, jsonb) from public, anon, authenticated;
revoke all on function public.is_question_visible(uuid, jsonb) from public, anon, authenticated;
revoke all on function public.validate_answer_value(uuid, jsonb, jsonb) from public, anon, authenticated;
revoke all on function public.unwrap_answer(jsonb) from public, anon, authenticated;
revoke all on function public.validate_onboarding_session(uuid) from public, anon, authenticated;
revoke all on function public.jsonb_set_deep(jsonb, text[], jsonb) from public, anon, authenticated;
revoke all on function public.build_profile_data(uuid) from public, anon, authenticated;
revoke all on function public.sync_user_children(uuid) from public, anon, authenticated;
revoke all on function public.validate_show_if_condition(jsonb, text[]) from public, anon, authenticated;

-- служебные
revoke all on function public.mark_abandoned_sessions() from public, anon, authenticated;
revoke all on function public.publish_onboarding_definition(uuid) from public, anon, authenticated;

alter table public.profiles enable row level security;
alter table public.birth_events enable row level security;
alter table public.user_lifecycle enable row level security;
alter table public.onboarding_sessions enable row level security;
alter table public.onboarding_answers enable row level security;
alter table public.profile_snapshots enable row level security;
alter table public.onboarding_definitions enable row level security;
alter table public.user_children enable row level security;

create policy "profiles_select_own" on public.profiles for select to authenticated
using ((select auth.uid()) = id);

create policy "birth_events_select_own" on public.birth_events for select to authenticated
using ((select auth.uid()) = user_id);

create policy "lifecycle_select_own" on public.user_lifecycle for select to authenticated
using ((select auth.uid()) = user_id);

create policy "sessions_select_own" on public.onboarding_sessions for select to authenticated
using ((select auth.uid()) = user_id);

create policy "answers_select_own" on public.onboarding_answers for select to authenticated
using ((select auth.uid()) = user_id);

create policy "snapshots_select_own" on public.profile_snapshots for select to authenticated
using ((select auth.uid()) = user_id);

create policy "children_select_own" on public.user_children for select to authenticated
using ((select auth.uid()) = user_id);

create policy "definitions_select_published" on public.onboarding_definitions for select to authenticated
using (status = 'published');

revoke insert, update, delete on public.profiles from anon, authenticated;
revoke insert, update, delete on public.birth_events from anon, authenticated;
revoke insert, update, delete on public.user_lifecycle from anon, authenticated;
revoke insert, update, delete on public.onboarding_sessions from anon, authenticated;
revoke insert, update, delete on public.onboarding_answers from anon, authenticated;
revoke insert, update, delete on public.profile_snapshots from anon, authenticated;
revoke insert, update, delete on public.onboarding_definitions from anon, authenticated;
revoke insert, update, delete on public.user_children from anon, authenticated;
