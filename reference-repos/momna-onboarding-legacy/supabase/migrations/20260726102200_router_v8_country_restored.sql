-- ============================================================
-- 2200. Роутер, версия 8. Возврат вопроса о стране (country_code).
--
-- НАЙДЕНО В АУДИТЕ. Вопрос был в самой первой версии роутера (v2),
-- но пропал при переходе на генератор для версий 3-7 -- забыт при
-- пересборке, не осознанное решение. Колонка profiles.country и
-- формат country_code всё это время оставались рабочими вхолостую;
-- макет дизайнера всё это время рисовал этот экран верно, бэкенд был
-- не в курсе. Возвращён на прежнее место -- сразу после имени, перед
-- датой рождения.
-- ============================================================

-- ------------------------------------------------------------
-- Более глубокая находка при проверке: формат country_code был
-- известен publish_onboarding_definition (проверка структуры схемы)
-- ещё с первой версии, но НИКОГДА не был подключён к
-- validate_answer_value (проверка при сохранении ответа). Экран мог
-- существовать в опубликованной схеме сколько угодно версий -- ответить
-- на него было физически невозможно ни разу за всю историю: попытка
-- сохранить любое значение падала с unsupported_format. Восстановление
-- вопроса само по себе не чинило эту проблему -- чиню обе сразу.
-- ------------------------------------------------------------

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

    -- extra_options (множественное число) -- восстановлено миграцией 1700.
    -- Было добавлено миграцией 1400 (planning schema), но тот файл
    -- целиком удалили при чистке нумерации после того, как выяснилось,
    -- что он не был применён к базе -- вместе с черновой схемой
    -- planning удалилось и это расширение бэкенда, хотя оно было
    -- самостоятельным, протестированным и не имело отношения к тому,
    -- что схему planning применять было рано. Урок: расширения
    -- механизма и черновые данные периода не должны жить в одном
    -- файле, который могут удалить целиком.
    if (p_question ? 'extra_options') and (p_answer_value ? 'value') then
      if not ((p_question -> 'extra_options') ? (p_answer_value ->> 'value')) then
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

  elsif v_format = 'country_code' then
    -- ДОБАВЛЕНО задним числом (аудит). Формат country_code был известен
    -- publish_onboarding_definition ещё с самой первой версии роутера
    -- (миграция 0800), но никогда не был подключён здесь -- на этапе
    -- сохранения ответа. Вопрос мог существовать в опубликованной
    -- схеме, но ответить на него было физически невозможно ни разу за
    -- всю историю проекта: любая попытка сохранить ответ падала с
    -- unsupported_format. Правило то же, что уже стоит на
    -- profiles.country: два заглавных латинских символа (ISO 3166-1
    -- alpha-2).
    if jsonb_typeof(p_answer_value -> 'value') is distinct from 'string' then
      return 'country_code_requires_string';
    end if;
    if (p_answer_value ->> 'value') !~ '^[A-Z]{2}$' then
      return 'invalid_country_code: ' || (p_answer_value ->> 'value');
    end if;

  else
    return 'unsupported_format: ' || coalesce(v_format, 'null');
  end if;

  return null;
end;
$$;

update public.onboarding_definitions
set status = 'archived'
where onboarding_key = 'lifecycle_router' and version = 7;

insert into public.onboarding_definitions
  (onboarding_key, life_period, version, locale, schema, status)
