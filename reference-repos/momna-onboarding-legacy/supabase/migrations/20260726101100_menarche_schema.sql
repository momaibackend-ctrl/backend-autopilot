-- ============================================================
-- 1100. Схема menarche (RU + en-US) и два расширения механизма.
--
-- Источник: 01_Momna_Deep_Onboarding_Menarche_US_EN.docx, сверено
-- с готовым дизайном в Figma (17 экранов онбординга менархе).
--
-- Расхождения docx vs Figma, разрешённые в пользу Figma как более
-- новой версии:
--   - MEN_LAST_PERIOD: в docx — "показать дату из роутера" (роутер
--     LMP не собирает, тот же баг что Vita нашла в анкете беременности
--     22.07). На макете — обычный календарь + "I do not remember"
--     внизу, без предвыбранной даты. Взята версия макета.
--   - MEN_RELATIONSHIP: в docx помечен возрастным условием. На макете
--     (экран 14) показывается всем без ограничения. Условие снято.
--
-- Возрастной порог для MEN_SEX_ACTIVE — временный дефолт 18 лет для
-- всех стран. Решение продукта (26.07): возраст согласия ниже 18
-- в большинстве стран, но 18 — безопасная норма для контента
-- независимо от локального законодательства. Таблицу порогов по
-- странам можно подключить позже отдельной миграцией, заменив
-- {"age_gte": 18} без изменения структуры вопроса.
--
-- ДВА РАСШИРЕНИЯ МЕХАНИЗМА, ПОТРЕБОВАВШИЕСЯ ДЛЯ ЭТОЙ СХЕМЫ:
--
-- 1. Условия вида "router:field_id" в evaluate_condition и
--    validate_show_if_condition. MEN_CHANGES и другие вопросы должны
--    показываться по ответу, данному в РОУТЕРЕ (menarche_status),
--    а не переспрашивать его внутри анкеты периода. Читается ответ
--    из последней завершённой сессии lifecycle_router того же
--    пользователя — то же правило "только последняя", что и у prefill.
--
-- 2. extra_option в валидаторе date/date_confirm. MEN_LAST_PERIOD —
--    вопрос вида "выбери дату ИЛИ нажми отдельную кнопку" (I do not
--    remember). Раньше date/date_confirm всегда требовали поле date;
--    теперь допустим альтернативный ответ {"value": "<extra_option>"}.
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
    -- extra_option (добавлено миграцией 1100): вопрос вида "выбери дату
    -- ИЛИ нажми отдельную кнопку" — например MEN_LAST_PERIOD с кнопкой
    -- "I do not remember". Тогда допустим альтернативный ответ
    -- {"value": "<extra_option>"} вместо {"date": ...}, и это не
    -- обрабатывается как reason/skip: это самостоятельный содержательный
    -- ответ, который нормализуется в профиль как обычное значение.
    if (p_question ? 'extra_option') and (p_answer_value ? 'value') then
      if (p_answer_value ->> 'value') <> (p_question ->> 'extra_option') then
        return 'invalid_extra_option: ' || (p_answer_value ->> 'value');
      end if;
      return null;
    end if;

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

create or replace function public.evaluate_condition(p_session_id uuid, p_condition jsonb)
returns boolean
language plpgsql stable security definer set search_path = public
as $$
declare
  v_item jsonb;
  v_answer jsonb;
  v_num numeric;
  v_age int;
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

  -- Возрастные условия (добавлено миграцией 0900).
  -- Возраст берётся из profiles.date_of_birth владельца сессии,
  -- а не из ответов: он собирается роутером один раз и живёт
  -- в профиле. Без этого возрастную блокировку пришлось бы делать
  -- на клиенте — а в анкете менархе от неё зависит показ вопросов
  -- про отношения и сексуальную близость.
  --
  -- Если дата рождения неизвестна (пользовательница пропустила
  -- вопрос), условие ВСЕГДА ложно: вопрос не показывается.
  -- Отказ в небезопасную сторону здесь недопустим.
  if (p_condition ? 'age_gte') or (p_condition ? 'age_lt') then
    select extract(year from age(p.date_of_birth))::int
      into v_age
    from public.onboarding_sessions s
    join public.profiles p on p.id = s.user_id
    where s.id = p_session_id;

    if v_age is null then
      return false;
    end if;

    if (p_condition ? 'age_gte')
       and v_age < (p_condition ->> 'age_gte')::int then
      return false;
    end if;

    if (p_condition ? 'age_lt')
       and v_age >= (p_condition ->> 'age_lt')::int then
      return false;
    end if;

    return true;
  end if;

  if not (p_condition ? 'field_id') then
    return false;
  end if;

  -- Условие вида "router:field_id" читает ответ из ПОСЛЕДНЕЙ завершённой
  -- сессии роутера того же пользователя, а не из текущей сессии.
  -- Нужно для вопросов вида "покажи только если в роутере ответили X" —
  -- например, MEN_CHANGES показывается по значению menarche_status,
  -- которое было в роутере, а не переспрашивается в анкете периода.
  --
  -- Обязательно самая ПОСЛЕДНЯЯ завершённая сессия, не любая: то же
  -- правило одноразового и актуального prefill, что и в start_onboarding.
  if left(p_condition ->> 'field_id', 7) = 'router:' then
    select a.answer_value into v_answer
    from public.onboarding_answers a
    join public.onboarding_sessions s on s.id = a.session_id
    where s.user_id = (select o.user_id from public.onboarding_sessions o where o.id = p_session_id)
      and s.onboarding_key = 'lifecycle_router'
      and s.status = 'completed'
      and a.field_id = substring(p_condition ->> 'field_id' from 8)
      and s.completed_at = (
        select max(s2.completed_at) from public.onboarding_sessions s2
        where s2.user_id = s.user_id and s2.onboarding_key = 'lifecycle_router' and s2.status = 'completed'
      )
    limit 1;
  else
    select answer_value into v_answer
    from public.onboarding_answers
    where session_id = p_session_id
      and field_id = p_condition ->> 'field_id';
  end if;

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

  -- Возрастное условие не ссылается на вопрос анкеты: возраст берётся
  -- из profiles.date_of_birth. Поэтому проверяется до требования field_id.
  if (p_condition ? 'age_gte') or (p_condition ? 'age_lt') then
    if p_condition ? 'field_id' then
      return 'age_condition_cannot_have_field_id';
    end if;
    if p_condition ? 'age_gte' then
      if jsonb_typeof(p_condition -> 'age_gte') is distinct from 'number'
         or (p_condition ->> 'age_gte')::numeric < 0
         or (p_condition ->> 'age_gte')::numeric > 120
         or trunc((p_condition ->> 'age_gte')::numeric) <> (p_condition ->> 'age_gte')::numeric then
        return 'invalid_age_gte';
      end if;
    end if;
    if p_condition ? 'age_lt' then
      if jsonb_typeof(p_condition -> 'age_lt') is distinct from 'number'
         or (p_condition ->> 'age_lt')::numeric < 0
         or (p_condition ->> 'age_lt')::numeric > 120
         or trunc((p_condition ->> 'age_lt')::numeric) <> (p_condition ->> 'age_lt')::numeric then
        return 'invalid_age_lt';
      end if;
    end if;
    if (p_condition ? 'age_gte') and (p_condition ? 'age_lt')
       and (p_condition ->> 'age_gte')::int >= (p_condition ->> 'age_lt')::int then
      return 'empty_age_range';
    end if;
    return null;
  end if;

  v_field := p_condition ->> 'field_id';
  if v_field is null or btrim(v_field) = '' then
    return 'leaf_condition_without_field_id';
  end if;
  -- "router:field_id" ссылается на ответ в схеме Lifecycle Router,
  -- а не в текущей анкете — p_ids его заведомо не содержит.
  -- Существование самого поля в схеме роутера здесь не проверяется:
  -- схемы публикуются независимо, и на момент публикации анкеты
  -- периода схема роутера может быть более новой версией.
  if left(v_field, 7) <> 'router:' and not (v_field = any(p_ids)) then
    return 'condition_field_not_found: ' || v_field;
  end if;
  if left(v_field, 7) = 'router:' and length(v_field) <= 7 then
    return 'router_condition_without_field_name';
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


