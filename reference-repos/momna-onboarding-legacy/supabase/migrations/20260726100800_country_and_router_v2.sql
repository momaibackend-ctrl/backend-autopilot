-- ============================================================
-- 0800. Страна пользовательницы + версия 2 схемы Lifecycle Router.
--
-- Причина. В макетах Figma («общий онбординг») есть экран выбора
-- страны с поиском — он обсуждался и дорабатывался дизайнерами.
-- В документе для дизайнера этого экрана нет, поэтому в схему v1
-- он не попал, а в profiles не было колонки для его ответа.
--
-- Страна нужна не для галочки: из неё выводятся единицы измерения
-- (в требованиях по беременности ограничение записано как
-- «over 10 lbs / 5 kg»), формат даты и региональные особенности
-- контента. Хранится код по ISO 3166-1 alpha-2.
--
-- Схема публикуется как версия 2, версия 1 переводится в archived.
-- start_onboarding всегда берёт последнюю опубликованную версию,
-- поэтому новые сессии пойдут по v2, а уже начатые останутся на той
-- версии, по которой стартовали.
-- ============================================================

alter table public.profiles
  add column if not exists country text
    check (country is null or country ~ '^[A-Z]{2}$');

comment on column public.profiles.country is
  'ISO 3166-1 alpha-2. Источник единиц измерения и регионального контента.';


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

    -- нижние границы диапазона (добавлено миграцией 0004).
    -- Нужны для дат, у которых недопустима не только «слишком далёкая»,
    -- но и «слишком близкая» точка:
    --   LMP  — не позже чем 2 недели назад  -> min_past_days: 14
    --   ПДР  — не раньше чем через 1 неделю  -> min_future_days: 7
    if p_question ? 'min_past_days'
       and v_date > current_date - (p_question ->> 'min_past_days')::int then
      return 'date_too_recent';
    end if;
    if p_question ? 'min_future_days'
       and v_date < current_date + (p_question ->> 'min_future_days')::int then
      return 'date_too_soon';
    end if;

    if v_format = 'date_confirm' then
      if jsonb_typeof(p_answer_value -> 'confirmed') is distinct from 'boolean' then
        return 'date_confirm_requires_confirmed_boolean';
      end if;
      if (p_answer_value ->> 'confirmed')::boolean is not true then
        return 'date_must_be_confirmed';
      end if;
    end if;

  elsif v_format = 'country_code' then
    -- Код страны по ISO 3166-1 alpha-2: ровно две заглавные латинские буквы.
    -- Из него выводятся единицы измерения (US -> фунты, остальные -> килограммы),
    -- формат даты и региональные особенности контента.
    if jsonb_typeof(p_answer_value -> 'value') is distinct from 'string' then
      return 'country_code_requires_string';
    end if;
    if (p_answer_value ->> 'value') !~ '^[A-Z]{2}$' then
      return 'invalid_country_code: ' || (p_answer_value ->> 'value');
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
      'date','date_confirm','short_text','country_code'
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
      if v_q ? 'min_past_days' then
        if jsonb_typeof(v_q -> 'min_past_days') is distinct from 'number'
           or (v_q ->> 'min_past_days')::numeric < 0
           or trunc((v_q ->> 'min_past_days')::numeric) <> (v_q ->> 'min_past_days')::numeric then
          raise exception 'invalid_min_past_days: %', v_fid;
        end if;
      end if;

      if v_q ? 'min_future_days' then
        if jsonb_typeof(v_q -> 'min_future_days') is distinct from 'number'
           or (v_q ->> 'min_future_days')::numeric < 0
           or trunc((v_q ->> 'min_future_days')::numeric) <> (v_q ->> 'min_future_days')::numeric then
          raise exception 'invalid_min_future_days: %', v_fid;
        end if;
      end if;

      -- диапазон не должен быть пустым: минимум не может быть больше максимума
      if (v_q ? 'min_past_days') and (v_q ? 'max_past_days')
         and (v_q ->> 'min_past_days')::int > (v_q ->> 'max_past_days')::int then
        raise exception 'empty_past_date_range: %', v_fid;
      end if;
      if (v_q ? 'min_future_days') and (v_q ? 'max_future_days')
         and (v_q ->> 'min_future_days')::int > (v_q ->> 'max_future_days')::int then
        raise exception 'empty_future_date_range: %', v_fid;
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
       and (v_q ->> 'profile_column') not in ('first_name','date_of_birth','locale','country') then
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
      elsif v_col = 'country' then
        update public.profiles set country = upper(v_val ->> 'value'),
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



-- ------------------------------------------------------------
-- Версия 2 схемы роутера
-- ------------------------------------------------------------
update public.onboarding_definitions
set status = 'archived'
where onboarding_key = 'lifecycle_router' and version = 1;


insert into public.onboarding_definitions
  (onboarding_key, life_period, version, locale, schema, status)