values ('lifecycle_router','lifecycle_router',8,'ru','{"sections": [{"id": "router", "questions": [{"field_id": "display_name", "format": "short_text", "required": false, "skippable": true, "max_length": 60, "profile_column": "first_name", "label": "Как к тебе обращаться?", "hint": "Имя может быть настоящим, сокращённым или любым удобным обращением."}, {"field_id": "country", "format": "country_code", "required": false, "skippable": true, "profile_column": "country", "label": "Где ты живёшь?", "hint": "Это нужно, чтобы показывать привычные единицы измерения и подходящий региональный контент."}, {"field_id": "birth_date", "format": "date", "required": false, "skippable": true, "date_constraint": "past_or_today", "min_past_days": 2920, "max_past_days": 27375, "profile_column": "date_of_birth", "label": "Когда ты родилась?", "hint": "Это помогает показывать подходящий и безопасный контент. Сам по себе возраст не определяет твой период."}, {"field_id": "menarche_status", "format": "single_choice", "required": true, "skippable": true, "options": ["not_started", "very_recent", "within_two_years", "more_than_two_years", "unsure", "prefer_not_to_say"], "label": "Начались ли у тебя когда-нибудь месячные?", "option_labels": {"not_started": "Нет, ещё не начались", "very_recent": "Да, первые были совсем недавно", "within_two_years": "Да, первые начались в последние два года", "more_than_two_years": "Да, первые начались больше двух лет назад", "unsure": "Кажется, были, но я не уверена", "prefer_not_to_say": "Не хочу отвечать"}}, {"field_id": "current_situation", "format": "single_choice", "required": true, "skippable": true, "options": ["pregnant", "possible_pregnancy", "recent_birth", "planning", "cycle_tracking", "cycle_changing", "no_periods_12m", "unsure", "prefer_not_to_say"], "show_if": {"field_id": "menarche_status", "in": ["more_than_two_years", "prefer_not_to_say"]}, "label": "Что сейчас лучше всего описывает твою ситуацию?", "hint": "Выбери то, что происходит с тобой сейчас, а не тему, о которой тебе просто интересно читать.", "option_labels": {"pregnant": "Я беременна", "possible_pregnancy": "Беременность возможна, но пока не подтверждена", "recent_birth": "Я родила меньше года назад", "planning": "Я готовлюсь или пытаюсь забеременеть", "cycle_tracking": "Я слежу за циклом и своим самочувствием", "cycle_changing": "Месячные стали заметно меняться или пропускаться", "no_periods_12m": "Месячных нет уже двенадцать месяцев или дольше", "unsure": "Я не уверена, какой вариант выбрать", "prefer_not_to_say": "Не хочу отвечать"}}, {"field_id": "pregnancy_status", "format": "single_choice", "required": false, "skippable": true, "options": ["confirmed_by_doctor", "test_positive", "only_possible", "not_pregnant", "prefer_not_to_say"], "show_if": {"field_id": "current_situation", "in": ["pregnant", "possible_pregnancy"]}, "label": "Что сейчас известно о беременности?", "option_labels": {"confirmed_by_doctor": "Беременность подтверждена врачом", "test_positive": "Тест положительный, но у врача ещё не была", "only_possible": "Беременность только возможна", "not_pregnant": "Я ошиблась, беременности нет", "prefer_not_to_say": "Не хочу отвечать"}}, {"field_id": "postpartum_time_range", "format": "single_choice", "required": false, "skippable": true, "options": ["lt_1m", "m1_3", "m4_6", "m7_9", "m10_12", "more_than_year", "prefer_not_to_say"], "show_if": {"field_id": "current_situation", "in": ["recent_birth"]}, "label": "Сколько времени прошло с рождения ребёнка?", "hint": "Это помогает понять, на каком этапе восстановление и что сейчас происходит с малышом.", "option_labels": {"lt_1m": "Меньше месяца назад", "m1_3": "1–3 месяца назад", "m4_6": "4–6 месяцев назад", "m7_9": "7–9 месяцев назад", "m10_12": "10–12 месяцев назад", "more_than_year": "Прошло больше года", "prefer_not_to_say": "Не хочу отвечать"}}, {"field_id": "postpartum_main_need", "format": "single_choice", "required": false, "skippable": true, "options": ["recovery", "cycle", "planning", "prefer_not_to_say"], "show_if": {"field_id": "postpartum_time_range", "in": ["more_than_year"]}, "label": "Что для тебя сейчас важнее всего?", "option_labels": {"recovery": "Восстановление после родов", "cycle": "Цикл и повседневная жизнь", "planning": "Планирование следующей беременности", "prefer_not_to_say": "Не хочу отвечать"}}, {"field_id": "planning_pregnancy_status", "format": "single_choice", "required": false, "skippable": true, "options": ["no", "confirmed", "maybe", "prefer_not_to_say"], "show_if": {"field_id": "current_situation", "in": ["planning"]}, "label": "Беременность уже подтверждена или возможна?", "option_labels": {"no": "Нет", "confirmed": "Да, подтверждена", "maybe": "Возможно, но пока не уверена", "prefer_not_to_say": "Не хочу отвечать"}}, {"field_id": "cycle_change_known_cause", "format": "single_choice", "required": false, "skippable": true, "options": ["pregnancy", "recent_birth_or_breastfeeding", "hormonal", "surgery_or_treatment", "stress_weight_illness", "doctor_said_perimenopause", "no_known_cause", "do_not_know", "prefer_not_to_say"], "show_if": {"field_id": "current_situation", "in": ["cycle_changing"]}, "label": "Есть ли известная причина этих изменений?", "option_labels": {"pregnancy": "Беременность", "recent_birth_or_breastfeeding": "Недавние роды или грудное вскармливание", "hormonal": "Гормональная контрацепция или гормональные препараты", "surgery_or_treatment": "Операция или медицинское лечение", "stress_weight_illness": "Сильный стресс, изменение веса или болезнь", "doctor_said_perimenopause": "Врач говорил о перименопаузе", "no_known_cause": "Известной причины нет", "do_not_know": "Не знаю", "prefer_not_to_say": "Не хочу отвечать"}}, {"field_id": "amenorrhea_known_cause", "format": "single_choice", "required": false, "skippable": true, "options": ["pregnancy", "recent_birth_or_breastfeeding", "hormonal", "ovaries_surgically_removed", "hysterectomy_or_other_treatment", "doctor_confirmed_menopause", "no_known_cause", "do_not_know", "prefer_not_to_say"], "show_if": {"field_id": "current_situation", "in": ["no_periods_12m"]}, "label": "Есть ли известная причина отсутствия месячных?", "option_labels": {"pregnancy": "Беременность", "recent_birth_or_breastfeeding": "Недавние роды или грудное вскармливание", "hormonal": "Гормональная контрацепция или препараты", "ovaries_surgically_removed": "Оба яичника были удалены хирургически", "hysterectomy_or_other_treatment": "Удалена матка (яичники сохранены) или другое лечение", "doctor_confirmed_menopause": "Врач подтвердил менопаузу", "no_known_cause": "Известной причины нет", "do_not_know": "Не знаю", "prefer_not_to_say": "Не хочу отвечать"}}, {"field_id": "unsure_pregnancy", "format": "single_choice", "required": false, "skippable": true, "options": ["confirmed", "possible", "no"], "show_if": {"field_id": "current_situation", "in": ["unsure"]}, "label": "Беременность сейчас подтверждена или возможна?", "option_labels": {"confirmed": "Подтверждена", "possible": "Возможна", "no": "Нет"}}, {"field_id": "unsure_recent_birth", "format": "single_choice", "required": false, "skippable": true, "options": ["yes", "no"], "show_if": {"field_id": "unsure_pregnancy", "in": ["no"]}, "label": "Роды были в течение последнего года или восстановление ещё продолжается?", "option_labels": {"yes": "Да", "no": "Нет", "not_sure": "Не уверена"}}, {"field_id": "unsure_planning", "format": "single_choice", "required": false, "skippable": true, "options": ["yes", "no"], "show_if": {"field_id": "unsure_recent_birth", "in": ["no"]}, "label": "Ты готовишься или пытаешься забеременеть?", "option_labels": {"yes": "Да", "no": "Нет", "not_sure": "Не уверена"}}, {"field_id": "unsure_cycle_changing", "format": "single_choice", "required": false, "skippable": true, "options": ["yes", "no"], "show_if": {"field_id": "unsure_planning", "in": ["no"]}, "label": "Месячные стали заметно меняться?", "option_labels": {"yes": "Да", "no": "Нет", "not_sure": "Не уверена"}}, {"field_id": "unsure_no_periods", "format": "single_choice", "required": false, "skippable": true, "options": ["yes", "no"], "show_if": {"field_id": "unsure_cycle_changing", "in": ["no"]}, "label": "Месячных нет двенадцать месяцев или дольше?", "option_labels": {"yes": "Да", "no": "Нет", "not_sure": "Не уверена"}}]}], "routing": [{"priority": 10, "when": {"field_id": "pregnancy_status", "in": ["confirmed_by_doctor"]}, "onboarding_key": "pregnancy", "confidence": "HIGH", "substage": "CONFIRMED"}, {"priority": 11, "when": {"field_id": "pregnancy_status", "in": ["test_positive"]}, "onboarding_key": "pregnancy", "confidence": "HIGH", "substage": "TEST_POSITIVE"}, {"priority": 12, "when": {"field_id": "planning_pregnancy_status", "in": ["confirmed"]}, "onboarding_key": "pregnancy", "confidence": "HIGH", "substage": "CONFIRMED"}, {"priority": 13, "when": {"field_id": "unsure_pregnancy", "in": ["confirmed"]}, "onboarding_key": "pregnancy", "confidence": "HIGH", "substage": "CONFIRMED"}, {"priority": 14, "when": {"field_id": "cycle_change_known_cause", "in": ["pregnancy"]}, "onboarding_key": "pregnancy", "confidence": "MEDIUM", "substage": "UNCONFIRMED"}, {"priority": 15, "when": {"field_id": "amenorrhea_known_cause", "in": ["pregnancy"]}, "onboarding_key": "pregnancy", "confidence": "MEDIUM", "substage": "UNCONFIRMED"}, {"priority": 20, "when": {"field_id": "postpartum_time_range", "in": ["lt_1m"]}, "onboarding_key": "postpartum", "confidence": "HIGH", "substage": "LT_1M"}, {"priority": 21, "when": {"field_id": "postpartum_time_range", "in": ["m1_3"]}, "onboarding_key": "postpartum", "confidence": "HIGH", "substage": "M1_3"}, {"priority": 22, "when": {"field_id": "postpartum_time_range", "in": ["m4_6"]}, "onboarding_key": "postpartum", "confidence": "HIGH", "substage": "M4_6"}, {"priority": 23, "when": {"field_id": "postpartum_time_range", "in": ["m7_9"]}, "onboarding_key": "postpartum", "confidence": "HIGH", "substage": "M7_9"}, {"priority": 24, "when": {"field_id": "postpartum_time_range", "in": ["m10_12"]}, "onboarding_key": "postpartum", "confidence": "HIGH", "substage": "M10_12"}, {"priority": 25, "when": {"field_id": "postpartum_main_need", "in": ["recovery"]}, "onboarding_key": "postpartum", "confidence": "MEDIUM", "substage": "EXTENDED_RECOVERY"}, {"priority": 26, "when": {"field_id": "unsure_recent_birth", "in": ["yes"]}, "onboarding_key": "postpartum", "confidence": "MEDIUM", "substage": "UNSPECIFIED"}, {"priority": 27, "when": {"field_id": "cycle_change_known_cause", "in": ["recent_birth_or_breastfeeding"]}, "onboarding_key": "postpartum", "confidence": "MEDIUM", "substage": "UNSPECIFIED"}, {"priority": 28, "when": {"field_id": "amenorrhea_known_cause", "in": ["recent_birth_or_breastfeeding"]}, "onboarding_key": "postpartum", "confidence": "MEDIUM", "substage": "UNSPECIFIED"}, {"priority": 30, "when": {"field_id": "menarche_status", "in": ["not_started"]}, "onboarding_key": "menarche", "confidence": "HIGH", "substage": "PRE_MENARCHE"}, {"priority": 31, "when": {"field_id": "menarche_status", "in": ["very_recent"]}, "onboarding_key": "menarche", "confidence": "HIGH", "substage": "EARLY_MENARCHE"}, {"priority": 32, "when": {"field_id": "menarche_status", "in": ["within_two_years"]}, "onboarding_key": "menarche", "confidence": "HIGH", "substage": "CYCLE_FORMATION"}, {"priority": 33, "when": {"field_id": "menarche_status", "in": ["unsure"]}, "onboarding_key": "menarche", "confidence": "MEDIUM", "substage": "UNCERTAIN_ONSET"}, {"priority": 40, "when": {"field_id": "planning_pregnancy_status", "in": ["no"]}, "onboarding_key": "planning", "confidence": "HIGH", "substage": "PREPARING"}, {"priority": 41, "when": {"field_id": "planning_pregnancy_status", "in": ["maybe"]}, "onboarding_key": "planning", "confidence": "MEDIUM", "substage": "PREPARING", "additional_contexts": ["POSSIBLE_PREGNANCY"]}, {"priority": 42, "when": {"field_id": "postpartum_main_need", "in": ["planning"]}, "onboarding_key": "planning", "confidence": "MEDIUM", "substage": "PREPARING"}, {"priority": 43, "when": {"field_id": "unsure_planning", "in": ["yes"]}, "onboarding_key": "planning", "confidence": "HIGH", "substage": "PREPARING"}, {"priority": 44, "when": {"field_id": "planning_pregnancy_status", "in": ["prefer_not_to_say"]}, "onboarding_key": "planning", "confidence": "MEDIUM", "substage": "PREPARING"}, {"priority": 50, "when": {"field_id": "amenorrhea_known_cause", "in": ["doctor_confirmed_menopause"]}, "onboarding_key": "menopause", "confidence": "HIGH", "substage": "CONFIRMED"}, {"priority": 51, "when": {"field_id": "amenorrhea_known_cause", "in": ["no_known_cause"]}, "onboarding_key": "menopause", "confidence": "MEDIUM", "substage": "UNCONFIRMED"}, {"priority": 52, "when": {"field_id": "amenorrhea_known_cause", "in": ["do_not_know"]}, "onboarding_key": "menopause", "confidence": "LOW", "substage": "UNCONFIRMED"}, {"priority": 54, "when": {"field_id": "amenorrhea_known_cause", "in": ["prefer_not_to_say"]}, "onboarding_key": "menopause", "confidence": "LOW", "substage": "UNCONFIRMED"}, {"priority": 53, "when": {"field_id": "unsure_no_periods", "in": ["yes"]}, "onboarding_key": "menopause", "confidence": "MEDIUM", "substage": "UNCONFIRMED"}, {"priority": 60, "when": {"field_id": "cycle_change_known_cause", "in": ["doctor_said_perimenopause"]}, "onboarding_key": "perimenopause", "confidence": "HIGH", "substage": "CONFIRMED_CONTEXT"}, {"priority": 61, "when": {"field_id": "cycle_change_known_cause", "in": ["no_known_cause"]}, "onboarding_key": "perimenopause", "confidence": "MEDIUM", "substage": "POSSIBLE"}, {"priority": 62, "when": {"field_id": "cycle_change_known_cause", "in": ["do_not_know"]}, "onboarding_key": "perimenopause", "confidence": "LOW", "substage": "POSSIBLE"}, {"priority": 63, "when": {"field_id": "unsure_cycle_changing", "in": ["yes"]}, "onboarding_key": "perimenopause", "confidence": "MEDIUM", "substage": "POSSIBLE"}, {"priority": 70, "when": {"field_id": "pregnancy_status", "in": ["only_possible"]}, "onboarding_key": "cycle", "confidence": "MEDIUM", "substage": "STANDARD_CYCLE", "additional_contexts": ["POSSIBLE_PREGNANCY"]}, {"priority": 71, "when": {"field_id": "unsure_pregnancy", "in": ["possible"]}, "onboarding_key": "cycle", "confidence": "MEDIUM", "substage": "STANDARD_CYCLE", "additional_contexts": ["POSSIBLE_PREGNANCY"]}, {"priority": 72, "when": {"field_id": "cycle_change_known_cause", "in": ["hormonal", "surgery_or_treatment", "stress_weight_illness"]}, "onboarding_key": "cycle", "confidence": "MEDIUM", "substage": "OBSERVATION_CONTEXT"}, {"priority": 49, "when": {"field_id": "amenorrhea_known_cause", "in": ["ovaries_surgically_removed"]}, "onboarding_key": "menopause", "confidence": "HIGH", "substage": "CONFIRMED"}, {"priority": 73, "when": {"field_id": "amenorrhea_known_cause", "in": ["hormonal", "hysterectomy_or_other_treatment"]}, "onboarding_key": "cycle", "confidence": "MEDIUM", "substage": "OBSERVATION_CONTEXT"}, {"priority": 74, "when": {"field_id": "postpartum_main_need", "in": ["cycle"]}, "onboarding_key": "cycle", "confidence": "HIGH", "substage": "STANDARD_CYCLE"}, {"priority": 75, "when": {"field_id": "current_situation", "in": ["cycle_tracking"]}, "onboarding_key": "cycle", "confidence": "HIGH", "substage": "STANDARD_CYCLE"}], "routing_fallback": {"onboarding_key": "cycle", "substage": "STANDARD_CYCLE", "confidence": "LOW"}}'::jsonb,'draft')
on conflict (onboarding_key, version, locale) do update
  set schema = excluded.schema, status = 'draft';