insert into public.onboarding_definitions
  (onboarding_key, life_period, version, locale, schema, status)
values
  ('menarche', 'menarche', 1, 'en-US', '{"sections": [{"id": "menarche", "questions": [{"field_id": "MEN_GOAL", "format": "multi_choice", "max_select": 3, "profile_path": "menarche.goals", "options": ["understand_body", "get_ready", "less_worried", "predict_next", "handle_cramps", "learn_products", "understand_mood", "know_when_help", "explore_own_pace"], "option_labels": {"understand_body": "Understand what is happening in my body", "get_ready": "Get ready for my first period", "less_worried": "Feel less worried about my period starting unexpectedly", "predict_next": "Have a better idea of when my next period may come", "handle_cramps": "Handle cramps or other discomfort", "learn_products": "Learn how period products work", "understand_mood": "Understand changes in my mood and emotions", "know_when_help": "Know what is normal and when to ask for help", "explore_own_pace": "For now, I just want to explore at my own pace"}, "label": "What would you most like Momna to help you with?"}, {"field_id": "MEN_BODY_FEEL", "format": "single_choice", "profile_path": "menarche.body_feel", "options": ["calm_curious", "unfamiliar_ok", "embarrassed", "compare_others", "worried_wrong", "not_noticed", "not_sure", "prefer_not_to_say"], "option_labels": {"calm_curious": "Mostly calm and curious", "unfamiliar_ok": "It feels unfamiliar sometimes, but I am doing okay", "embarrassed": "I feel embarrassed or ashamed", "compare_others": "I compare myself with other people a lot", "worried_wrong": "I worry that something may be wrong with me", "not_noticed": "I have not noticed many changes yet", "not_sure": "I am not sure", "prefer_not_to_say": "Prefer not to answer"}, "label": "How do you feel about the changes happening in your body?"}, {"field_id": "MEN_CHANGES", "format": "multi_choice", "profile_path": "menarche.body_changes", "show_if": {"field_id": "router:menarche_status", "in": ["not_started", "very_recent"]}, "options": ["breasts", "body_hair", "discharge", "acne", "height_shape", "mood_changes", "body_odor", "none_yet", "not_sure", "prefer_not_to_say"], "option_labels": {"breasts": "My breasts have started developing", "body_hair": "I have more body hair", "discharge": "I have noticed vaginal discharge", "acne": "I have acne or more breakouts", "height_shape": "My height or body shape is changing quickly", "mood_changes": "My mood changes more often", "body_odor": "My body odor has changed", "none_yet": "I have not noticed any of these yet", "not_sure": "I am not sure", "prefer_not_to_say": "Prefer not to answer"}, "label": "Which changes have you noticed so far?"}, {"field_id": "MEN_FIRST_PERIOD_WORRY", "format": "multi_choice", "profile_path": "menarche.first_period_worry", "show_if": {"field_id": "router:menarche_status", "in": ["not_started"]}, "options": ["at_school", "might_hurt", "lot_of_blood", "wont_know_what_to_do", "someone_notice", "awkward_adult", "dont_know_products", "not_worried", "something_else", "prefer_not_to_say"], "option_labels": {"at_school": "It may start at school or when I am away from home", "might_hurt": "It may hurt", "lot_of_blood": "There may be a lot of blood", "wont_know_what_to_do": "I will not know what to do", "someone_notice": "Someone may notice", "awkward_adult": "I feel awkward talking to an adult about it", "dont_know_products": "I do not know which period products to use", "not_worried": "I am not very worried about it", "something_else": "Something else", "prefer_not_to_say": "Prefer not to answer"}, "label": "What worries you most about getting your first period?"}, {"field_id": "MEN_FIRST_EXPERIENCE", "format": "single_choice", "profile_path": "menarche.first_experience", "show_if": {"field_id": "router:menarche_status", "in": ["very_recent", "within_two_years"]}, "options": ["easier_than_expected", "unfamiliar_handled", "started_unexpectedly", "painful", "scared_me", "awkward_asking_help", "not_sure_how_feel", "prefer_not_to_say"], "option_labels": {"easier_than_expected": "It was easier than I expected", "unfamiliar_handled": "It felt unfamiliar, but I handled it", "started_unexpectedly": "It started unexpectedly", "painful": "It was painful or very uncomfortable", "scared_me": "It scared me", "awkward_asking_help": "I felt awkward asking for help", "not_sure_how_feel": "I am still not sure how I feel about it", "prefer_not_to_say": "Prefer not to answer"}, "label": "How did your first period feel for you?"}, {"field_id": "MEN_LAST_PERIOD", "format": "date", "profile_path": "menarche.last_period_date", "show_if": {"field_id": "router:menarche_status", "in": ["very_recent", "within_two_years"]}, "date_constraint": "past_or_today", "max_past_days": 60, "extra_option": "i_do_not_remember", "extra_option_labels": {"ru": "Я не помню", "en": "I do not remember"}, "label": "When did your most recent period start?", "hint": "Select one and I''ll use this to tailor Momna for you."}, {"field_id": "MEN_PERIOD_PATTERN", "format": "multi_choice", "profile_path": "menarche.period_pattern", "show_if": {"field_id": "router:menarche_status", "in": ["very_recent", "within_two_years"]}, "options": ["only_one", "lasts_1_2", "lasts_3_5", "lasts_6_7", "longer_than_week", "bleed_through", "change_often", "different_every_time", "not_sure_yet", "prefer_not_to_say"], "option_labels": {"only_one": "I have only had one period", "lasts_1_2": "They usually last 1-2 days", "lasts_3_5": "They usually last 3-5 days", "lasts_6_7": "They usually last 6-7 days", "longer_than_week": "They sometimes last longer than a week", "bleed_through": "I sometimes bleed through a pad, tampon, or clothing", "change_often": "I have to change a period product very often", "different_every_time": "They have been different every time", "not_sure_yet": "I am not sure how to judge this yet", "prefer_not_to_say": "Prefer not to answer"}, "label": "What are your periods usually like so far?"}, {"field_id": "MEN_SYMPTOMS", "format": "multi_choice", "profile_path": "menarche.symptoms", "sensitivity_level": "health", "show_if": {"field_id": "router:menarche_status", "in": ["very_recent", "within_two_years"]}, "options": ["cramps", "back_pain", "headaches", "fatigue", "nausea", "bloating", "mood_swings", "anxiety_crying", "acne", "appetite_changes", "nothing_noticeable", "not_enough_periods", "prefer_not_to_say"], "option_labels": {"cramps": "Stomach cramps", "back_pain": "Back pain", "headaches": "Headaches", "fatigue": "Weakness or strong fatigue", "nausea": "Nausea", "bloating": "Bloating", "mood_swings": "Bigger mood changes", "anxiety_crying": "Anxiety or feeling like crying", "acne": "Acne or breakouts", "appetite_changes": "Changes in appetite", "nothing_noticeable": "Nothing noticeable so far", "not_enough_periods": "I have not had enough periods to know yet", "prefer_not_to_say": "Prefer not to answer"}, "label": "What do you notice before or during your period?"}, {"field_id": "MEN_IMPACT", "format": "single_choice", "profile_path": "menarche.impact", "show_if": {"field_id": "router:menarche_status", "in": ["very_recent", "within_two_years"]}, "options": ["no_impact", "harder_sometimes", "miss_activity", "barely_function", "dont_know_yet", "prefer_not_to_say"], "option_labels": {"no_impact": "No, I can usually do everything I normally do", "harder_sometimes": "Sometimes school, sports, or going out feels harder", "miss_activity": "Sometimes I have to miss school or another activity", "barely_function": "Sometimes I feel so unwell that I can barely do normal things", "dont_know_yet": "I do not know yet", "prefer_not_to_say": "Prefer not to answer"}, "label": "Does your period ever make regular activities difficult?"}, {"field_id": "MEN_PRODUCTS", "format": "multi_choice", "profile_path": "menarche.products_known", "options": ["pads", "tampons", "period_underwear", "menstrual_cups", "none_yet", "want_to_understand", "prefer_not_to_say"], "option_labels": {"pads": "Pads", "tampons": "Tampons", "period_underwear": "Period underwear", "menstrual_cups": "Menstrual cups", "none_yet": "None yet", "want_to_understand": "I want to understand the differences", "prefer_not_to_say": "Prefer not to answer"}, "label": "Which period products have you heard about or used?"}, {"field_id": "MEN_DAY_CONTEXT", "format": "single_choice", "profile_path": "person.day_context", "options": ["school", "college", "work", "mostly_home", "varies", "somewhere_else", "prefer_not_to_say"], "option_labels": {"school": "At school", "college": "At college or university", "work": "At work", "mostly_home": "Mostly at home", "varies": "My days are very different from one another", "somewhere_else": "Somewhere else", "prefer_not_to_say": "Prefer not to answer"}, "label": "Where do you spend most of your day?"}, {"field_id": "MEN_TOILET_ACCESS", "format": "single_choice", "profile_path": "menarche.toilet_access", "options": ["usually_easy", "need_permission", "sometimes_difficult", "almost_impossible", "dont_know_yet", "prefer_not_to_say"], "option_labels": {"usually_easy": "Usually easy", "need_permission": "I can, but I have to ask permission", "sometimes_difficult": "Sometimes it is difficult", "almost_impossible": "It is often almost impossible", "dont_know_yet": "I do not know yet", "prefer_not_to_say": "Prefer not to answer"}, "label": "How easy is it for you to use a bathroom or change a period product during the day?"}, {"field_id": "MEN_NOTIFICATIONS", "format": "single_choice", "profile_path": "person.notifications.wording", "options": ["direct_ok", "neutral_wording", "only_important", "no_notifications"], "option_labels": {"direct_ok": "It is okay to mention periods directly", "neutral_wording": "Please use neutral wording", "only_important": "Only send the most important notifications", "no_notifications": "Do not send notifications for now"}, "label": "How should period-related notifications appear on your phone?"}, {"field_id": "MEN_TRUSTED_ADULT", "format": "single_choice", "profile_path": "menarche.trusted_adult", "sensitivity_level": "health", "options": ["easy_to_talk", "a_bit_awkward", "someone_unsure", "no_one", "dont_want_to", "prefer_not_to_say"], "option_labels": {"easy_to_talk": "Yes, it is easy for me to talk to them", "a_bit_awkward": "Yes, but I feel a little awkward", "someone_unsure": "There is someone, but I am not sure they will understand", "no_one": "No, I do not have anyone to talk to", "dont_want_to": "I do not want to talk to an adult about this", "prefer_not_to_say": "Prefer not to answer"}, "label": "Is there a trusted adult you can talk to about your health?"}, {"field_id": "MEN_HEALTH_TALK", "format": "single_choice", "profile_path": "person.health_talk_style", "options": ["ask_directly", "read_first", "need_a_sentence", "very_uncomfortable", "not_sure", "prefer_not_to_say"], "option_labels": {"ask_directly": "I can ask directly", "read_first": "I would rather read first and understand it on my own", "need_a_sentence": "I need a sentence I can use to start the conversation", "very_uncomfortable": "I feel very uncomfortable talking about it", "not_sure": "I am not sure", "prefer_not_to_say": "Prefer not to answer"}, "label": "What makes it easiest for you to talk about health?"}, {"field_id": "MEN_HEALTH_CONTEXT", "format": "multi_choice", "profile_path": "menarche.health_context", "sensitivity_level": "health", "required": false, "options": ["anemia", "bleeding_condition", "thyroid", "heavy_painful_periods", "other_condition", "no", "dont_know", "prefer_not_to_say"], "option_labels": {"anemia": "Anemia or low iron", "bleeding_condition": "A bleeding or clotting condition", "thyroid": "A thyroid condition", "heavy_painful_periods": "Very heavy or painful periods", "other_condition": "Another health condition", "no": "No", "dont_know": "I do not know", "prefer_not_to_say": "Prefer not to answer"}, "label": "Has a doctor or other clinician told you about anything Momna should keep in mind?"}, {"field_id": "MEN_SLEEP", "format": "single_choice", "profile_path": "person.sleep", "options": ["enough_sleep", "stay_up_late", "trouble_falling_asleep", "wake_often", "hard_to_get_up", "different_every_day", "not_sure", "prefer_not_to_say"], "option_labels": {"enough_sleep": "I usually get enough sleep", "stay_up_late": "I often stay up late", "trouble_falling_asleep": "I have trouble falling asleep", "wake_often": "I wake up often during the night", "hard_to_get_up": "It is hard to get up in the morning", "different_every_day": "Every day is different", "not_sure": "I am not sure", "prefer_not_to_say": "Prefer not to answer"}, "label": "What is sleep usually like for you?"}, {"field_id": "MEN_ACTIVITY", "format": "single_choice", "profile_path": "person.activity", "options": ["move_a_lot", "mixed", "sit_most_day", "physically_exhausted", "varies", "prefer_not_to_say"], "option_labels": {"move_a_lot": "I move a lot or play sports", "mixed": "Some days I move a lot, and other days I sit for long periods", "sit_most_day": "I sit for most of the day", "physically_exhausted": "I often feel physically exhausted", "varies": "My days are very different from one another", "prefer_not_to_say": "Prefer not to answer"}, "label": "What is a typical day like physically?"}, {"field_id": "MEN_EMOTIONS", "format": "multi_choice", "max_select": 3, "profile_path": "person.emotional_baseline", "sensitivity_level": "health", "options": ["calm", "happy_energetic", "tired", "irritable", "anxious", "sad", "lonely", "mood_changed_a_lot", "hard_to_tell", "prefer_not_to_say"], "option_labels": {"calm": "Calm", "happy_energetic": "Happy and energetic", "tired": "Tired", "irritable": "Irritable", "anxious": "Anxious", "sad": "Sad", "lonely": "Lonely", "mood_changed_a_lot": "My mood changed a lot", "hard_to_tell": "It is hard for me to tell", "prefer_not_to_say": "Prefer not to answer"}, "label": "How have you felt most often over the past two weeks?"}, {"field_id": "MEN_BODY_IMAGE", "format": "single_choice", "profile_path": "person.body_image", "required": false, "options": ["mostly_comfortable", "changes_day_to_day", "often_unhappy", "hide_changes", "hard_not_to_criticize", "dont_think_about_it", "prefer_not_to_say"], "option_labels": {"mostly_comfortable": "Mostly comfortable", "changes_day_to_day": "It changes from day to day", "often_unhappy": "I am often unhappy with my body", "hide_changes": "I try to hide the changes in my body", "hard_not_to_criticize": "It is hard not to criticize how I look", "dont_think_about_it": "I do not think about it much", "prefer_not_to_say": "Prefer not to answer"}, "label": "How do you usually feel in your body?"}, {"field_id": "MEN_FREE_TIME", "format": "multi_choice", "max_select": 3, "profile_path": "person.recovery_activities", "options": ["music", "walking", "sports_dancing", "reading", "games", "drawing_making", "friends", "time_alone", "movies_shows", "not_sure_yet", "something_else"], "option_labels": {"music": "Music", "walking": "Going for a walk", "sports_dancing": "Sports or dancing", "reading": "Reading", "games": "Games", "drawing_making": "Drawing or making things", "friends": "Spending time with friends", "time_alone": "Time by myself", "movies_shows": "Movies or shows", "not_sure_yet": "I am not sure yet", "something_else": "Something else"}, "label": "What actually helps you relax or feel better?"}, {"field_id": "MEN_RELATIONSHIP", "format": "single_choice", "profile_path": "menarche.relationship_status", "required": false, "skippable": true, "options": ["yes", "starting", "no", "not_sure_how_to_describe", "prefer_not_to_say"], "option_labels": {"yes": "Yes", "starting": "I like someone or a relationship is just starting", "no": "No", "not_sure_how_to_describe": "I am not sure how to describe it", "prefer_not_to_say": "Prefer not to answer"}, "label": "Are you currently dating or in a romantic relationship?"}, {"field_id": "MEN_RELATIONSHIP_SAFETY", "format": "single_choice", "profile_path": "menarche.relationship_safety", "sensitivity_level": "highly_sensitive", "required": false, "skippable": true, "show_if": {"field_id": "MEN_RELATIONSHIP", "in": ["yes", "starting"]}, "options": ["comfortable_safe", "mostly_good", "hard_to_say_no", "pressured", "afraid_unsafe", "not_sure", "prefer_not_to_say"], "option_labels": {"comfortable_safe": "Comfortable and safe", "mostly_good": "Mostly good, but some things are hard to talk about", "hard_to_say_no": "It is hard for me to say no or set boundaries", "pressured": "I feel pressured", "afraid_unsafe": "I sometimes feel afraid or unsafe", "not_sure": "I am not sure", "prefer_not_to_say": "Prefer not to answer"}, "label": "How do you usually feel in this relationship?"}, {"field_id": "MEN_SEX_ACTIVE", "format": "single_choice", "profile_path": "menarche.sexual_activity", "sensitivity_level": "highly_sensitive", "required": false, "skippable": true, "show_if": {"age_gte": 18}, "options": ["yes", "sometimes", "no", "not_sure_what_counts", "prefer_not_to_say"], "option_labels": {"yes": "Yes", "sometimes": "Sometimes", "no": "No", "not_sure_what_counts": "I am not sure what counts as sexual activity", "prefer_not_to_say": "Prefer not to answer"}, "label": "Is sexual activity part of your life right now?"}, {"field_id": "MEN_SEX_COMFORT", "format": "multi_choice", "profile_path": "menarche.sex_comfort", "sensitivity_level": "highly_sensitive", "required": false, "skippable": true, "show_if": {"all": [{"age_gte": 18}, {"field_id": "MEN_SEX_ACTIVE", "in": ["yes", "sometimes"]}]}, "options": ["preventing_pregnancy", "preventing_sti", "pain_discomfort", "consent_boundaries", "talk_to_partner", "everything_ok", "not_sure", "prefer_not_to_say"], "option_labels": {"preventing_pregnancy": "Preventing pregnancy", "preventing_sti": "Preventing sexually transmitted infections", "pain_discomfort": "Pain or discomfort", "consent_boundaries": "Consent and personal boundaries", "talk_to_partner": "How to talk with a partner", "everything_ok": "Everything feels okay right now", "not_sure": "I am not sure", "prefer_not_to_say": "Prefer not to answer"}, "label": "Is there anything about sexual health you would like explained clearly?"}, {"field_id": "MEN_BEHAVIOR", "format": "paired_choice", "profile_path": "person.behavior", "rows": [{"row_id": "planning", "options": ["plan_ahead", "decide_as_i_go"], "option_labels": {"plan_ahead": "Plan ahead", "decide_as_i_go": "Decide as I go"}}, {"row_id": "depth", "options": ["action_first", "explain_first"], "option_labels": {"action_first": "Give me the action first", "explain_first": "Explain it first"}}, {"row_id": "reminders", "options": ["gentle_reminders", "only_when_open_app"], "option_labels": {"gentle_reminders": "Gentle reminders", "only_when_open_app": "Only when I open the app"}}, {"row_id": "steps", "options": ["one_small_step", "few_steps_for_day"], "option_labels": {"one_small_step": "One small step", "few_steps_for_day": "A few steps for the day"}}], "label": "How do you prefer to receive support?"}, {"field_id": "MEN_TONE", "format": "single_choice", "profile_path": "person.communication.tone", "options": ["gentle", "friendly", "close_friend", "direct"], "option_labels": {"gentle": "Gentle - soft and careful, with no jokes", "friendly": "Friendly - natural and easy, with occasional light humor", "close_friend": "Like someone who knows me well - informal, conversational, and okay with jokes", "direct": "Direct - brief, honest, and never overly sweet"}, "label": "How can Momna talk with you?"}]}]}'::jsonb, 'draft')