values
  ('lifecycle_router', 'lifecycle_router', 2, 'ru', '{"sections": [{"id": "router", "questions": [{"field_id": "display_name", "format": "short_text", "required": false, "skippable": true, "max_length": 60, "profile_column": "first_name", "label": "Как к тебе обращаться?", "hint": "Имя может быть настоящим, сокращённым или любым удобным обращением."}, {"field_id": "country", "format": "country_code", "required": false, "skippable": true, "profile_column": "country", "label": "Где ты живёшь?", "hint": "Это нужно, чтобы показывать привычные единицы измерения и подходящий региональный контент."}, {"field_id": "birth_date", "format": "date", "required": false, "skippable": true, "date_constraint": "past_or_today", "min_past_days": 2920, "max_past_days": 27375, "profile_column": "date_of_birth", "label": "Когда ты родилась?", "hint": "Это помогает показывать подходящий и безопасный контент. Сам по себе возраст не определяет твой период."}, {"field_id": "menarche_status", "format": "single_choice", "required": true, "skippable": true, "options": ["not_started", "very_recent", "within_two_years", "more_than_two_years", "unsure", "prefer_not_to_say"], "label": "Начались ли у тебя когда-нибудь месячные?", "option_labels": {"not_started": "Нет, ещё не начались", "very_recent": "Да, первые были совсем недавно", "within_two_years": "Да, первые начались в последние два года", "more_than_two_years": "Да, первые начались больше двух лет назад", "unsure": "Кажется, были, но я не уверена", "prefer_not_to_say": "Не хочу отвечать"}}, {"field_id": "current_situation", "format": "single_choice", "required": true, "skippable": true, "options": ["pregnant", "possible_pregnancy", "recent_birth", "planning", "cycle_tracking", "cycle_changing", "no_periods_12m", "unsure", "prefer_not_to_say"], "show_if": {"field_id": "menarche_status", "in": ["more_than_two_years", "prefer_not_to_say"]}, "label": "Что сейчас лучше всего описывает твою ситуацию?", "hint": "Выбери то, что происходит с тобой сейчас, а не тему, о которой тебе просто интересно читать.", "option_labels": {"pregnant": "Я беременна", "possible_pregnancy": "Беременность возможна, но пока не подтверждена", "recent_birth": "Я недавно родила или всё ещё восстанавливаюсь после родов", "planning": "Я готовлюсь или пытаюсь забеременеть", "cycle_tracking": "Я слежу за циклом и своим самочувствием", "cycle_changing": "Месячные стали заметно меняться или пропускаться", "no_periods_12m": "Месячных нет уже двенадцать месяцев или дольше", "unsure": "Я не уверена, какой вариант выбрать", "prefer_not_to_say": "Не хочу отвечать"}}, {"field_id": "pregnancy_status", "format": "single_choice", "required": false, "skippable": true, "options": ["confirmed_by_doctor", "test_positive", "only_possible", "not_pregnant", "prefer_not_to_say"], "show_if": {"field_id": "current_situation", "in": ["pregnant", "possible_pregnancy"]}, "label": "Что сейчас известно о беременности?", "option_labels": {"confirmed_by_doctor": "Беременность подтверждена врачом", "test_positive": "Тест положительный, но у врача ещё не была", "only_possible": "Беременность только возможна", "not_pregnant": "Я ошиблась, беременности нет", "prefer_not_to_say": "Не хочу отвечать"}}, {"field_id": "postpartum_time_range", "format": "single_choice", "required": false, "skippable": true, "options": ["lt_1m", "m1_3", "m4_6", "m7_9", "m10_12", "more_than_year", "prefer_not_to_say"], "show_if": {"field_id": "current_situation", "in": ["recent_birth"]}, "label": "Сколько времени прошло с рождения ребёнка?", "hint": "Это помогает понять, на каком этапе восстановление и что сейчас происходит с малышом.", "option_labels": {"lt_1m": "Меньше месяца назад", "m1_3": "1–3 месяца назад", "m4_6": "4–6 месяцев назад", "m7_9": "7–9 месяцев назад", "m10_12": "10–12 месяцев назад", "more_than_year": "Прошло больше года", "prefer_not_to_say": "Не хочу отвечать"}}, {"field_id": "postpartum_main_need", "format": "single_choice", "required": false, "skippable": true, "options": ["recovery", "cycle", "planning", "prefer_not_to_say"], "show_if": {"field_id": "postpartum_time_range", "in": ["more_than_year"]}, "label": "Что для тебя сейчас важнее всего?", "option_labels": {"recovery": "Восстановление после родов", "cycle": "Цикл и повседневная жизнь", "planning": "Планирование следующей беременности", "prefer_not_to_say": "Не хочу отвечать"}}, {"field_id": "planning_pregnancy_status", "format": "single_choice", "required": false, "skippable": true, "options": ["no", "confirmed", "maybe", "prefer_not_to_say"], "show_if": {"field_id": "current_situation", "in": ["planning"]}, "label": "Беременность уже подтверждена или возможна?", "option_labels": {"no": "Нет", "confirmed": "Да, подтверждена", "maybe": "Возможно, но пока не уверена", "prefer_not_to_say": "Не хочу отвечать"}}, {"field_id": "cycle_change_known_cause", "format": "single_choice", "required": false, "skippable": true, "options": ["pregnancy", "recent_birth_or_breastfeeding", "hormonal", "surgery_or_treatment", "stress_weight_illness", "doctor_said_perimenopause", "no_known_cause", "do_not_know", "prefer_not_to_say"], "show_if": {"field_id": "current_situation", "in": ["cycle_changing"]}, "label": "Есть ли известная причина этих изменений?", "option_labels": {"pregnancy": "Беременность", "recent_birth_or_breastfeeding": "Недавние роды или грудное вскармливание", "hormonal": "Гормональная контрацепция или гормональные препараты", "surgery_or_treatment": "Операция или медицинское лечение", "stress_weight_illness": "Сильный стресс, изменение веса или болезнь", "doctor_said_perimenopause": "Врач говорил о перименопаузе", "no_known_cause": "Известной причины нет", "do_not_know": "Не знаю", "prefer_not_to_say": "Не хочу отвечать"}}, {"field_id": "amenorrhea_known_cause", "format": "single_choice", "required": false, "skippable": true, "options": ["pregnancy", "recent_birth_or_breastfeeding", "hormonal", "surgery_or_treatment", "doctor_confirmed_menopause", "no_known_cause", "do_not_know", "prefer_not_to_say"], "show_if": {"field_id": "current_situation", "in": ["no_periods_12m"]}, "label": "Есть ли известная причина отсутствия месячных?", "option_labels": {"pregnancy": "Беременность", "recent_birth_or_breastfeeding": "Недавние роды или грудное вскармливание", "hormonal": "Гормональная контрацепция или препараты", "surgery_or_treatment": "Операция или медицинское лечение", "doctor_confirmed_menopause": "Врач подтвердил менопаузу", "no_known_cause": "Известной причины нет", "do_not_know": "Не знаю", "prefer_not_to_say": "Не хочу отвечать"}}, {"field_id": "unsure_pregnancy", "format": "single_choice", "required": false, "skippable": true, "options": ["confirmed", "possible", "no"], "show_if": {"field_id": "current_situation", "in": ["unsure"]}, "label": "Беременность сейчас подтверждена или возможна?", "option_labels": {"confirmed": "Подтверждена", "possible": "Возможна", "no": "Нет"}}, {"field_id": "unsure_recent_birth", "format": "single_choice", "required": false, "skippable": true, "options": ["yes", "no"], "show_if": {"field_id": "unsure_pregnancy", "in": ["no"]}, "label": "Роды были в течение последнего года или восстановление ещё продолжается?", "option_labels": {"yes": "Да", "no": "Нет", "not_sure": "Не уверена"}}, {"field_id": "unsure_planning", "format": "single_choice", "required": false, "skippable": true, "options": ["yes", "no"], "show_if": {"field_id": "unsure_recent_birth", "in": ["no"]}, "label": "Ты готовишься или пытаешься забеременеть?", "option_labels": {"yes": "Да", "no": "Нет", "not_sure": "Не уверена"}}, {"field_id": "unsure_cycle_changing", "format": "single_choice", "required": false, "skippable": true, "options": ["yes", "no"], "show_if": {"field_id": "unsure_planning", "in": ["no"]}, "label": "Месячные стали заметно меняться?", "option_labels": {"yes": "Да", "no": "Нет", "not_sure": "Не уверена"}}, {"field_id": "unsure_no_periods", "format": "single_choice", "required": false, "skippable": true, "options": ["yes", "no"], "show_if": {"field_id": "unsure_cycle_changing", "in": ["no"]}, "label": "Месячных нет двенадцать месяцев или дольше?", "option_labels": {"yes": "Да", "no": "Нет", "not_sure": "Не уверена"}}]}], "routing": [{"priority": 10, "when": {"field_id": "pregnancy_status", "in": ["confirmed_by_doctor"]}, "onboarding_key": "pregnancy", "confidence": "HIGH", "substage": "CONFIRMED"}, {"priority": 11, "when": {"field_id": "pregnancy_status", "in": ["test_positive"]}, "onboarding_key": "pregnancy", "confidence": "HIGH", "substage": "TEST_POSITIVE"}, {"priority": 12, "when": {"field_id": "planning_pregnancy_status", "in": ["confirmed"]}, "onboarding_key": "pregnancy", "confidence": "HIGH", "substage": "CONFIRMED"}, {"priority": 13, "when": {"field_id": "unsure_pregnancy", "in": ["confirmed"]}, "onboarding_key": "pregnancy", "confidence": "HIGH", "substage": "CONFIRMED"}, {"priority": 14, "when": {"field_id": "cycle_change_known_cause", "in": ["pregnancy"]}, "onboarding_key": "pregnancy", "confidence": "MEDIUM", "substage": "UNCONFIRMED"}, {"priority": 15, "when": {"field_id": "amenorrhea_known_cause", "in": ["pregnancy"]}, "onboarding_key": "pregnancy", "confidence": "MEDIUM", "substage": "UNCONFIRMED"}, {"priority": 20, "when": {"field_id": "postpartum_time_range", "in": ["lt_1m"]}, "onboarding_key": "postpartum", "confidence": "HIGH", "substage": "LT_1M"}, {"priority": 21, "when": {"field_id": "postpartum_time_range", "in": ["m1_3"]}, "onboarding_key": "postpartum", "confidence": "HIGH", "substage": "M1_3"}, {"priority": 22, "when": {"field_id": "postpartum_time_range", "in": ["m4_6"]}, "onboarding_key": "postpartum", "confidence": "HIGH", "substage": "M4_6"}, {"priority": 23, "when": {"field_id": "postpartum_time_range", "in": ["m7_9"]}, "onboarding_key": "postpartum", "confidence": "HIGH", "substage": "M7_9"}, {"priority": 24, "when": {"field_id": "postpartum_time_range", "in": ["m10_12"]}, "onboarding_key": "postpartum", "confidence": "HIGH", "substage": "M10_12"}, {"priority": 25, "when": {"field_id": "postpartum_main_need", "in": ["recovery"]}, "onboarding_key": "postpartum", "confidence": "MEDIUM", "substage": "EXTENDED_RECOVERY"}, {"priority": 26, "when": {"field_id": "unsure_recent_birth", "in": ["yes"]}, "onboarding_key": "postpartum", "confidence": "MEDIUM", "substage": "UNSPECIFIED"}, {"priority": 27, "when": {"field_id": "cycle_change_known_cause", "in": ["recent_birth_or_breastfeeding"]}, "onboarding_key": "postpartum", "confidence": "MEDIUM", "substage": "UNSPECIFIED"}, {"priority": 28, "when": {"field_id": "amenorrhea_known_cause", "in": ["recent_birth_or_breastfeeding"]}, "onboarding_key": "postpartum", "confidence": "MEDIUM", "substage": "UNSPECIFIED"}, {"priority": 30, "when": {"field_id": "menarche_status", "in": ["not_started"]}, "onboarding_key": "menarche", "confidence": "HIGH", "substage": "PRE_MENARCHE"}, {"priority": 31, "when": {"field_id": "menarche_status", "in": ["very_recent"]}, "onboarding_key": "menarche", "confidence": "HIGH", "substage": "EARLY_MENARCHE"}, {"priority": 32, "when": {"field_id": "menarche_status", "in": ["within_two_years"]}, "onboarding_key": "menarche", "confidence": "HIGH", "substage": "CYCLE_FORMATION"}, {"priority": 33, "when": {"field_id": "menarche_status", "in": ["unsure"]}, "onboarding_key": "menarche", "confidence": "MEDIUM", "substage": "UNCERTAIN_ONSET"}, {"priority": 40, "when": {"field_id": "planning_pregnancy_status", "in": ["no"]}, "onboarding_key": "planning", "confidence": "HIGH", "substage": "PREPARING"}, {"priority": 41, "when": {"field_id": "planning_pregnancy_status", "in": ["maybe"]}, "onboarding_key": "planning", "confidence": "MEDIUM", "substage": "PREPARING", "additional_contexts": ["POSSIBLE_PREGNANCY"]}, {"priority": 42, "when": {"field_id": "postpartum_main_need", "in": ["planning"]}, "onboarding_key": "planning", "confidence": "MEDIUM", "substage": "PREPARING"}, {"priority": 43, "when": {"field_id": "unsure_planning", "in": ["yes"]}, "onboarding_key": "planning", "confidence": "HIGH", "substage": "PREPARING"}, {"priority": 50, "when": {"field_id": "amenorrhea_known_cause", "in": ["doctor_confirmed_menopause"]}, "onboarding_key": "menopause", "confidence": "HIGH", "substage": "CONFIRMED"}, {"priority": 51, "when": {"field_id": "amenorrhea_known_cause", "in": ["no_known_cause"]}, "onboarding_key": "menopause", "confidence": "MEDIUM", "substage": "UNCONFIRMED"}, {"priority": 52, "when": {"field_id": "amenorrhea_known_cause", "in": ["do_not_know"]}, "onboarding_key": "menopause", "confidence": "LOW", "substage": "UNCONFIRMED"}, {"priority": 53, "when": {"field_id": "unsure_no_periods", "in": ["yes"]}, "onboarding_key": "menopause", "confidence": "MEDIUM", "substage": "UNCONFIRMED"}, {"priority": 60, "when": {"field_id": "cycle_change_known_cause", "in": ["doctor_said_perimenopause"]}, "onboarding_key": "perimenopause", "confidence": "HIGH", "substage": "CONFIRMED_CONTEXT"}, {"priority": 61, "when": {"field_id": "cycle_change_known_cause", "in": ["no_known_cause"]}, "onboarding_key": "perimenopause", "confidence": "MEDIUM", "substage": "POSSIBLE"}, {"priority": 62, "when": {"field_id": "cycle_change_known_cause", "in": ["do_not_know"]}, "onboarding_key": "perimenopause", "confidence": "LOW", "substage": "POSSIBLE"}, {"priority": 63, "when": {"field_id": "unsure_cycle_changing", "in": ["yes"]}, "onboarding_key": "perimenopause", "confidence": "MEDIUM", "substage": "POSSIBLE"}, {"priority": 70, "when": {"field_id": "pregnancy_status", "in": ["only_possible"]}, "onboarding_key": "cycle", "confidence": "MEDIUM", "substage": "STANDARD_CYCLE", "additional_contexts": ["POSSIBLE_PREGNANCY"]}, {"priority": 71, "when": {"field_id": "unsure_pregnancy", "in": ["possible"]}, "onboarding_key": "cycle", "confidence": "MEDIUM", "substage": "STANDARD_CYCLE", "additional_contexts": ["POSSIBLE_PREGNANCY"]}, {"priority": 72, "when": {"field_id": "cycle_change_known_cause", "in": ["hormonal", "surgery_or_treatment", "stress_weight_illness"]}, "onboarding_key": "cycle", "confidence": "MEDIUM", "substage": "OBSERVATION_CONTEXT"}, {"priority": 73, "when": {"field_id": "amenorrhea_known_cause", "in": ["hormonal", "surgery_or_treatment"]}, "onboarding_key": "cycle", "confidence": "MEDIUM", "substage": "OBSERVATION_CONTEXT"}, {"priority": 74, "when": {"field_id": "postpartum_main_need", "in": ["cycle"]}, "onboarding_key": "cycle", "confidence": "HIGH", "substage": "STANDARD_CYCLE"}, {"priority": 75, "when": {"field_id": "current_situation", "in": ["cycle_tracking"]}, "onboarding_key": "cycle", "confidence": "HIGH", "substage": "STANDARD_CYCLE"}], "routing_fallback": {"onboarding_key": "cycle", "substage": "STANDARD_CYCLE", "confidence": "LOW"}}'::jsonb, 'draft')
