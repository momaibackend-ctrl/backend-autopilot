-- ============================================================
-- 0004. Уточнения после продуктового ревью 23.07.2026
--
-- 1. Нижние границы диапазона дат (min_past_days / min_future_days).
--    Требование по LMP и ПДР: недопустима не только слишком далёкая
--    дата, но и слишком близкая.
--      LMP: не раньше 44 недель назад и не позже 2 недель назад
--           -> date_constraint: past_or_today, max_past_days: 308, min_past_days: 14
--      ПДР: не раньше чем через 1 неделю и не позже 42 недель
--           -> date_constraint: future_or_today, min_future_days: 7, max_future_days: 294
--
-- 2. Возврат в Lifecycle Router из глубокого онбординга.
--    Требование по периоду «Первый год после родов»: при ответе
--    «прошло больше года» онбординг не продолжается, пользовательница
--    возвращается к выбору актуального периода.
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
-- restart_lifecycle_router
-- Мягкий возврат в роутер из незавершённого онбординга периода.
-- Текущая сессия помечается superseded (не abandoned: она прервана
-- осознанно, а не брошена), активный период закрывается, статус
-- профиля откатывается к router_in_progress, создаётся новая
-- сессия роутера.
--
-- Ответы прерванной сессии сохраняются: они остаются историей
-- и могут понадобиться, если пользовательница вернётся в тот же
-- период. Но в новую сессию они не переносятся.
-- ============================================================
create or replace function public.restart_lifecycle_router(
  p_session_id uuid,
  p_locale text
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_onboarding_key text;
  v_router_session uuid;
begin
  if v_user_id is null then
    raise exception 'not_authenticated';
  end if;

  select onboarding_key into v_onboarding_key
  from public.onboarding_sessions
  where id = p_session_id and user_id = v_user_id and status = 'in_progress';

  if v_onboarding_key is null then
    raise exception 'session_not_found_or_not_active';
  end if;
  if v_onboarding_key = 'lifecycle_router' then
    raise exception 'already_in_router';
  end if;

  perform 1 from public.profiles where id = v_user_id for update;

  update public.onboarding_sessions
  set status = 'superseded', last_activity_at = now()
  where id = p_session_id;

  update public.user_lifecycle
  set status = 'ended', ended_at = now()
  where user_id = v_user_id and status = 'active';

  update public.profiles
  set current_life_period = null,
      current_life_substage = null,
      onboarding_status = 'router_in_progress',
      updated_at = now()
  where id = v_user_id;

  -- существующая незавершённая сессия роутера переиспользуется
  select id into v_router_session
  from public.onboarding_sessions
  where user_id = v_user_id and onboarding_key = 'lifecycle_router' and status = 'in_progress';

  if v_router_session is not null then
    return v_router_session;
  end if;

  v_router_session := public.start_onboarding('lifecycle_router', p_locale, null);
  return v_router_session;
end;
$$;

revoke all on function public.restart_lifecycle_router(uuid, text) from public, anon;
grant execute on function public.restart_lifecycle_router(uuid, text) to authenticated;