on conflict (onboarding_key, version, locale) do update
  set schema = excluded.schema, status = 'draft';

do $$
declare v_id uuid;
begin
  for v_id in
    select id from public.onboarding_definitions
    where onboarding_key = 'menarche' and version = 1
  loop
    perform public.publish_onboarding_definition(v_id);
  end loop;
end $$;


-- ============================================================
-- Роутер, версия 4. Правка текста ответа в ветке послеродового периода.
--
-- Только текст, машинное значение "recent_birth" не менялось —
-- маршрутизация от него не зависит, старые сессии не пострадают.
--
--   было:  "I recently gave birth or I'm still recovering from childbirth"
--   стало: "I gave birth less than a year ago"
-- ============================================================

update public.onboarding_definitions
set status = 'archived'
where onboarding_key = 'lifecycle_router' and version = 3;

insert into public.onboarding_definitions
  (onboarding_key, life_period, version, locale, schema, status)
values ('lifecycle_router','lifecycle_router',4,'ru','{"sections": [{"id": "router", "questions": [{"field_id": "display_name", "format": "short_text", "required": false, "skippable": true, "max_length": 60, "profile_column": "first_name", "label": "Как к тебе обращаться?", "hint": "Имя может быть настоящим, сокращённым или любым удобным обращением."}, {"field_id": "birth_date", "format": "date", "required": false, "skippable": true, "date_constraint": "past_or_today", "min_past_days": 2920, "max_past_days": 27375, "profile_column": "date_of_birth", "label": "Когда ты родилась?", "hint": "Это помогает показывать подходящий и безопасный контент. Сам по себе возраст не определяет твой период."}, {"field_id": "menarche_status", "format": "single_choice", "required": true, "skippable": true, "options": ["not_started", "very_recent", "within_two_years", "more_than_two_years", "unsure", "prefer_not_to_say"], "label": "Начались ли у тебя когда-нибудь месячные?", "option_labels": {"not_started": "Нет, ещё не начались", "very_recent": "Да, первые были совсем недавно", "within_two_years": "Да, первые начались в последние два года", "more_than_two_years": "Да, первые начались больше двух лет назад", "unsure": "Кажется, были, но я не уверена", "prefer_not_to_say": "Не хочу отвечать"}}, {"field_id": "current_situation", "format": "single_choice", "required": true, "skippable": true, "options": ["pregnant", "possible_pregnancy", "recent_birth", "planning", "cycle_tracking", "cycle_changing", "no_periods_12m", "unsure", "prefer_not_to_say"], "show_if": {"field_id": "menarche_status", "in": ["more_than_two_years", "prefer_not_to_say"]}, "label": "Что сейчас лучше всего описывает твою ситуацию?", "hint": "Выбери то, что происходит с тобой сейчас, а не тему, о которой тебе просто интересно читать.", "option_labels": {"pregnant": "Я беременна", "possible_pregnancy": "Беременность возможна, но пока не подтверждена", "recent_birth": "Я родила меньше года назад", "planning": "Я готовлюсь или пытаюсь забеременеть", "cycle_tracking": "Я слежу за циклом и своим самочувствием", "cycle_changing": "Месячные стали заметно меняться или пропускаться", "no_periods_12m": "Месячных нет уже двенадцать месяцев или дольше", "unsure": "Я не уверена, какой вариант выбрать", "prefer_not_to_say": "Не хочу отвечать"}}, {"field_id": "pregnancy_status", "format": "single_choice", "required": false, "skippable": true, "options": ["confirmed_by_doctor", "test_positive", "only_possible", "not_pregnant", "prefer_not_to_say"], "show_if": {"field_id": "current_situation", "in": ["pregnant", "possible_pregnancy"]}, "label": "Что сейчас известно о беременности?", "option_labels": {"confirmed_by_doctor": "Беременность подтверждена врачом", "test_positive": "Тест положительный, но у врача ещё не была", "only_possible": "Беременность только возможна", "not_pregnant": "Я ошиблась, беременности нет", "prefer_not_to_say": "Не хочу отвечать"}}, {"field_id": "postpartum_time_range", "format": "single_choice", "required": false, "skippable": true, "options": ["lt_1m", "m1_3", "m4_6", "m7_9", "m10_12", "more_than_year", "prefer_not_to_say"], "show_if": {"field_id": "current_situation", "in": ["recent_birth"]}, "label": "Сколько времени прошло с рождения ребёнка?", "hint": "Это помогает понять, на каком этапе восстановление и что сейчас происходит с малышом.", "option_labels": {"lt_1m": "Меньше месяца назад", "m1_3": "1–3 месяца назад", "m4_6": "4–6 месяцев назад", "m7_9": "7–9 месяцев назад", "m10_12": "10–12 месяцев назад", "more_than_year": "Прошло больше года", "prefer_not_to_say": "Не хочу отвечать"}}, {"field_id": "postpartum_main_need", "format": "single_choice", "required": false, "skippable": true, "options": ["recovery", "cycle", "planning", "prefer_not_to_say"], "show_if": {"field_id": "postpartum_time_range", "in": ["more_than_year"]}, "label": "Что для тебя сейчас важнее всего?", "option_labels": {"recovery": "Восстановление после родов", "cycle": "Цикл и повседневная жизнь", "planning": "Планирование следующей беременности", "prefer_not_to_say": "Не хочу отвечать"}}, {"field_id": "planning_pregnancy_status", "format": "single_choice", "required": false, "skippable": true, "options": ["no", "confirmed", "maybe", "prefer_not_to_say"], "show_if": {"field_id": "current_situation", "in": ["planning"]}, "label": "Беременность уже подтверждена или возможна?", "option_labels": {"no": "Нет", "confirmed": "Да, подтверждена", "maybe": "Возможно, но пока не уверена", "prefer_not_to_say": "Не хочу отвечать"}}, {"field_id": "cycle_change_known_cause", "format": "single_choice", "required": false, "skippable": true, "options": ["pregnancy", "recent_birth_or_breastfeeding", "hormonal", "surgery_or_treatment", "stress_weight_illness", "doctor_said_perimenopause", "no_known_cause", "do_not_know", "prefer_not_to_say"], "show_if": {"field_id": "current_situation", "in": ["cycle_changing"]}, "label": "Есть ли известная причина этих изменений?", "option_labels": {"pregnancy": "Беременность", "recent_birth_or_breastfeeding": "Недавние роды или грудное вскармливание", "hormonal": "Гормональная контрацепция или гормональные препараты", "surgery_or_treatment": "Операция или медицинское лечение", "stress_weight_illness": "Сильный стресс, изменение веса или болезнь", "doctor_said_perimenopause": "Врач говорил о перименопаузе", "no_known_cause": "Известной причины нет", "do_not_know": "Не знаю", "prefer_not_to_say": "Не хочу отвечать"}}, {"field_id": "amenorrhea_known_cause", "format": "single_choice", "required": false, "skippable": true, "options": ["pregnancy", "recent_birth_or_breastfeeding", "hormonal", "surgery_or_treatment", "doctor_confirmed_menopause", "no_known_cause", "do_not_know", "prefer_not_to_say"], "show_if": {"field_id": "current_situation", "in": ["no_periods_12m"]}, "label": "Есть ли известная причина отсутствия месячных?", "option_labels": {"pregnancy": "Беременность", "recent_birth_or_breastfeeding": "Недавние роды или грудное вскармливание", "hormonal": "Гормональная контрацепция или препараты", "surgery_or_treatment": "Операция или медицинское лечение", "doctor_confirmed_menopause": "Врач подтвердил менопаузу", "no_known_cause": "Известной причины нет", "do_not_know": "Не знаю", "prefer_not_to_say": "Не хочу отвечать"}}, {"field_id": "unsure_pregnancy", "format": "single_choice", "required": false, "skippable": true, "options": ["confirmed", "possible", "no"], "show_if": {"field_id": "current_situation", "in": ["unsure"]}, "label": "Беременность сейчас подтверждена или возможна?", "option_labels": {"confirmed": "Подтверждена", "possible": "Возможна", "no": "Нет"}}, {"field_id": "unsure_recent_birth", "format": "single_choice", "required": false, "skippable": true, "options": ["yes", "no"], "show_if": {"field_id": "unsure_pregnancy", "in": ["no"]}, "label": "Роды были в течение последнего года или восстановление ещё продолжается?", "option_labels": {"yes": "Да", "no": "Нет", "not_sure": "Не уверена"}}, {"field_id": "unsure_planning", "format": "single_choice", "required": false, "skippable": true, "options": ["yes", "no"], "show_if": {"field_id": "unsure_recent_birth", "in": ["no"]}, "label": "Ты готовишься или пытаешься забеременеть?", "option_labels": {"yes": "Да", "no": "Нет", "not_sure": "Не уверена"}}, {"field_id": "unsure_cycle_changing", "format": "single_choice", "required": false, "skippable": true, "options": ["yes", "no"], "show_if": {"field_id": "unsure_planning", "in": ["no"]}, "label": "Месячные стали заметно меняться?", "option_labels": {"yes": "Да", "no": "Нет", "not_sure": "Не уверена"}}, {"field_id": "unsure_no_periods", "format": "single_choice", "required": false, "skippable": true, "options": ["yes", "no"], "show_if": {"field_id": "unsure_cycle_changing", "in": ["no"]}, "label": "Месячных нет двенадцать месяцев или дольше?", "option_labels": {"yes": "Да", "no": "Нет", "not_sure": "Не уверена"}}]}], "routing": [{"priority": 10, "when": {"field_id": "pregnancy_status", "in": ["confirmed_by_doctor"]}, "onboarding_key": "pregnancy", "confidence": "HIGH", "substage": "CONFIRMED"}, {"priority": 11, "when": {"field_id": "pregnancy_status", "in": ["test_positive"]}, "onboarding_key": "pregnancy", "confidence": "HIGH", "substage": "TEST_POSITIVE"}, {"priority": 12, "when": {"field_id": "planning_pregnancy_status", "in": ["confirmed"]}, "onboarding_key": "pregnancy", "confidence": "HIGH", "substage": "CONFIRMED"}, {"priority": 13, "when": {"field_id": "unsure_pregnancy", "in": ["confirmed"]}, "onboarding_key": "pregnancy", "confidence": "HIGH", "substage": "CONFIRMED"}, {"priority": 14, "when": {"field_id": "cycle_change_known_cause", "in": ["pregnancy"]}, "onboarding_key": "pregnancy", "confidence": "MEDIUM", "substage": "UNCONFIRMED"}, {"priority": 15, "when": {"field_id": "amenorrhea_known_cause", "in": ["pregnancy"]}, "onboarding_key": "pregnancy", "confidence": "MEDIUM", "substage": "UNCONFIRMED"}, {"priority": 20, "when": {"field_id": "postpartum_time_range", "in": ["lt_1m"]}, "onboarding_key": "postpartum", "confidence": "HIGH", "substage": "LT_1M"}, {"priority": 21, "when": {"field_id": "postpartum_time_range", "in": ["m1_3"]}, "onboarding_key": "postpartum", "confidence": "HIGH", "substage": "M1_3"}, {"priority": 22, "when": {"field_id": "postpartum_time_range", "in": ["m4_6"]}, "onboarding_key": "postpartum", "confidence": "HIGH", "substage": "M4_6"}, {"priority": 23, "when": {"field_id": "postpartum_time_range", "in": ["m7_9"]}, "onboarding_key": "postpartum", "confidence": "HIGH", "substage": "M7_9"}, {"priority": 24, "when": {"field_id": "postpartum_time_range", "in": ["m10_12"]}, "onboarding_key": "postpartum", "confidence": "HIGH", "substage": "M10_12"}, {"priority": 25, "when": {"field_id": "postpartum_main_need", "in": ["recovery"]}, "onboarding_key": "postpartum", "confidence": "MEDIUM", "substage": "EXTENDED_RECOVERY"}, {"priority": 26, "when": {"field_id": "unsure_recent_birth", "in": ["yes"]}, "onboarding_key": "postpartum", "confidence": "MEDIUM", "substage": "UNSPECIFIED"}, {"priority": 27, "when": {"field_id": "cycle_change_known_cause", "in": ["recent_birth_or_breastfeeding"]}, "onboarding_key": "postpartum", "confidence": "MEDIUM", "substage": "UNSPECIFIED"}, {"priority": 28, "when": {"field_id": "amenorrhea_known_cause", "in": ["recent_birth_or_breastfeeding"]}, "onboarding_key": "postpartum", "confidence": "MEDIUM", "substage": "UNSPECIFIED"}, {"priority": 30, "when": {"field_id": "menarche_status", "in": ["not_started"]}, "onboarding_key": "menarche", "confidence": "HIGH", "substage": "PRE_MENARCHE"}, {"priority": 31, "when": {"field_id": "menarche_status", "in": ["very_recent"]}, "onboarding_key": "menarche", "confidence": "HIGH", "substage": "EARLY_MENARCHE"}, {"priority": 32, "when": {"field_id": "menarche_status", "in": ["within_two_years"]}, "onboarding_key": "menarche", "confidence": "HIGH", "substage": "CYCLE_FORMATION"}, {"priority": 33, "when": {"field_id": "menarche_status", "in": ["unsure"]}, "onboarding_key": "menarche", "confidence": "MEDIUM", "substage": "UNCERTAIN_ONSET"}, {"priority": 40, "when": {"field_id": "planning_pregnancy_status", "in": ["no"]}, "onboarding_key": "planning", "confidence": "HIGH", "substage": "PREPARING"}, {"priority": 41, "when": {"field_id": "planning_pregnancy_status", "in": ["maybe"]}, "onboarding_key": "planning", "confidence": "MEDIUM", "substage": "PREPARING", "additional_contexts": ["POSSIBLE_PREGNANCY"]}, {"priority": 42, "when": {"field_id": "postpartum_main_need", "in": ["planning"]}, "onboarding_key": "planning", "confidence": "MEDIUM", "substage": "PREPARING"}, {"priority": 43, "when": {"field_id": "unsure_planning", "in": ["yes"]}, "onboarding_key": "planning", "confidence": "HIGH", "substage": "PREPARING"}, {"priority": 50, "when": {"field_id": "amenorrhea_known_cause", "in": ["doctor_confirmed_menopause"]}, "onboarding_key": "menopause", "confidence": "HIGH", "substage": "CONFIRMED"}, {"priority": 51, "when": {"field_id": "amenorrhea_known_cause", "in": ["no_known_cause"]}, "onboarding_key": "menopause", "confidence": "MEDIUM", "substage": "UNCONFIRMED"}, {"priority": 52, "when": {"field_id": "amenorrhea_known_cause", "in": ["do_not_know"]}, "onboarding_key": "menopause", "confidence": "LOW", "substage": "UNCONFIRMED"}, {"priority": 53, "when": {"field_id": "unsure_no_periods", "in": ["yes"]}, "onboarding_key": "menopause", "confidence": "MEDIUM", "substage": "UNCONFIRMED"}, {"priority": 60, "when": {"field_id": "cycle_change_known_cause", "in": ["doctor_said_perimenopause"]}, "onboarding_key": "perimenopause", "confidence": "HIGH", "substage": "CONFIRMED_CONTEXT"}, {"priority": 61, "when": {"field_id": "cycle_change_known_cause", "in": ["no_known_cause"]}, "onboarding_key": "perimenopause", "confidence": "MEDIUM", "substage": "POSSIBLE"}, {"priority": 62, "when": {"field_id": "cycle_change_known_cause", "in": ["do_not_know"]}, "onboarding_key": "perimenopause", "confidence": "LOW", "substage": "POSSIBLE"}, {"priority": 63, "when": {"field_id": "unsure_cycle_changing", "in": ["yes"]}, "onboarding_key": "perimenopause", "confidence": "MEDIUM", "substage": "POSSIBLE"}, {"priority": 70, "when": {"field_id": "pregnancy_status", "in": ["only_possible"]}, "onboarding_key": "cycle", "confidence": "MEDIUM", "substage": "STANDARD_CYCLE", "additional_contexts": ["POSSIBLE_PREGNANCY"]}, {"priority": 71, "when": {"field_id": "unsure_pregnancy", "in": ["possible"]}, "onboarding_key": "cycle", "confidence": "MEDIUM", "substage": "STANDARD_CYCLE", "additional_contexts": ["POSSIBLE_PREGNANCY"]}, {"priority": 72, "when": {"field_id": "cycle_change_known_cause", "in": ["hormonal", "surgery_or_treatment", "stress_weight_illness"]}, "onboarding_key": "cycle", "confidence": "MEDIUM", "substage": "OBSERVATION_CONTEXT"}, {"priority": 73, "when": {"field_id": "amenorrhea_known_cause", "in": ["hormonal", "surgery_or_treatment"]}, "onboarding_key": "cycle", "confidence": "MEDIUM", "substage": "OBSERVATION_CONTEXT"}, {"priority": 74, "when": {"field_id": "postpartum_main_need", "in": ["cycle"]}, "onboarding_key": "cycle", "confidence": "HIGH", "substage": "STANDARD_CYCLE"}, {"priority": 75, "when": {"field_id": "current_situation", "in": ["cycle_tracking"]}, "onboarding_key": "cycle", "confidence": "HIGH", "substage": "STANDARD_CYCLE"}], "routing_fallback": {"onboarding_key": "cycle", "substage": "STANDARD_CYCLE", "confidence": "LOW"}}'::jsonb,'draft')
on conflict (onboarding_key, version, locale) do update
  set schema = excluded.schema, status = 'draft';