insert into public.onboarding_definitions
  (onboarding_key, life_period, version, locale, schema, status)
values ('lifecycle_router','lifecycle_router',8,'en-US','{"sections": [{"id": "router", "questions": [{"field_id": "display_name", "format": "short_text", "required": false, "skippable": true, "max_length": 60, "profile_column": "first_name", "label": "What should Momna call you?", "hint": "Use your name, a nickname, or any name that feels comfortable."}, {"field_id": "country", "format": "country_code", "required": false, "skippable": true, "profile_column": "country", "label": "Where do you live?", "hint": "This lets Momna use the units you''re used to and show content that fits your region."}, {"field_id": "birth_date", "format": "date", "required": false, "skippable": true, "date_constraint": "past_or_today", "min_past_days": 2920, "max_past_days": 27375, "profile_column": "date_of_birth", "label": "When were you born?", "hint": "This helps us show content that fits and is safe for you. Age alone does not decide your life period."}, {"field_id": "menarche_status", "format": "single_choice", "required": true, "skippable": true, "options": ["not_started", "very_recent", "within_two_years", "more_than_two_years", "unsure", "prefer_not_to_say"], "label": "Have you gotten your first period yet?", "option_labels": {"not_started": "No, not yet", "very_recent": "Yes, very recently", "within_two_years": "Yes, within the past two years", "more_than_two_years": "Yes, more than two years ago", "unsure": "I think so, but I''m not sure", "prefer_not_to_say": "I''d rather not answer"}}, {"field_id": "current_situation", "format": "single_choice", "required": true, "skippable": true, "options": ["pregnant", "possible_pregnancy", "recent_birth", "planning", "cycle_tracking", "cycle_changing", "no_periods_12m", "unsure", "prefer_not_to_say"], "show_if": {"field_id": "menarche_status", "in": ["more_than_two_years", "prefer_not_to_say"]}, "label": "Which option best describes what is happening for you right now?", "hint": "Choose what is happening in your life now, not a topic you are simply interested in learning about.", "option_labels": {"pregnant": "I''m pregnant", "possible_pregnancy": "I might be pregnant, but it has not been confirmed", "recent_birth": "I gave birth less than a year ago", "planning": "I''m preparing for pregnancy or trying to conceive", "cycle_tracking": "I track my cycle and how I feel", "cycle_changing": "My periods have changed or become less predictable", "no_periods_12m": "I have not had a period for 12 months or longer", "unsure": "I''m not sure which option fits me", "prefer_not_to_say": "I''d rather not answer"}}, {"field_id": "pregnancy_status", "format": "single_choice", "required": false, "skippable": true, "options": ["confirmed_by_doctor", "test_positive", "only_possible", "not_pregnant", "prefer_not_to_say"], "show_if": {"field_id": "current_situation", "in": ["pregnant", "possible_pregnancy"]}, "label": "What do you currently know about the pregnancy?", "option_labels": {"confirmed_by_doctor": "A healthcare professional has confirmed it", "test_positive": "I had a positive pregnancy test but have not seen a healthcare professional yet", "only_possible": "Pregnancy is possible, but I have not confirmed it", "not_pregnant": "I selected this by mistake; I''m not pregnant", "prefer_not_to_say": "I''d rather not answer"}}, {"field_id": "postpartum_time_range", "format": "single_choice", "required": false, "skippable": true, "options": ["lt_1m", "m1_3", "m4_6", "m7_9", "m10_12", "more_than_year", "prefer_not_to_say"], "show_if": {"field_id": "current_situation", "in": ["recent_birth"]}, "label": "How long has it been since your baby was born?", "hint": "This helps us understand where your recovery is and what stage your baby is at.", "option_labels": {"lt_1m": "Less than a month ago", "m1_3": "1–3 months ago", "m4_6": "4–6 months ago", "m7_9": "7–9 months ago", "m10_12": "10–12 months ago", "more_than_year": "More than a year ago", "prefer_not_to_say": "I''d rather not answer"}}, {"field_id": "postpartum_main_need", "format": "single_choice", "required": false, "skippable": true, "options": ["recovery", "cycle", "planning", "prefer_not_to_say"], "show_if": {"field_id": "postpartum_time_range", "in": ["more_than_year"]}, "label": "What matters most to you right now?", "option_labels": {"recovery": "Recovery after birth", "cycle": "My cycle and everyday life", "planning": "Planning another pregnancy", "prefer_not_to_say": "I''d rather not answer"}}, {"field_id": "planning_pregnancy_status", "format": "single_choice", "required": false, "skippable": true, "options": ["no", "confirmed", "maybe", "prefer_not_to_say"], "show_if": {"field_id": "current_situation", "in": ["planning"]}, "label": "Could you already be pregnant?", "option_labels": {"no": "No", "confirmed": "Yes, the pregnancy has been confirmed", "maybe": "Possibly, but I''m not sure yet", "prefer_not_to_say": "I''d rather not answer"}}, {"field_id": "cycle_change_known_cause", "format": "single_choice", "required": false, "skippable": true, "options": ["pregnancy", "recent_birth_or_breastfeeding", "hormonal", "surgery_or_treatment", "stress_weight_illness", "doctor_said_perimenopause", "no_known_cause", "do_not_know", "prefer_not_to_say"], "show_if": {"field_id": "current_situation", "in": ["cycle_changing"]}, "label": "Is there a known reason for these changes?", "option_labels": {"pregnancy": "Pregnancy", "recent_birth_or_breastfeeding": "Recent childbirth or breastfeeding", "hormonal": "Hormonal birth control or hormone medication", "surgery_or_treatment": "Surgery or medical treatment", "stress_weight_illness": "Major stress, a significant weight change, or an illness", "doctor_said_perimenopause": "A healthcare professional has mentioned perimenopause", "no_known_cause": "No known reason", "do_not_know": "I''m not sure", "prefer_not_to_say": "I''d rather not answer"}}, {"field_id": "amenorrhea_known_cause", "format": "single_choice", "required": false, "skippable": true, "options": ["pregnancy", "recent_birth_or_breastfeeding", "hormonal", "ovaries_surgically_removed", "hysterectomy_or_other_treatment", "doctor_confirmed_menopause", "no_known_cause", "do_not_know", "prefer_not_to_say"], "show_if": {"field_id": "current_situation", "in": ["no_periods_12m"]}, "label": "Is there a known reason you have not had a period?", "option_labels": {"pregnancy": "Pregnancy", "recent_birth_or_breastfeeding": "Recent childbirth or breastfeeding", "hormonal": "Hormonal birth control or hormone medication", "ovaries_surgically_removed": "Both ovaries were surgically removed", "hysterectomy_or_other_treatment": "Hysterectomy with ovaries kept, or another treatment", "doctor_confirmed_menopause": "A healthcare professional has confirmed menopause", "no_known_cause": "No known reason", "do_not_know": "I''m not sure", "prefer_not_to_say": "I''d rather not answer"}}, {"field_id": "unsure_pregnancy", "format": "single_choice", "required": false, "skippable": true, "options": ["confirmed", "possible", "no"], "show_if": {"field_id": "current_situation", "in": ["unsure"]}, "label": "Is pregnancy confirmed or possible?", "option_labels": {"confirmed": "Confirmed", "possible": "Possible", "no": "No"}}, {"field_id": "unsure_recent_birth", "format": "single_choice", "required": false, "skippable": true, "options": ["yes", "no"], "show_if": {"field_id": "unsure_pregnancy", "in": ["no"]}, "label": "Did you give birth within the past year, or are you still recovering from childbirth?", "option_labels": {"yes": "Yes", "no": "No", "not_sure": "Not sure"}}, {"field_id": "unsure_planning", "format": "single_choice", "required": false, "skippable": true, "options": ["yes", "no"], "show_if": {"field_id": "unsure_recent_birth", "in": ["no"]}, "label": "Are you preparing for pregnancy or trying to conceive?", "option_labels": {"yes": "Yes", "no": "No", "not_sure": "Not sure"}}, {"field_id": "unsure_cycle_changing", "format": "single_choice", "required": false, "skippable": true, "options": ["yes", "no"], "show_if": {"field_id": "unsure_planning", "in": ["no"]}, "label": "Have your periods changed noticeably?", "option_labels": {"yes": "Yes", "no": "No", "not_sure": "Not sure"}}, {"field_id": "unsure_no_periods", "format": "single_choice", "required": false, "skippable": true, "options": ["yes", "no"], "show_if": {"field_id": "unsure_cycle_changing", "in": ["no"]}, "label": "Have you gone 12 months or longer without a period?", "option_labels": {"yes": "Yes", "no": "No", "not_sure": "Not sure"}}]}], "routing": [{"priority": 10, "when": {"field_id": "pregnancy_status", "in": ["confirmed_by_doctor"]}, "onboarding_key": "pregnancy", "confidence": "HIGH", "substage": "CONFIRMED"}, {"priority": 11, "when": {"field_id": "pregnancy_status", "in": ["test_positive"]}, "onboarding_key": "pregnancy", "confidence": "HIGH", "substage": "TEST_POSITIVE"}, {"priority": 12, "when": {"field_id": "planning_pregnancy_status", "in": ["confirmed"]}, "onboarding_key": "pregnancy", "confidence": "HIGH", "substage": "CONFIRMED"}, {"priority": 13, "when": {"field_id": "unsure_pregnancy", "in": ["confirmed"]}, "onboarding_key": "pregnancy", "confidence": "HIGH", "substage": "CONFIRMED"}, {"priority": 14, "when": {"field_id": "cycle_change_known_cause", "in": ["pregnancy"]}, "onboarding_key": "pregnancy", "confidence": "MEDIUM", "substage": "UNCONFIRMED"}, {"priority": 15, "when": {"field_id": "amenorrhea_known_cause", "in": ["pregnancy"]}, "onboarding_key": "pregnancy", "confidence": "MEDIUM", "substage": "UNCONFIRMED"}, {"priority": 20, "when": {"field_id": "postpartum_time_range", "in": ["lt_1m"]}, "onboarding_key": "postpartum", "confidence": "HIGH", "substage": "LT_1M"}, {"priority": 21, "when": {"field_id": "postpartum_time_range", "in": ["m1_3"]}, "onboarding_key": "postpartum", "confidence": "HIGH", "substage": "M1_3"}, {"priority": 22, "when": {"field_id": "postpartum_time_range", "in": ["m4_6"]}, "onboarding_key": "postpartum", "confidence": "HIGH", "substage": "M4_6"}, {"priority": 23, "when": {"field_id": "postpartum_time_range", "in": ["m7_9"]}, "onboarding_key": "postpartum", "confidence": "HIGH", "substage": "M7_9"}, {"priority": 24, "when": {"field_id": "postpartum_time_range", "in": ["m10_12"]}, "onboarding_key": "postpartum", "confidence": "HIGH", "substage": "M10_12"}, {"priority": 25, "when": {"field_id": "postpartum_main_need", "in": ["recovery"]}, "onboarding_key": "postpartum", "confidence": "MEDIUM", "substage": "EXTENDED_RECOVERY"}, {"priority": 26, "when": {"field_id": "unsure_recent_birth", "in": ["yes"]}, "onboarding_key": "postpartum", "confidence": "MEDIUM", "substage": "UNSPECIFIED"}, {"priority": 27, "when": {"field_id": "cycle_change_known_cause", "in": ["recent_birth_or_breastfeeding"]}, "onboarding_key": "postpartum", "confidence": "MEDIUM", "substage": "UNSPECIFIED"}, {"priority": 28, "when": {"field_id": "amenorrhea_known_cause", "in": ["recent_birth_or_breastfeeding"]}, "onboarding_key": "postpartum", "confidence": "MEDIUM", "substage": "UNSPECIFIED"}, {"priority": 30, "when": {"field_id": "menarche_status", "in": ["not_started"]}, "onboarding_key": "menarche", "confidence": "HIGH", "substage": "PRE_MENARCHE"}, {"priority": 31, "when": {"field_id": "menarche_status", "in": ["very_recent"]}, "onboarding_key": "menarche", "confidence": "HIGH", "substage": "EARLY_MENARCHE"}, {"priority": 32, "when": {"field_id": "menarche_status", "in": ["within_two_years"]}, "onboarding_key": "menarche", "confidence": "HIGH", "substage": "CYCLE_FORMATION"}, {"priority": 33, "when": {"field_id": "menarche_status", "in": ["unsure"]}, "onboarding_key": "menarche", "confidence": "MEDIUM", "substage": "UNCERTAIN_ONSET"}, {"priority": 40, "when": {"field_id": "planning_pregnancy_status", "in": ["no"]}, "onboarding_key": "planning", "confidence": "HIGH", "substage": "PREPARING"}, {"priority": 41, "when": {"field_id": "planning_pregnancy_status", "in": ["maybe"]}, "onboarding_key": "planning", "confidence": "MEDIUM", "substage": "PREPARING", "additional_contexts": ["POSSIBLE_PREGNANCY"]}, {"priority": 42, "when": {"field_id": "postpartum_main_need", "in": ["planning"]}, "onboarding_key": "planning", "confidence": "MEDIUM", "substage": "PREPARING"}, {"priority": 43, "when": {"field_id": "unsure_planning", "in": ["yes"]}, "onboarding_key": "planning", "confidence": "HIGH", "substage": "PREPARING"}, {"priority": 44, "when": {"field_id": "planning_pregnancy_status", "in": ["prefer_not_to_say"]}, "onboarding_key": "planning", "confidence": "MEDIUM", "substage": "PREPARING"}, {"priority": 50, "when": {"field_id": "amenorrhea_known_cause", "in": ["doctor_confirmed_menopause"]}, "onboarding_key": "menopause", "confidence": "HIGH", "substage": "CONFIRMED"}, {"priority": 51, "when": {"field_id": "amenorrhea_known_cause", "in": ["no_known_cause"]}, "onboarding_key": "menopause", "confidence": "MEDIUM", "substage": "UNCONFIRMED"}, {"priority": 52, "when": {"field_id": "amenorrhea_known_cause", "in": ["do_not_know"]}, "onboarding_key": "menopause", "confidence": "LOW", "substage": "UNCONFIRMED"}, {"priority": 54, "when": {"field_id": "amenorrhea_known_cause", "in": ["prefer_not_to_say"]}, "onboarding_key": "menopause", "confidence": "LOW", "substage": "UNCONFIRMED"}, {"priority": 53, "when": {"field_id": "unsure_no_periods", "in": ["yes"]}, "onboarding_key": "menopause", "confidence": "MEDIUM", "substage": "UNCONFIRMED"}, {"priority": 60, "when": {"field_id": "cycle_change_known_cause", "in": ["doctor_said_perimenopause"]}, "onboarding_key": "perimenopause", "confidence": "HIGH", "substage": "CONFIRMED_CONTEXT"}, {"priority": 61, "when": {"field_id": "cycle_change_known_cause", "in": ["no_known_cause"]}, "onboarding_key": "perimenopause", "confidence": "MEDIUM", "substage": "POSSIBLE"}, {"priority": 62, "when": {"field_id": "cycle_change_known_cause", "in": ["do_not_know"]}, "onboarding_key": "perimenopause", "confidence": "LOW", "substage": "POSSIBLE"}, {"priority": 63, "when": {"field_id": "unsure_cycle_changing", "in": ["yes"]}, "onboarding_key": "perimenopause", "confidence": "MEDIUM", "substage": "POSSIBLE"}, {"priority": 70, "when": {"field_id": "pregnancy_status", "in": ["only_possible"]}, "onboarding_key": "cycle", "confidence": "MEDIUM", "substage": "STANDARD_CYCLE", "additional_contexts": ["POSSIBLE_PREGNANCY"]}, {"priority": 71, "when": {"field_id": "unsure_pregnancy", "in": ["possible"]}, "onboarding_key": "cycle", "confidence": "MEDIUM", "substage": "STANDARD_CYCLE", "additional_contexts": ["POSSIBLE_PREGNANCY"]}, {"priority": 72, "when": {"field_id": "cycle_change_known_cause", "in": ["hormonal", "surgery_or_treatment", "stress_weight_illness"]}, "onboarding_key": "cycle", "confidence": "MEDIUM", "substage": "OBSERVATION_CONTEXT"}, {"priority": 49, "when": {"field_id": "amenorrhea_known_cause", "in": ["ovaries_surgically_removed"]}, "onboarding_key": "menopause", "confidence": "HIGH", "substage": "CONFIRMED"}, {"priority": 73, "when": {"field_id": "amenorrhea_known_cause", "in": ["hormonal", "hysterectomy_or_other_treatment"]}, "onboarding_key": "cycle", "confidence": "MEDIUM", "substage": "OBSERVATION_CONTEXT"}, {"priority": 74, "when": {"field_id": "postpartum_main_need", "in": ["cycle"]}, "onboarding_key": "cycle", "confidence": "HIGH", "substage": "STANDARD_CYCLE"}, {"priority": 75, "when": {"field_id": "current_situation", "in": ["cycle_tracking"]}, "onboarding_key": "cycle", "confidence": "HIGH", "substage": "STANDARD_CYCLE"}], "routing_fallback": {"onboarding_key": "cycle", "substage": "STANDARD_CYCLE", "confidence": "LOW"}}'::jsonb,'draft')
on conflict (onboarding_key, version, locale) do update
  set schema = excluded.schema, status = 'draft';

do $$
declare v_id uuid;
begin
  for v_id in
    select id from public.onboarding_definitions
    where onboarding_key = 'lifecycle_router' and version = 8
  loop
    perform public.publish_onboarding_definition(v_id);
  end loop;
end $$;