on conflict (onboarding_key, version, locale) do update
  set schema = excluded.schema, status = 'draft';


insert into public.onboarding_definitions
  (onboarding_key, life_period, version, locale, schema, status)
values
  ('lifecycle_router', 'lifecycle_router', 2, 'en-US', '{"sections": [{"id": "router", "questions": [{"field_id": "display_name", "format": "short_text", "required": false, "skippable": true, "max_length": 60, "profile_column": "first_name", "label": "What should we call you?", "hint": "It can be your real name, a short version, or anything you like."}, {"field_id": "country", "format": "country_code", "required": false, "skippable": true, "profile_column": "country", "label": "Where do you live?", "hint": "This lets us use the units you''re used to and show content that fits your region."}, {"field_id": "birth_date", "format": "date", "required": false, "skippable": true, "date_constraint": "past_or_today", "min_past_days": 2920, "max_past_days": 27375, "profile_column": "date_of_birth", "label": "When were you born?", "hint": "This helps us show content that fits and is safe for you. Age alone does not decide your life period."}, {"field_id": "menarche_status", "format": "single_choice", "required": true, "skippable": true, "options": ["not_started", "very_recent", "within_two_years", "more_than_two_years", "unsure", "prefer_not_to_say"], "label": "Have your periods ever started?", "option_labels": {"not_started": "No, not yet", "very_recent": "Yes, my first period was very recently", "within_two_years": "Yes, my first period was within the last two years", "more_than_two_years": "Yes, my first period was more than two years ago", "unsure": "I think so, but I''m not sure", "prefer_not_to_say": "Prefer not to answer"}}, {"field_id": "current_situation", "format": "single_choice", "required": true, "skippable": true, "options": ["pregnant", "possible_pregnancy", "recent_birth", "planning", "cycle_tracking", "cycle_changing", "no_periods_12m", "unsure", "prefer_not_to_say"], "show_if": {"field_id": "menarche_status", "in": ["more_than_two_years", "prefer_not_to_say"]}, "label": "What best describes your situation right now?", "hint": "Choose what is actually happening for you now, not a topic you''re curious about.", "option_labels": {"pregnant": "I''m pregnant", "possible_pregnancy": "I might be pregnant, but it''s not confirmed", "recent_birth": "I recently gave birth or I''m still recovering", "planning": "I''m preparing or trying to get pregnant", "cycle_tracking": "I''m tracking my cycle and how I feel", "cycle_changing": "My periods have changed noticeably or are being skipped", "no_periods_12m": "I haven''t had a period for twelve months or longer", "unsure": "I''m not sure which one to choose", "prefer_not_to_say": "Prefer not to answer"}}, {"field_id": "pregnancy_status", "format": "single_choice", "required": false, "skippable": true, "options": ["confirmed_by_doctor", "test_positive", "only_possible", "not_pregnant", "prefer_not_to_say"], "show_if": {"field_id": "current_situation", "in": ["pregnant", "possible_pregnancy"]}, "label": "What do you know about the pregnancy so far?", "option_labels": {"confirmed_by_doctor": "Confirmed by a doctor", "test_positive": "Positive test, but I haven''t seen a doctor yet", "only_possible": "It''s only a possibility", "not_pregnant": "I was wrong, I''m not pregnant", "prefer_not_to_say": "Prefer not to answer"}}, {"field_id": "postpartum_time_range", "format": "single_choice", "required": false, "skippable": true, "options": ["lt_1m", "m1_3", "m4_6", "m7_9", "m10_12", "more_than_year", "prefer_not_to_say"], "show_if": {"field_id": "current_situation", "in": ["recent_birth"]}, "label": "How long has it been since your baby was born?", "hint": "This helps us understand where your recovery is and what stage your baby is at.", "option_labels": {"lt_1m": "Less than a month ago", "m1_3": "1–3 months ago", "m4_6": "4–6 months ago", "m7_9": "7–9 months ago", "m10_12": "10–12 months ago", "more_than_year": "More than a year ago", "prefer_not_to_say": "Prefer not to answer"}}, {"field_id": "postpartum_main_need", "format": "single_choice", "required": false, "skippable": true, "options": ["recovery", "cycle", "planning", "prefer_not_to_say"], "show_if": {"field_id": "postpartum_time_range", "in": ["more_than_year"]}, "label": "What matters most to you right now?", "option_labels": {"recovery": "Recovery after birth", "cycle": "My cycle and everyday life", "planning": "Planning another pregnancy", "prefer_not_to_say": "Prefer not to answer"}}, {"field_id": "planning_pregnancy_status", "format": "single_choice", "required": false, "skippable": true, "options": ["no", "confirmed", "maybe", "prefer_not_to_say"], "show_if": {"field_id": "current_situation", "in": ["planning"]}, "label": "Is a pregnancy already confirmed or possible?", "option_labels": {"no": "No", "confirmed": "Yes, confirmed", "maybe": "Maybe, but I''m not sure yet", "prefer_not_to_say": "Prefer not to answer"}}, {"field_id": "cycle_change_known_cause", "format": "single_choice", "required": false, "skippable": true, "options": ["pregnancy", "recent_birth_or_breastfeeding", "hormonal", "surgery_or_treatment", "stress_weight_illness", "doctor_said_perimenopause", "no_known_cause", "do_not_know", "prefer_not_to_say"], "show_if": {"field_id": "current_situation", "in": ["cycle_changing"]}, "label": "Is there a known reason for these changes?", "option_labels": {"pregnancy": "Pregnancy", "recent_birth_or_breastfeeding": "Recent birth or breastfeeding", "hormonal": "Hormonal birth control or hormone medication", "surgery_or_treatment": "Surgery or medical treatment", "stress_weight_illness": "Significant stress, weight change, or illness", "doctor_said_perimenopause": "A doctor mentioned perimenopause", "no_known_cause": "No known reason", "do_not_know": "I don''t know", "prefer_not_to_say": "Prefer not to answer"}}, {"field_id": "amenorrhea_known_cause", "format": "single_choice", "required": false, "skippable": true, "options": ["pregnancy", "recent_birth_or_breastfeeding", "hormonal", "surgery_or_treatment", "doctor_confirmed_menopause", "no_known_cause", "do_not_know", "prefer_not_to_say"], "show_if": {"field_id": "current_situation", "in": ["no_periods_12m"]}, "label": "Is there a known reason your periods stopped?", "option_labels": {"pregnancy": "Pregnancy", "recent_birth_or_breastfeeding": "Recent birth or breastfeeding", "hormonal": "Hormonal birth control or medication", "surgery_or_treatment": "Surgery or medical treatment", "doctor_confirmed_menopause": "A doctor confirmed menopause", "no_known_cause": "No known reason", "do_not_know": "I don''t know", "prefer_not_to_say": "Prefer not to answer"}}, {"field_id": "unsure_pregnancy", "format": "single_choice", "required": false, "skippable": true, "options": ["confirmed", "possible", "no"], "show_if": {"field_id": "current_situation", "in": ["unsure"]}, "label": "Is a pregnancy confirmed or possible right now?", "option_labels": {"confirmed": "Confirmed", "possible": "Possible", "no": "No"}}, {"field_id": "unsure_recent_birth", "format": "single_choice", "required": false, "skippable": true, "options": ["yes", "no"], "show_if": {"field_id": "unsure_pregnancy", "in": ["no"]}, "label": "Did you give birth within the last year, or is your recovery still ongoing?", "option_labels": {"yes": "Yes", "no": "No", "not_sure": "Not sure"}}, {"field_id": "unsure_planning", "format": "single_choice", "required": false, "skippable": true, "options": ["yes", "no"], "show_if": {"field_id": "unsure_recent_birth", "in": ["no"]}, "label": "Are you preparing or trying to get pregnant?", "option_labels": {"yes": "Yes", "no": "No", "not_sure": "Not sure"}}, {"field_id": "unsure_cycle_changing", "format": "single_choice", "required": false, "skippable": true, "options": ["yes", "no"], "show_if": {"field_id": "unsure_planning", "in": ["no"]}, "label": "Have your periods changed noticeably?", "option_labels": {"yes": "Yes", "no": "No", "not_sure": "Not sure"}}, {"field_id": "unsure_no_periods", "format": "single_choice", "required": false, "skippable": true, "options": ["yes", "no"], "show_if": {"field_id": "unsure_cycle_changing", "in": ["no"]}, "label": "Have you gone twelve months or longer without a period?", "option_labels": {"yes": "Yes", "no": "No", "not_sure": "Not sure"}}]}], "routing": [{"priority": 10, "when": {"field_id": "pregnancy_status", "in": ["confirmed_by_doctor"]}, "onboarding_key": "pregnancy", "confidence": "HIGH", "substage": "CONFIRMED"}, {"priority": 11, "when": {"field_id": "pregnancy_status", "in": ["test_positive"]}, "onboarding_key": "pregnancy", "confidence": "HIGH", "substage": "TEST_POSITIVE"}, {"priority": 12, "when": {"field_id": "planning_pregnancy_status", "in": ["confirmed"]}, "onboarding_key": "pregnancy", "confidence": "HIGH", "substage": "CONFIRMED"}, {"priority": 13, "when": {"field_id": "unsure_pregnancy", "in": ["confirmed"]}, "onboarding_key": "pregnancy", "confidence": "HIGH", "substage": "CONFIRMED"}, {"priority": 14, "when": {"field_id": "cycle_change_known_cause", "in": ["pregnancy"]}, "onboarding_key": "pregnancy", "confidence": "MEDIUM", "substage": "UNCONFIRMED"}, {"priority": 15, "when": {"field_id": "amenorrhea_known_cause", "in": ["pregnancy"]}, "onboarding_key": "pregnancy", "confidence": "MEDIUM", "substage": "UNCONFIRMED"}, {"priority": 20, "when": {"field_id": "postpartum_time_range", "in": ["lt_1m"]}, "onboarding_key": "postpartum", "confidence": "HIGH", "substage": "LT_1M"}, {"priority": 21, "when": {"field_id": "postpartum_time_range", "in": ["m1_3"]}, "onboarding_key": "postpartum", "confidence": "HIGH", "substage": "M1_3"}, {"priority": 22, "when": {"field_id": "postpartum_time_range", "in": ["m4_6"]}, "onboarding_key": "postpartum", "confidence": "HIGH", "substage": "M4_6"}, {"priority": 23, "when": {"field_id": "postpartum_time_range", "in": ["m7_9"]}, "onboarding_key": "postpartum", "confidence": "HIGH", "substage": "M7_9"}, {"priority": 24, "when": {"field_id": "postpartum_time_range", "in": ["m10_12"]}, "onboarding_key": "postpartum", "confidence": "HIGH", "substage": "M10_12"}, {"priority": 25, "when": {"field_id": "postpartum_main_need", "in": ["recovery"]}, "onboarding_key": "postpartum", "confidence": "MEDIUM", "substage": "EXTENDED_RECOVERY"}, {"priority": 26, "when": {"field_id": "unsure_recent_birth", "in": ["yes"]}, "onboarding_key": "postpartum", "confidence": "MEDIUM", "substage": "UNSPECIFIED"}, {"priority": 27, "when": {"field_id": "cycle_change_known_cause", "in": ["recent_birth_or_breastfeeding"]}, "onboarding_key": "postpartum", "confidence": "MEDIUM", "substage": "UNSPECIFIED"}, {"priority": 28, "when": {"field_id": "amenorrhea_known_cause", "in": ["recent_birth_or_breastfeeding"]}, "onboarding_key": "postpartum", "confidence": "MEDIUM", "substage": "UNSPECIFIED"}, {"priority": 30, "when": {"field_id": "menarche_status", "in": ["not_started"]}, "onboarding_key": "menarche", "confidence": "HIGH", "substage": "PRE_MENARCHE"}, {"priority": 31, "when": {"field_id": "menarche_status", "in": ["very_recent"]}, "onboarding_key": "menarche", "confidence": "HIGH", "substage": "EARLY_MENARCHE"}, {"priority": 32, "when": {"field_id": "menarche_status", "in": ["within_two_years"]}, "onboarding_key": "menarche", "confidence": "HIGH", "substage": "CYCLE_FORMATION"}, {"priority": 33, "when": {"field_id": "menarche_status", "in": ["unsure"]}, "onboarding_key": "menarche", "confidence": "MEDIUM", "substage": "UNCERTAIN_ONSET"}, {"priority": 40, "when": {"field_id": "planning_pregnancy_status", "in": ["no"]}, "onboarding_key": "planning", "confidence": "HIGH", "substage": "PREPARING"}, {"priority": 41, "when": {"field_id": "planning_pregnancy_status", "in": ["maybe"]}, "onboarding_key": "planning", "confidence": "MEDIUM", "substage": "PREPARING", "additional_contexts": ["POSSIBLE_PREGNANCY"]}, {"priority": 42, "when": {"field_id": "postpartum_main_need", "in": ["planning"]}, "onboarding_key": "planning", "confidence": "MEDIUM", "substage": "PREPARING"}, {"priority": 43, "when": {"field_id": "unsure_planning", "in": ["yes"]}, "onboarding_key": "planning", "confidence": "HIGH", "substage": "PREPARING"}, {"priority": 50, "when": {"field_id": "amenorrhea_known_cause", "in": ["doctor_confirmed_menopause"]}, "onboarding_key": "menopause", "confidence": "HIGH", "substage": "CONFIRMED"}, {"priority": 51, "when": {"field_id": "amenorrhea_known_cause", "in": ["no_known_cause"]}, "onboarding_key": "menopause", "confidence": "MEDIUM", "substage": "UNCONFIRMED"}, {"priority": 52, "when": {"field_id": "amenorrhea_known_cause", "in": ["do_not_know"]}, "onboarding_key": "menopause", "confidence": "LOW", "substage": "UNCONFIRMED"}, {"priority": 53, "when": {"field_id": "unsure_no_periods", "in": ["yes"]}, "onboarding_key": "menopause", "confidence": "MEDIUM", "substage": "UNCONFIRMED"}, {"priority": 60, "when": {"field_id": "cycle_change_known_cause", "in": ["doctor_said_perimenopause"]}, "onboarding_key": "perimenopause", "confidence": "HIGH", "substage": "CONFIRMED_CONTEXT"}, {"priority": 61, "when": {"field_id": "cycle_change_known_cause", "in": ["no_known_cause"]}, "onboarding_key": "perimenopause", "confidence": "MEDIUM", "substage": "POSSIBLE"}, {"priority": 62, "when": {"field_id": "cycle_change_known_cause", "in": ["do_not_know"]}, "onboarding_key": "perimenopause", "confidence": "LOW", "substage": "POSSIBLE"}, {"priority": 63, "when": {"field_id": "unsure_cycle_changing", "in": ["yes"]}, "onboarding_key": "perimenopause", "confidence": "MEDIUM", "substage": "POSSIBLE"}, {"priority": 70, "when": {"field_id": "pregnancy_status", "in": ["only_possible"]}, "onboarding_key": "cycle", "confidence": "MEDIUM", "substage": "STANDARD_CYCLE", "additional_contexts": ["POSSIBLE_PREGNANCY"]}, {"priority": 71, "when": {"field_id": "unsure_pregnancy", "in": ["possible"]}, "onboarding_key": "cycle", "confidence": "MEDIUM", "substage": "STANDARD_CYCLE", "additional_contexts": ["POSSIBLE_PREGNANCY"]}, {"priority": 72, "when": {"field_id": "cycle_change_known_cause", "in": ["hormonal", "surgery_or_treatment", "stress_weight_illness"]}, "onboarding_key": "cycle", "confidence": "MEDIUM", "substage": "OBSERVATION_CONTEXT"}, {"priority": 73, "when": {"field_id": "amenorrhea_known_cause", "in": ["hormonal", "surgery_or_treatment"]}, "onboarding_key": "cycle", "confidence": "MEDIUM", "substage": "OBSERVATION_CONTEXT"}, {"priority": 74, "when": {"field_id": "postpartum_main_need", "in": ["cycle"]}, "onboarding_key": "cycle", "confidence": "HIGH", "substage": "STANDARD_CYCLE"}, {"priority": 75, "when": {"field_id": "current_situation", "in": ["cycle_tracking"]}, "onboarding_key": "cycle", "confidence": "HIGH", "substage": "STANDARD_CYCLE"}], "routing_fallback": {"onboarding_key": "cycle", "substage": "STANDARD_CYCLE", "confidence": "LOW"}}'::jsonb, 'draft')
on conflict (onboarding_key, version, locale) do update
  set schema = excluded.schema, status = 'draft';


do $$
declare v_id uuid;
begin
  for v_id in
    select id from public.onboarding_definitions
    where onboarding_key = 'lifecycle_router' and version = 2
  loop
    perform public.publish_onboarding_definition(v_id);
  end loop;
end $$;