insert into public.onboarding_definitions
  (onboarding_key, life_period, version, locale, schema, status)
values ('lifecycle_router','lifecycle_router',4,'en-US','{"sections": [{"id": "router", "questions": [{"field_id": "display_name", "format": "short_text", "required": false, "skippable": true, "max_length": 60, "profile_column": "first_name", "label": "What should Momna call you?", "hint": "Use your name, a nickname, or any name that feels comfortable."}, {"field_id": "birth_date", "format": "date", "required": false, "skippable": true, "date_constraint": "past_or_today", "min_past_days": 2920, "max_past_days": 27375, "profile_column": "date_of_birth", "label": "When were you born?", "hint": "This helps us show content that fits and is safe for you. Age alone does not decide your life period."}, {"field_id": "menarche_status", "format": "single_choice", "required": true, "skippable": true, "options": ["not_started", "very_recent", "within_two_years", "more_than_two_years", "unsure", "prefer_not_to_say"], "label": "Have you gotten your first period yet?", "option_labels": {"not_started": "No, not yet", "very_recent": "Yes, very recently", "within_two_years": "Yes, within the past two years", "more_than_two_years": "Yes, more than two years ago", "unsure": "I think so, but I''m not sure", "prefer_not_to_say": "I''d rather not answer"}}, {"field_id": "current_situation", "format": "single_choice", "required": true, "skippable": true, "options": ["pregnant", "possible_pregnancy", "recent_birth", "planning", "cycle_tracking", "cycle_changing", "no_periods_12m", "unsure", "prefer_not_to_say"], "show_if": {"field_id": "menarche_status", "in": ["more_than_two_years", "prefer_not_to_say"]}, "label": "Which option best describes what is happening for you right now?", "hint": "Choose what is happening in your life now, not a topic you are simply interested in learning about.", "option_labels": {"pregnant": "I''m pregnant", "possible_pregnancy": "I might be pregnant, but it has not been confirmed", "recent_birth": "I gave birth less than a year ago", "planning": "I''m preparing for pregnancy or trying to conceive", "cycle_tracking": "I track my cycle and how I feel", "cycle_changing": "My periods have changed or become less predictable", "no_periods_12m": "I have not had a period for 12 months or longer", "unsure": "I''m not sure which option fits me", "prefer_not_to_say": "I''d rather not answer"}}, {"field_id": "pregnancy_status", "format": "single_choice", "required": false, "skippable": true, "options": ["confirmed_by_doctor", "test_positive", "only_possible", "not_pregnant", "prefer_not_to_say"], "show_if": {"field_id": "current_situation", "in": ["pregnant", "possible_pregnancy"]}, "label": "What do you currently know about the pregnancy?", "option_labels": {"confirmed_by_doctor": "A healthcare professional has confirmed it", "test_positive": "I had a positive pregnancy test but have not seen a healthcare professional yet", "only_possible": "Pregnancy is possible, but I have not confirmed it", "not_pregnant": "I selected this by mistake; I''m not pregnant", "prefer_not_to_say": "I''d rather not answer"}}, {"field_id": "postpartum_time_range", "format": "single_choice", "required": false, "skippable": true, "options": ["lt_1m", "m1_3", "m4_6", "m7_9", "m10_12", "more_than_year", "prefer_not_to_say"], "show_if": {"field_id": "current_situation", "in": ["recent_birth"]}, "label": "How long has it been since your baby was born?", "hint": "This helps us understand where your recovery is and what stage your baby is at.", "option_labels": {"lt_1m": "Less than a month ago", "m1_3": "1–3 months ago", "m4_6": "4–6 months ago", "m7_9": "7–9 months ago", "m10_12": "10–12 months ago", "more_than_year": "More than a year ago", "prefer_not_to_say": "I''d rather not answer"}}, {"field_id": "postpartum_main_need", "format": "single_choice", "required": false, "skippable": true, "options": ["recovery", "cycle", "planning", "prefer_not_to_say"], "show_if": {"field_id": "postpartum_time_range", "in": ["more_than_year"]}, "label": "What matters most to you right now?", "option_labels": {"recovery": "Recovery after birth", "cycle": "My cycle and everyday life", "planning": "Planning another pregnancy", "prefer_not_to_say": "I''d rather not answer"}}, {"field_id": "planning_pregnancy_status", "format": "single_choice", "required": false, "skippable": true, "options": ["no", "confirmed", "maybe", "prefer_not_to_say"], "show_if": {"field_id": "current_situation", "in": ["planning"]}, "label": "Could you already be pregnant?", "option_labels": {"no": "No", "confirmed": "Yes, the pregnancy has been confirmed", "maybe": "Possibly, but I''m not sure yet", "prefer_not_to_say": "I''d rather not answer"}}, {"field_id": "cycle_change_known_cause", "format": "single_choice", "required": false, "skippable": true, "options": ["pregnancy", "recent_birth_or_breastfeeding", "hormonal", "surgery_or_treatment", "stress_weight_illness", "doctor_said_perimenopause", "no_known_cause", "do_not_know", "prefer_not_to_say"], "show_if": {"field_id": "current_situation", "in": ["cycle_changing"]}, "label": "Is there a known reason for these changes?", "option_labels": {"pregnancy": "Pregnancy", "recent_birth_or_breastfeeding": "Recent childbirth or breastfeeding", "hormonal": "Hormonal birth control or hormone medication", "surgery_or_treatment": "Surgery or medical treatment", "stress_weight_illness": "Major stress, a significant weight change, or an illness", "doctor_said_perimenopause": "A healthcare professional has mentioned perimenopause", "no_known_cause": "No known reason", "do_not_know": "I''m not sure", "prefer_not_to_say": "I''d rather not answer"}}, {"field_id": "amenorrhea_known_cause", "format": "single_choice", "required": false, "skippable": true, "options": ["pregnancy", "recent_birth_or_breastfeeding", "hormonal", "surgery_or_treatment", "doctor_confirmed_menopause", "no_known_cause", "do_not_know", "prefer_not_to_say"], "show_if": {"field_id": "current_situation", "in": ["no_periods_12m"]}, "label": "Is there a known reason you have not had a period?", "option_labels": {"pregnancy": "Pregnancy", "recent_birth_or_breastfeeding": "Recent childbirth or breastfeeding", "hormonal": "Hormonal birth control or hormone medication", "surgery_or_treatment": "Surgery or medical treatment", "doctor_confirmed_menopause": "A healthcare professional has confirmed menopause", "no_known_cause": "No known reason", "do_not_know": "I''m not sure", "prefer_not_to_say": "I''d rather not answer"}}, {"field_id": "unsure_pregnancy", "format": "single_choice", "required": false, "skippable": true, "options": ["confirmed", "possible", "no"], "show_if": {"field_id": "current_situation", "in": ["unsure"]}, "label": "Is pregnancy confirmed or possible?", "option_labels": {"confirmed": "Confirmed", "possible": "Possible", "no": "No"}}, {"field_id": "unsure_recent_birth", "format": "single_choice", "required": false, "skippable": true, "options": ["yes", "no"], "show_if": {"field_id": "unsure_pregnancy", "in": ["no"]}, "label": "Did you give birth within the past year, or are you still recovering from childbirth?", "option_labels": {"yes": "Yes", "no": "No", "not_sure": "Not sure"}}, {"field_id": "unsure_planning", "format": "single_choice", "required": false, "skippable": true, "options": ["yes", "no"], "show_if": {"field_id": "unsure_recent_birth", "in": ["no"]}, "label": "Are you preparing for pregnancy or trying to conceive?", "option_labels": {"yes": "Yes", "no": "No", "not_sure": "Not sure"}}, {"field_id": "unsure_cycle_changing", "format": "single_choice", "required": false, "skippable": true, "options": ["yes", "no"], "show_if": {"field_id": "unsure_planning", "in": ["no"]}, "label": "Have your periods changed noticeably?", "option_labels": {"yes": "Yes", "no": "No", "not_sure": "Not sure"}}, {"field_id": "unsure_no_periods", "format": "single_choice", "required": false, "skippable": true, "options": ["yes", "no"], "show_if": {"field_id": "unsure_cycle_changing", "in": ["no"]}, "label": "Have you gone 12 months or longer without a period?", "option_labels": {"yes": "Yes", "no": "No", "not_sure": "Not sure"}}]}], "routing": [{"priority": 10, "when": {"field_id": "pregnancy_status", "in": ["confirmed_by_doctor"]}, "onboarding_key": "pregnancy", "confidence": "HIGH", "substage": "CONFIRMED"}, {"priority": 11, "when": {"field_id": "pregnancy_status", "in": ["test_positive"]}, "onboarding_key": "pregnancy", "confidence": "HIGH", "substage": "TEST_POSITIVE"}, {"priority": 12, "when": {"field_id": "planning_pregnancy_status", "in": ["confirmed"]}, "onboarding_key": "pregnancy", "confidence": "HIGH", "substage": "CONFIRMED"}, {"priority": 13, "when": {"field_id": "unsure_pregnancy", "in": ["confirmed"]}, "onboarding_key": "pregnancy", "confidence": "HIGH", "substage": "CONFIRMED"}, {"priority": 14, "when": {"field_id": "cycle_change_known_cause", "in": ["pregnancy"]}, "onboarding_key": "pregnancy", "confidence": "MEDIUM", "substage": "UNCONFIRMED"}, {"priority": 15, "when": {"field_id": "amenorrhea_known_cause", "in": ["pregnancy"]}, "onboarding_key": "pregnancy", "confidence": "MEDIUM", "substage": "UNCONFIRMED"}, {"priority": 20, "when": {"field_id": "postpartum_time_range", "in": ["lt_1m"]}, "onboarding_key": "postpartum", "confidence": "HIGH", "substage": "LT_1M"}, {"priority": 21, "when": {"field_id": "postpartum_time_range", "in": ["m1_3"]}, "onboarding_key": "postpartum", "confidence": "HIGH", "substage": "M1_3"}, {"priority": 22, "when": {"field_id": "postpartum_time_range", "in": ["m4_6"]}, "onboarding_key": "postpartum", "confidence": "HIGH", "substage": "M4_6"}, {"priority": 23, "when": {"field_id": "postpartum_time_range", "in": ["m7_9"]}, "onboarding_key": "postpartum", "confidence": "HIGH", "substage": "M7_9"}, {"priority": 24, "when": {"field_id": "postpartum_time_range", "in": ["m10_12"]}, "onboarding_key": "postpartum", "confidence": "HIGH", "substage": "M10_12"}, {"priority": 25, "when": {"field_id": "postpartum_main_need", "in": ["recovery"]}, "onboarding_key": "postpartum", "confidence": "MEDIUM", "substage": "EXTENDED_RECOVERY"}, {"priority": 26, "when": {"field_id": "unsure_recent_birth", "in": ["yes"]}, "onboarding_key": "postpartum", "confidence": "MEDIUM", "substage": "UNSPECIFIED"}, {"priority": 27, "when": {"field_id": "cycle_change_known_cause", "in": ["recent_birth_or_breastfeeding"]}, "onboarding_key": "postpartum", "confidence": "MEDIUM", "substage": "UNSPECIFIED"}, {"priority": 28, "when": {"field_id": "amenorrhea_known_cause", "in": ["recent_birth_or_breastfeeding"]}, "onboarding_key": "postpartum", "confidence": "MEDIUM", "substage": "UNSPECIFIED"}, {"priority": 30, "when": {"field_id": "menarche_status", "in": ["not_started"]}, "onboarding_key": "menarche", "confidence": "HIGH", "substage": "PRE_MENARCHE"}, {"priority": 31, "when": {"field_id": "menarche_status", "in": ["very_recent"]}, "onboarding_key": "menarche", "confidence": "HIGH", "substage": "EARLY_MENARCHE"}, {"priority": 32, "when": {"field_id": "menarche_status", "in": ["within_two_years"]}, "onboarding_key": "menarche", "confidence": "HIGH", "substage": "CYCLE_FORMATION"}, {"priority": 33, "when": {"field_id": "menarche_status", "in": ["unsure"]}, "onboarding_key": "menarche", "confidence": "MEDIUM", "substage": "UNCERTAIN_ONSET"}, {"priority": 40, "when": {"field_id": "planning_pregnancy_status", "in": ["no"]}, "onboarding_key": "planning", "confidence": "HIGH", "substage": "PREPARING"}, {"priority": 41, "when": {"field_id": "planning_pregnancy_status", "in": ["maybe"]}, "onboarding_key": "planning", "confidence": "MEDIUM", "substage": "PREPARING", "additional_contexts": ["POSSIBLE_PREGNANCY"]}, {"priority": 42, "when": {"field_id": "postpartum_main_need", "in": ["planning"]}, "onboarding_key": "planning", "confidence": "MEDIUM", "substage": "PREPARING"}, {"priority": 43, "when": {"field_id": "unsure_planning", "in": ["yes"]}, "onboarding_key": "planning", "confidence": "HIGH", "substage": "PREPARING"}, {"priority": 50, "when": {"field_id": "amenorrhea_known_cause", "in": ["doctor_confirmed_menopause"]}, "onboarding_key": "menopause", "confidence": "HIGH", "substage": "CONFIRMED"}, {"priority": 51, "when": {"field_id": "amenorrhea_known_cause", "in": ["no_known_cause"]}, "onboarding_key": "menopause", "confidence": "MEDIUM", "substage": "UNCONFIRMED"}, {"priority": 52, "when": {"field_id": "amenorrhea_known_cause", "in": ["do_not_know"]}, "onboarding_key": "menopause", "confidence": "LOW", "substage": "UNCONFIRMED"}, {"priority": 53, "when": {"field_id": "unsure_no_periods", "in": ["yes"]}, "onboarding_key": "menopause", "confidence": "MEDIUM", "substage": "UNCONFIRMED"}, {"priority": 60, "when": {"field_id": "cycle_change_known_cause", "in": ["doctor_said_perimenopause"]}, "onboarding_key": "perimenopause", "confidence": "HIGH", "substage": "CONFIRMED_CONTEXT"}, {"priority": 61, "when": {"field_id": "cycle_change_known_cause", "in": ["no_known_cause"]}, "onboarding_key": "perimenopause", "confidence": "MEDIUM", "substage": "POSSIBLE"}, {"priority": 62, "when": {"field_id": "cycle_change_known_cause", "in": ["do_not_know"]}, "onboarding_key": "perimenopause", "confidence": "LOW", "substage": "POSSIBLE"}, {"priority": 63, "when": {"field_id": "unsure_cycle_changing", "in": ["yes"]}, "onboarding_key": "perimenopause", "confidence": "MEDIUM", "substage": "POSSIBLE"}, {"priority": 70, "when": {"field_id": "pregnancy_status", "in": ["only_possible"]}, "onboarding_key": "cycle", "confidence": "MEDIUM", "substage": "STANDARD_CYCLE", "additional_contexts": ["POSSIBLE_PREGNANCY"]}, {"priority": 71, "when": {"field_id": "unsure_pregnancy", "in": ["possible"]}, "onboarding_key": "cycle", "confidence": "MEDIUM", "substage": "STANDARD_CYCLE", "additional_contexts": ["POSSIBLE_PREGNANCY"]}, {"priority": 72, "when": {"field_id": "cycle_change_known_cause", "in": ["hormonal", "surgery_or_treatment", "stress_weight_illness"]}, "onboarding_key": "cycle", "confidence": "MEDIUM", "substage": "OBSERVATION_CONTEXT"}, {"priority": 73, "when": {"field_id": "amenorrhea_known_cause", "in": ["hormonal", "surgery_or_treatment"]}, "onboarding_key": "cycle", "confidence": "MEDIUM", "substage": "OBSERVATION_CONTEXT"}, {"priority": 74, "when": {"field_id": "postpartum_main_need", "in": ["cycle"]}, "onboarding_key": "cycle", "confidence": "HIGH", "substage": "STANDARD_CYCLE"}, {"priority": 75, "when": {"field_id": "current_situation", "in": ["cycle_tracking"]}, "onboarding_key": "cycle", "confidence": "HIGH", "substage": "STANDARD_CYCLE"}], "routing_fallback": {"onboarding_key": "cycle", "substage": "STANDARD_CYCLE", "confidence": "LOW"}}'::jsonb,'draft')
on conflict (onboarding_key, version, locale) do update
  set schema = excluded.schema, status = 'draft';

do $$
declare v_id uuid;
begin
  for v_id in
    select id from public.onboarding_definitions
    where onboarding_key = 'lifecycle_router' and version = 4
  loop
    perform public.publish_onboarding_definition(v_id);
  end loop;
end $$;