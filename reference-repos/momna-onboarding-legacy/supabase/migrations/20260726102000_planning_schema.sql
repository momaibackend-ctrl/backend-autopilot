-- ============================================================
-- 2000. Схема planning (Trying to Conceive) -- ФИНАЛЬНАЯ версия,
-- собранная заново после потери черновика при чистке номеров миграций.
--
-- Источники: 03_Momna_Planning_Questions_US_EN_v3.md и RU-версия,
-- подтверждено скриншотами макета дизайнера как полностью совпадающее.
--
-- Четыре согласованных изменения относительно самого первого черновика:
--   1. PLN_LMP -- было три extra_options, стало два ("I do not
--      remember" / "No periods currently"). "Период идёт сейчас"
--      убран как отдельная кнопка -- это просто сегодняшняя дата
--      в календаре.
--   2. PLN_TREATMENT_EXPECTED_DATE (10a) -- новый условный вопрос
--      про дату от клиники при активном лечении.
--   3. PLN_PARTNER лишился варианта "донорский материал" -- вынесен
--      в отдельный независимый вопрос PLN_DONOR_MATERIAL (15a).
--   4. PLN_SEX_FREQ / PLN_INTIMACY -- список исключений сужен до
--      ВМИ, ЭКО/ИКСИ и подготовки к переносу эмбриона (стимуляция
--      овуляции убрана из исключений).
--
-- extra_options (используется в PLN_LMP и PLN_TREATMENT_EXPECTED_DATE)
-- включён в эту миграцию явно, тем же способом, что и в миграции 1700
-- (перименопауза) -- урок из истории, когда это расширение уже
-- терялось при удалении файла, в котором оно случайно жило вместе
-- с черновыми данными.
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

  else
    return 'unsupported_format: ' || coalesce(v_format, 'null');
  end if;

  return null;
end;
$$;

insert into public.onboarding_definitions
  (onboarding_key, life_period, version, locale, schema, status)
values
  ('planning', 'planning', 1, 'ru', '{"sections": [{"id": "planning", "questions": [{"field_id": "PLN_STAGE", "format": "single_choice", "profile_path": "planning.stage", "options": ["only_thinking", "preparing_next_months", "actively_trying", "fertility_testing", "preparing_treatment", "in_treatment", "not_sure_how_much_tracking"], "option_labels": {"only_thinking": "Пока только думаю о ребёнке", "preparing_next_months": "Хочу подготовиться в ближайшие месяцы", "actively_trying": "Уже пытаемся зачать ребёнка", "fertility_testing": "Прохожу обследования", "preparing_treatment": "Готовлюсь к лечению или вспомогательным репродуктивным технологиям", "in_treatment": "Уже прохожу лечение", "not_sure_how_much_tracking": "Пока не уверена, сколько усилий хочу вкладывать"}, "required": true, "label": "Что лучше описывает твой этап сейчас?"}, {"field_id": "PLN_DURATION", "format": "single_choice", "profile_path": "planning.duration", "show_if": {"field_id": "PLN_STAGE", "in": ["actively_trying"]}, "options": ["first_cycle", "less_than_3m", "3_6m", "6_12m", "more_than_year", "dont_want_to_count", "prefer_not_to_say"], "option_labels": {"first_cycle": "Это первый цикл", "less_than_3m": "Меньше трёх месяцев", "3_6m": "От трёх до шести месяцев", "6_12m": "От шести месяцев до года", "more_than_year": "Больше года", "dont_want_to_count": "Не хочу считать время", "prefer_not_to_say": "Не хочу отвечать"}, "required": true, "label": "Как давно беременность стала твоей активной целью?"}, {"field_id": "PLN_LMP", "format": "date", "profile_path": "planning.lmp_date", "date_constraint": "past_or_today", "max_past_days": 60, "extra_options": ["i_do_not_remember", "not_currently_getting_periods"], "required": true, "label": "Когда начались последние месячные?", "hint": "Это помогает оценить цикл и вероятные фертильные дни.", "extra_option_labels_map": {"i_do_not_remember": "Не помню", "not_currently_getting_periods": "Месячных сейчас нет"}}, {"field_id": "PLN_REGULARITY", "format": "single_choice", "profile_path": "planning.regularity", "options": ["fairly_predictable", "timing_changes", "often_irregular", "no_periods_now", "just_starting", "not_sure", "prefer_not_to_say"], "option_labels": {"fairly_predictable": "Обычно достаточно предсказуем", "timing_changes": "Иногда заметно меняется", "often_irregular": "Часто нерегулярный", "no_periods_now": "Месячных сейчас нет", "just_starting": "Я только начинаю наблюдать", "not_sure": "Не знаю", "prefer_not_to_say": "Не хочу отвечать"}, "required": true, "label": "Насколько предсказуем твой цикл?"}, {"field_id": "PLN_TRACKING", "format": "multi_choice", "profile_path": "planning.tracking_methods", "options": ["calendar", "opk", "bbt", "cervical_mucus", "wearable_device", "clinic_schedule", "not_tracking_yet", "dont_want_measurements"], "option_labels": {"calendar": "Смотрю календарь", "opk": "Использую тесты на овуляцию", "bbt": "Измеряю базальную температуру", "cervical_mucus": "Наблюдаю за выделениями или другими признаками", "wearable_device": "Использую устройство или носимый датчик", "clinic_schedule": "Следую плану врача или клиники", "not_tracking_yet": "Пока никак", "dont_want_measurements": "Не хочу превращать жизнь в постоянные измерения"}, "required": true, "label": "Как ты сейчас определяешь фертильные дни?"}, {"field_id": "PLN_CARE", "format": "single_choice", "profile_path": "planning.care", "options": ["discussed_preconception", "working_with_clinician", "first_appointment_scheduled", "choosing_clinician", "not_sought_yet", "prefer_not_to_say"], "option_labels": {"discussed_preconception": "Уже обсуждала подготовку с врачом", "working_with_clinician": "Наблюдаюсь у врача или в клинике", "first_appointment_scheduled": "Первый приём назначен", "choosing_clinician": "Пока выбираю врача", "not_sought_yet": "Пока не обращалась", "prefer_not_to_say": "Не хочу отвечать"}, "required": true, "label": "Есть ли сейчас медицинская поддержка в планировании?"}, {"field_id": "PLN_PREG_HISTORY", "format": "multi_choice", "profile_path": "planning.pregnancy_history", "sensitivity_level": "highly_sensitive", "required": false, "skippable": true, "options": ["no", "ended_in_birth", "miscarriage", "chose_to_end", "ended_medical_reasons", "ectopic_or_molar", "more_than_one", "prefer_not_to_say"], "option_labels": {"no": "Нет", "ended_in_birth": "Да, завершились родами", "miscarriage": "Беременность прерывалась сама", "chose_to_end": "Беременность была прервана по моему решению", "ended_medical_reasons": "Беременность пришлось прервать по медицинским причинам", "ectopic_or_molar": "Была внематочная или молярная беременность", "more_than_one": "Было несколько разных ситуаций", "prefer_not_to_say": "Не хочу отвечать"}, "label": "Были ли у тебя беременности раньше?"}, {"field_id": "PLN_HISTORY_DETAILS", "format": "multi_choice", "profile_path": "planning.history_details", "sensitivity_level": "health", "required": false, "skippable": true, "show_if": {"not": {"field_id": "PLN_PREG_HISTORY", "selected_any_in": ["no"]}}, "options": ["c_section", "preterm_birth", "high_bp_preeclampsia", "gestational_diabetes", "heavy_blood_loss", "repeated_loss", "procedure_after_pregnancy", "something_else", "no", "not_sure", "prefer_not_to_say"], "option_labels": {"c_section": "Кесарево сечение", "preterm_birth": "Преждевременные роды", "high_bp_preeclampsia": "Высокое давление или преэклампсия", "gestational_diabetes": "Гестационный диабет", "heavy_blood_loss": "Сильная кровопотеря", "repeated_loss": "Повторные потери беременности", "procedure_after_pregnancy": "Операция или процедура после беременности", "something_else": "Другое", "no": "Нет", "not_sure": "Не знаю", "prefer_not_to_say": "Не хочу отвечать"}, "label": "Есть ли в предыдущем опыте что-то, что врач просил учитывать?"}, {"field_id": "PLN_FERTILITY", "format": "multi_choice", "profile_path": "planning.fertility_factors", "sensitivity_level": "health", "required": false, "skippable": true, "options": ["pcos", "endometriosis", "ovulation_problems", "low_ovarian_reserve", "uterus_tubes_condition", "thyroid_condition", "male_factor", "another_reason", "no", "not_tested_yet", "prefer_not_to_say"], "option_labels": {"pcos": "СПКЯ", "endometriosis": "Эндометриоз", "ovulation_problems": "Нарушения овуляции", "low_ovarian_reserve": "Снижение овариального резерва", "uterus_tubes_condition": "Проблемы с маточными трубами или маткой", "thyroid_condition": "Проблемы со щитовидной железой", "male_factor": "Есть мужской фактор", "another_reason": "Другая причина", "no": "Нет", "not_tested_yet": "Обследований пока не было", "prefer_not_to_say": "Не хочу отвечать"}, "label": "Говорил ли врач о факторах, которые могут влиять на зачатие?"}, {"field_id": "PLN_TREATMENT", "format": "multi_choice", "profile_path": "planning.treatment", "sensitivity_level": "health", "options": ["ovulation_induction", "iui", "ivf_icsi", "embryo_transfer_prep", "other_treatment", "testing_only", "no", "prefer_not_to_say"], "option_labels": {"ovulation_induction": "Стимуляция овуляции", "iui": "Внутриматочная инсеминация", "ivf_icsi": "ЭКО или ИКСИ", "embryo_transfer_prep": "Подготовка к переносу эмбриона", "other_treatment": "Другое лечение", "testing_only": "Только обследования", "no": "Нет", "prefer_not_to_say": "Не хочу отвечать"}, "required": true, "label": "Есть ли сейчас лечение или процедуры, которые определяют твой график?"}, {"field_id": "PLN_TREATMENT_EXPECTED_DATE", "format": "date", "profile_path": "planning.treatment_expected_date", "required": false, "skippable": true, "show_if": {"field_id": "PLN_TREATMENT", "selected_any_in": ["ovulation_induction", "iui", "ivf_icsi", "embryo_transfer_prep"]}, "date_constraint": "future_or_today", "max_future_days": 180, "extra_options": ["i_do_not_know_yet"], "label": "Есть ли у тебя ожидаемая дата от клиники?", "hint": "Например, дата переноса эмбриона, дата инсеминации, или дата, которую врач назвал как ожидаемую для результата.", "extra_option_labels_map": {"i_do_not_know_yet": "Пока не знаю / Не хочу отвечать"}}, {"field_id": "PLN_MEDS", "format": "multi_choice", "profile_path": "planning.preparation", "options": ["folic_acid", "iron", "vitamin_d", "clinician_prescribed", "reviewed_meds", "working_on_sleep", "nutrition_attention", "exercise_regularly", "reducing_alcohol", "nothing_specific_yet", "prefer_not_to_say"], "option_labels": {"folic_acid": "Фолиевая кислота или пренатальный витамин", "iron": "Железо", "vitamin_d": "Витамин D", "clinician_prescribed": "Лекарства, назначенные врачом", "reviewed_meds": "Проверила постоянные лекарства с врачом", "working_on_sleep": "Стараюсь наладить сон", "nutrition_attention": "Слежу за питанием", "exercise_regularly": "Регулярно двигаюсь", "reducing_alcohol": "Снижаю алкоголь или отказалась от него", "nothing_specific_yet": "Пока ничего специального", "prefer_not_to_say": "Не хочу отвечать"}, "required": true, "label": "Что уже входит в твою подготовку?"}, {"field_id": "PLN_CONDITIONS", "format": "multi_choice", "profile_path": "planning.health_conditions", "sensitivity_level": "health", "required": false, "skippable": true, "options": ["chronic_condition", "mental_health_condition", "movement_limits", "food_allergies_restrictions", "recent_surgery_treatment", "clinician_special_instructions", "none", "prefer_not_to_say"], "option_labels": {"chronic_condition": "Хроническое заболевание", "mental_health_condition": "Психологическое или психиатрическое состояние", "movement_limits": "Ограничения по движению", "food_allergies_restrictions": "Аллергии или ограничения в питании", "recent_surgery_treatment": "Недавняя операция или лечение", "clinician_special_instructions": "Врач дал особые рекомендации", "none": "Ничего из этого", "prefer_not_to_say": "Не хочу отвечать"}, "label": "Есть ли особенности здоровья или ограничения, которые Momna должна учитывать?"}, {"field_id": "PLN_FAMILY_CONTEXT", "format": "single_choice", "profile_path": "planning.family_context_status", "required": false, "skippable": true, "options": ["testing_complete", "testing_scheduled", "next_step_undecided", "no", "not_discussed_yet", "not_sure", "prefer_not_to_say"], "option_labels": {"testing_complete": "Да, дополнительные обследования уже прошли", "testing_scheduled": "Да, обследование или консультация запланированы", "next_step_undecided": "Да, но следующий шаг пока не определён", "no": "Нет", "not_discussed_yet": "Пока не обсуждали", "not_sure": "Не знаю", "prefer_not_to_say": "Не хочу отвечать"}, "label": "Есть ли в твоей семье или семье партнёра что-то, что врач уже просил учитывать?"}, {"field_id": "PLN_FAMILY_DETAILS", "format": "multi_choice", "profile_path": "planning.family_details", "sensitivity_level": "health", "required": false, "skippable": true, "show_if": {"field_id": "PLN_FAMILY_CONTEXT", "in": ["testing_complete", "testing_scheduled", "next_step_undecided"]}, "options": ["condition_in_several_relatives", "congenital_condition", "developmental_condition", "repeated_loss_or_stillbirth", "genetic_counseling_appointment", "something_else", "dont_know_exact_name", "prefer_not_to_say"], "option_labels": {"condition_in_several_relatives": "Заболевание, которое встречается у нескольких родственников", "congenital_condition": "Врождённая особенность или серьёзное заболевание с рождения", "developmental_condition": "Проблемы с развитием у ребёнка в семье", "repeated_loss_or_stillbirth": "Повторные потери беременности или мертворождения в семье", "genetic_counseling_appointment": "Врач рекомендовал консультацию генетика", "something_else": "Другое", "dont_know_exact_name": "Не знаю точного названия", "prefer_not_to_say": "Не хочу отвечать"}, "label": "Что именно советовали учитывать?"}, {"field_id": "PLN_PARTNER", "format": "single_choice", "profile_path": "person.partner_status", "required": false, "skippable": true, "options": ["steady_partner", "partner_not_living_together", "on_my_own", "complicated_situation", "prefer_not_to_say"], "option_labels": {"steady_partner": "С постоянным партнёром", "partner_not_living_together": "С партнёром, с которым мы не живём вместе", "on_my_own": "Планирую самостоятельно", "complicated_situation": "Ситуация сложнее, и я не хочу её описывать", "prefer_not_to_say": "Не хочу отвечать"}, "label": "Есть ли у тебя сейчас партнёр в этом процессе?"}, {"field_id": "PLN_DONOR_MATERIAL", "format": "single_choice", "profile_path": "planning.donor_material", "required": false, "skippable": true, "options": ["yes", "no", "prefer_not_to_say"], "option_labels": {"yes": "Да", "no": "Нет", "prefer_not_to_say": "Не хочу отвечать"}, "label": "Используете ли вы донорский материал?"}, {"field_id": "PLN_PARTNER_INVOLVEMENT", "format": "single_choice", "profile_path": "person.partner_involvement", "sensitivity_level": "highly_sensitive", "required": false, "skippable": true, "show_if": {"field_id": "PLN_PARTNER", "in": ["steady_partner", "partner_not_living_together"]}, "options": ["share_equally", "supportive_but_planning_on_me", "tries_hard_to_talk", "not_very_involved", "tension", "pressured_unsafe", "prefer_not_to_say"], "option_labels": {"share_equally": "Участвует наравне со мной", "supportive_but_planning_on_me": "Поддерживает, но организационная часть в основном на мне", "tries_hard_to_talk": "Старается, но ему трудно говорить об этом", "not_very_involved": "Участвует мало", "tension": "Между нами есть напряжение из-за планирования", "pressured_unsafe": "Я чувствую давление или небезопасность", "prefer_not_to_say": "Не хочу отвечать"}, "label": "Насколько партнёр участвует в процессе?"}, {"field_id": "PLN_PARTNER_HEALTH", "format": "single_choice", "profile_path": "planning.partner_health", "sensitivity_level": "health", "required": false, "skippable": true, "show_if": {"all": [{"field_id": "PLN_PARTNER", "in": ["steady_partner", "partner_not_living_together"]}, {"field_id": "PLN_STAGE", "in": ["actively_trying"]}]}, "options": ["completed_evaluation", "scheduled", "not_yet", "clinician_said_not_needed", "not_sure", "prefer_not_to_say"], "option_labels": {"completed_evaluation": "Да, уже прошёл нужные обследования", "scheduled": "Приём или обследования запланированы", "not_yet": "Пока не обсуждал", "clinician_said_not_needed": "Врач сказал, что пока это не требуется", "not_sure": "Не знаю", "prefer_not_to_say": "Не хочу отвечать"}, "label": "Обсуждал ли партнёр своё здоровье с врачом в связи с планированием?"}, {"field_id": "PLN_SEX_FREQ", "format": "single_choice", "profile_path": "planning.sex_frequency", "sensitivity_level": "highly_sensitive", "required": false, "skippable": true, "show_if": {"all": [{"field_id": "PLN_PARTNER", "in": ["steady_partner", "partner_not_living_together"]}, {"not": {"field_id": "PLN_TREATMENT", "selected_any_in": ["iui", "ivf_icsi", "embryo_transfer_prep"]}}]}, "options": ["few_times_week", "about_once_week", "few_times_month", "less_often", "varies_a_lot", "prefer_not_to_say"], "option_labels": {"few_times_week": "Несколько раз в неделю", "about_once_week": "Примерно раз в неделю", "few_times_month": "Несколько раз в месяц", "less_often": "Реже", "varies_a_lot": "Частота сильно меняется", "prefer_not_to_say": "Не хочу отвечать"}, "label": "Как часто обычно бывает близость, которая может привести к беременности?"}, {"field_id": "PLN_INTIMACY", "format": "multi_choice", "profile_path": "planning.intimacy", "sensitivity_level": "highly_sensitive", "required": false, "skippable": true, "show_if": {"all": [{"field_id": "PLN_PARTNER", "in": ["steady_partner", "partner_not_living_together"]}, {"not": {"field_id": "PLN_TREATMENT", "selected_any_in": ["iui", "ivf_icsi", "embryo_transfer_prep"]}}]}, "options": ["enjoyable_natural", "scheduled_around_calendar", "feels_like_obligation", "hard_to_relax", "desire_decreased", "pain_discomfort", "want_closeness_not_about_conception", "prefer_not_to_say"], "option_labels": {"enjoyable_natural": "Она остаётся приятной и естественной", "scheduled_around_calendar": "Часто приходится подстраивать её под календарь", "feels_like_obligation": "Иногда она ощущается как обязанность", "hard_to_relax": "Мне трудно расслабиться из-за ожидания результата", "desire_decreased": "Желание снизилось", "pain_discomfort": "Бывает боль или дискомфорт", "want_closeness_not_about_conception": "Мне хотелось бы больше близости вне темы зачатия", "prefer_not_to_say": "Не хочу отвечать"}, "label": "Что лучше описывает вашу близость сейчас?"}, {"field_id": "PLN_SUPPORT", "format": "multi_choice", "profile_path": "planning.support_network", "required": false, "skippable": true, "options": ["family", "friends", "clinician", "therapist_support_group", "no_one_knows", "very_little_support", "prefer_not_to_say"], "option_labels": {"family": "Семья", "friends": "Друзья", "clinician": "Врач или клиника", "therapist_support_group": "Психолог или группа поддержки", "no_one_knows": "Никто не знает о планировании", "very_little_support": "Сейчас почти нет поддержки", "prefer_not_to_say": "Не хочу отвечать"}, "label": "На чью помощь ты можешь рассчитывать, кроме партнёра?"}, {"field_id": "PLN_OCCUPATION", "format": "single_choice", "profile_path": "person.occupation_category", "required": false, "skippable": true, "options": ["work", "student", "manage_household", "not_working_studying", "enter_job", "prefer_not_to_say"], "option_labels": {"work": "Работаю", "student": "Учусь", "manage_household": "Занимаюсь домом или уходом за близкими", "not_working_studying": "Сейчас не работаю и не учусь", "enter_job": "Можно коротко указать профессию или сферу", "prefer_not_to_say": "Не хочу отвечать"}, "label": "Чем ты сейчас занимаешься?"}, {"field_id": "PLN_OCCUPATION_DETAIL", "format": "short_text", "profile_path": "person.occupation_detail", "required": false, "max_length": 80, "show_if": {"field_id": "PLN_OCCUPATION", "in": ["enter_job"]}, "label": "Профессия или сфера"}, {"field_id": "PLN_WORK_NATURE", "format": "multi_choice", "max_select": 2, "profile_path": "person.work_nature", "options": ["mostly_sitting", "on_feet_long", "physically_demanding", "high_emotional_responsibility", "shift_overnight", "traveling_commuting", "can_take_breaks", "hard_to_take_breaks", "every_day_different"], "option_labels": {"mostly_sitting": "В основном сижу", "on_feet_long": "Много времени на ногах", "physically_demanding": "Есть тяжёлая физическая нагрузка", "high_emotional_responsibility": "Высокая эмоциональная ответственность", "shift_overnight": "Работаю по сменам или ночью", "traveling_commuting": "Часто нахожусь в дороге", "can_take_breaks": "Могу свободно делать перерывы", "hard_to_take_breaks": "Почти не могу делать перерывы", "every_day_different": "Каждый день разный"}, "required": true, "label": "Как проходит большая часть твоего дня?"}, {"field_id": "PLN_SLEEP", "format": "single_choice", "profile_path": "person.sleep", "options": ["enough_sleep", "not_enough", "schedule_changes_a_lot", "shift_overnight", "trouble_falling_asleep", "wake_often", "prefer_not_to_say"], "option_labels": {"enough_sleep": "Обычно высыпаюсь", "not_enough": "Сна часто не хватает", "schedule_changes_a_lot": "Режим постоянно меняется", "shift_overnight": "Работаю по сменам или ночью", "trouble_falling_asleep": "Мне трудно заснуть из-за мыслей", "wake_often": "Часто просыпаюсь", "prefer_not_to_say": "Не хочу отвечать"}, "required": true, "label": "Как обычно устроен твой сон?"}, {"field_id": "PLN_LIFESTYLE", "format": "multi_choice", "profile_path": "planning.lifestyle", "required": false, "skippable": true, "options": ["move_regularly", "mostly_inactive", "smoke_nicotine", "drink_alcohol", "irregular_meals", "dietary_restrictions", "rarely_time_for_myself", "none", "prefer_not_to_say"], "option_labels": {"move_regularly": "Регулярно двигаюсь", "mostly_inactive": "Почти не двигаюсь", "smoke_nicotine": "Курю или использую никотин", "drink_alcohol": "Употребляю алкоголь", "irregular_meals": "Питание часто нерегулярное", "dietary_restrictions": "Есть ограничения в питании", "rarely_time_for_myself": "Часто не хватает времени на себя", "none": "Ничего из этого", "prefer_not_to_say": "Не хочу отвечать"}, "label": "Что из этого сейчас относится к твоей жизни?"}, {"field_id": "PLN_MENTAL", "format": "multi_choice", "max_select": 3, "profile_path": "person.emotional_baseline", "sensitivity_level": "health", "options": ["calm", "hopeful", "tired", "anxious", "irritable", "sad", "lonely", "emotions_changed_a_lot", "pregnancy_takes_up_thoughts", "hard_to_tell", "prefer_not_to_say"], "option_labels": {"calm": "Спокойно", "hopeful": "С надеждой", "tired": "Устало", "anxious": "Тревожно", "irritable": "Раздражённо", "sad": "Грустно", "lonely": "Одиноко", "emotions_changed_a_lot": "Эмоции сильно менялись", "pregnancy_takes_up_thoughts": "Тема беременности занимает почти все мысли", "hard_to_tell": "Мне трудно оценить", "prefer_not_to_say": "Не хочу отвечать"}, "required": true, "label": "Как ты чаще всего чувствовала себя в последние две недели?"}, {"field_id": "PLN_PRESSURE", "format": "multi_choice", "max_select": 2, "profile_path": "planning.pressure_points", "sensitivity_level": "health", "options": ["knowing_what_to_do", "not_missing_fertile_window", "constant_waiting", "fear_it_wont_happen", "age_time_pressure", "comments_from_others", "testing_treatment", "relationship_tension", "none_right_now", "prefer_not_to_say"], "option_labels": {"knowing_what_to_do": "Понять, что именно делать", "not_missing_fertile_window": "Не пропустить подходящие дни", "constant_waiting": "Постоянное ожидание", "fear_it_wont_happen": "Страх, что ничего не получится", "age_time_pressure": "Давление возраста или времени", "comments_from_others": "Комментарии окружающих", "testing_treatment": "Обследования и лечение", "relationship_tension": "Напряжение в отношениях", "none_right_now": "Пока ничего из этого", "prefer_not_to_say": "Не хочу отвечать"}, "required": true, "label": "Что сейчас даётся сложнее всего?"}, {"field_id": "PLN_HEALTH_BEHAVIOR", "format": "single_choice", "profile_path": "person.health_info_style", "options": ["want_details", "short_list_next_steps", "need_help_questions", "read_too_much_anxious", "avoid_info_postpone", "not_sure", "prefer_not_to_say"], "option_labels": {"want_details": "Хочу понимать детали и принимать решения вместе с врачом", "short_list_next_steps": "Предпочитаю короткий список действий", "need_help_questions": "Мне нужна помощь подготовить вопросы", "read_too_much_anxious": "Я часто читаю слишком много и тревожусь ещё сильнее", "avoid_info_postpone": "Я избегаю информации и откладываю визиты", "not_sure": "Не знаю", "prefer_not_to_say": "Не хочу отвечать"}, "required": true, "label": "Как тебе легче взаимодействовать с медицинской информацией?"}, {"field_id": "PLN_REST", "format": "multi_choice", "max_select": 3, "profile_path": "person.recovery_activities", "options": ["work_school", "walk", "exercise", "music", "reading_movies_shows", "creative_activities", "time_with_people", "time_alone", "travel_nature", "nothing_helps", "something_else"], "option_labels": {"work_school": "Работа или учёба", "walk": "Прогулка", "exercise": "Спорт", "music": "Музыка", "reading_movies_shows": "Чтение или фильмы", "creative_activities": "Творчество", "time_with_people": "Время с близкими", "time_alone": "Время наедине", "travel_nature": "Поездки или природа", "nothing_helps": "Пока ничего не помогает", "something_else": "Другое"}, "required": true, "label": "Что помогает тебе хотя бы ненадолго перестать думать о попытках зачать?"}, {"field_id": "PLN_BEHAVIOR", "format": "paired_choice", "profile_path": "person.behavior", "rows": [{"row_id": "planning", "options": ["clear_plan", "flexible_suggestions"], "option_labels": {"clear_plan": "Чёткий план", "flexible_suggestions": "Гибкие подсказки"}}, {"row_id": "depth", "options": ["action_first", "explain_first"], "option_labels": {"action_first": "Сначала действие", "explain_first": "Сначала объяснение"}}, {"row_id": "length", "options": ["brief", "detailed"], "option_labels": {"brief": "Коротко", "detailed": "Подробно"}}, {"row_id": "reminders", "options": ["regular_reminders", "only_important_events"], "option_labels": {"regular_reminders": "Регулярные напоминания", "only_important_events": "Только важные события"}}, {"row_id": "steps", "options": ["one_main_step", "few_steps_for_day"], "option_labels": {"one_main_step": "Один главный шаг", "few_steps_for_day": "Несколько шагов на день"}}], "required": true, "label": "Как тебе удобнее получать помощь?"}, {"field_id": "PLN_TONE", "format": "single_choice", "profile_path": "person.communication.tone", "options": ["gentle", "friendly", "close_friend", "direct"], "option_labels": {"gentle": "Бережно — мягко и деликатно, без шуток", "friendly": "По-дружески — живо, просто, иногда с лёгким юмором", "close_friend": "Как своя — неформально, можно шутить и говорить разговорно", "direct": "Прямо — коротко, честно, без сюсюканья"}, "required": true, "label": "Как Momna может с тобой разговаривать?"}]}]}'::jsonb, 'draft')
on conflict (onboarding_key, version, locale) do update
  set schema = excluded.schema, status = 'draft';

insert into public.onboarding_definitions
  (onboarding_key, life_period, version, locale, schema, status)
values
  ('planning', 'planning', 1, 'en-US', '{"sections": [{"id": "planning", "questions": [{"field_id": "PLN_STAGE", "format": "single_choice", "profile_path": "planning.stage", "options": ["only_thinking", "preparing_next_months", "actively_trying", "fertility_testing", "preparing_treatment", "in_treatment", "not_sure_how_much_tracking"], "option_labels": {"only_thinking": "I am only starting to think about having a baby", "preparing_next_months": "I want to prepare over the next few months", "actively_trying": "We are actively trying to conceive", "fertility_testing": "I am having fertility testing", "preparing_treatment": "I am preparing for fertility treatment or assisted reproduction", "in_treatment": "I am currently in treatment", "not_sure_how_much_tracking": "I am not sure how much structure or tracking I want yet"}, "required": true, "label": "Which option best describes where you are right now?"}, {"field_id": "PLN_DURATION", "format": "single_choice", "profile_path": "planning.duration", "show_if": {"field_id": "PLN_STAGE", "in": ["actively_trying"]}, "options": ["first_cycle", "less_than_3m", "3_6m", "6_12m", "more_than_year", "dont_want_to_count", "prefer_not_to_say"], "option_labels": {"first_cycle": "This is the first cycle", "less_than_3m": "Less than 3 months", "3_6m": "3-6 months", "6_12m": "6-12 months", "more_than_year": "More than a year", "dont_want_to_count": "I do not want to track the length of time", "prefer_not_to_say": "Prefer not to answer"}, "required": true, "label": "How long has pregnancy been an active goal for you?"}, {"field_id": "PLN_LMP", "format": "date", "profile_path": "planning.lmp_date", "date_constraint": "past_or_today", "max_past_days": 60, "extra_options": ["i_do_not_remember", "not_currently_getting_periods"], "required": true, "label": "When did your most recent period start?", "hint": "This helps with cycle estimates and possible fertile days.", "extra_option_labels_map": {"i_do_not_remember": "I do not remember", "not_currently_getting_periods": "No periods currently"}}, {"field_id": "PLN_REGULARITY", "format": "single_choice", "profile_path": "planning.regularity", "options": ["fairly_predictable", "timing_changes", "often_irregular", "no_periods_now", "just_starting", "not_sure", "prefer_not_to_say"], "option_labels": {"fairly_predictable": "Usually fairly predictable", "timing_changes": "The timing changes noticeably sometimes", "often_irregular": "Often irregular", "no_periods_now": "I am not currently getting periods", "just_starting": "I am just starting to observe it", "not_sure": "I am not sure", "prefer_not_to_say": "Prefer not to answer"}, "required": true, "label": "How predictable is your cycle?"}, {"field_id": "PLN_TRACKING", "format": "multi_choice", "profile_path": "planning.tracking_methods", "options": ["calendar", "opk", "bbt", "cervical_mucus", "wearable_device", "clinic_schedule", "not_tracking_yet", "dont_want_measurements"], "option_labels": {"calendar": "I use a calendar", "opk": "I use ovulation predictor kits", "bbt": "I track basal body temperature", "cervical_mucus": "I notice cervical mucus or other body signs", "wearable_device": "I use a wearable or connected device", "clinic_schedule": "I follow a schedule from my clinician or fertility clinic", "not_tracking_yet": "I am not tracking yet", "dont_want_measurements": "I do not want my life to revolve around measurements"}, "required": true, "label": "How are you currently identifying fertile days?"}, {"field_id": "PLN_CARE", "format": "single_choice", "profile_path": "planning.care", "options": ["discussed_preconception", "working_with_clinician", "first_appointment_scheduled", "choosing_clinician", "not_sought_yet", "prefer_not_to_say"], "option_labels": {"discussed_preconception": "I have discussed preconception health with a clinician", "working_with_clinician": "I am working with a clinician or fertility clinic", "first_appointment_scheduled": "My first appointment is scheduled", "choosing_clinician": "I am still choosing a clinician", "not_sought_yet": "I have not sought medical support yet", "prefer_not_to_say": "Prefer not to answer"}, "required": true, "label": "What kind of medical support do you have right now?"}, {"field_id": "PLN_PREG_HISTORY", "format": "multi_choice", "profile_path": "planning.pregnancy_history", "sensitivity_level": "highly_sensitive", "required": false, "skippable": true, "options": ["no", "ended_in_birth", "miscarriage", "chose_to_end", "ended_medical_reasons", "ectopic_or_molar", "more_than_one", "prefer_not_to_say"], "option_labels": {"no": "No", "ended_in_birth": "Yes, and the pregnancy ended in birth", "miscarriage": "I had a miscarriage", "chose_to_end": "I chose to end a pregnancy", "ended_medical_reasons": "A pregnancy was ended for medical reasons", "ectopic_or_molar": "I had an ectopic or molar pregnancy", "more_than_one": "I have had more than one of these experiences", "prefer_not_to_say": "Prefer not to answer"}, "label": "Have you ever been pregnant before?"}, {"field_id": "PLN_HISTORY_DETAILS", "format": "multi_choice", "profile_path": "planning.history_details", "sensitivity_level": "health", "required": false, "skippable": true, "show_if": {"not": {"field_id": "PLN_PREG_HISTORY", "selected_any_in": ["no"]}}, "options": ["c_section", "preterm_birth", "high_bp_preeclampsia", "gestational_diabetes", "heavy_blood_loss", "repeated_loss", "procedure_after_pregnancy", "something_else", "no", "not_sure", "prefer_not_to_say"], "option_labels": {"c_section": "C-section", "preterm_birth": "Preterm birth", "high_bp_preeclampsia": "High blood pressure or preeclampsia", "gestational_diabetes": "Gestational diabetes", "heavy_blood_loss": "Heavy blood loss", "repeated_loss": "Repeated pregnancy loss", "procedure_after_pregnancy": "A procedure or surgery after pregnancy", "something_else": "Something else", "no": "No", "not_sure": "I am not sure", "prefer_not_to_say": "Prefer not to answer"}, "label": "Has a clinician asked you to keep anything from a previous pregnancy in mind?"}, {"field_id": "PLN_FERTILITY", "format": "multi_choice", "profile_path": "planning.fertility_factors", "sensitivity_level": "health", "required": false, "skippable": true, "options": ["pcos", "endometriosis", "ovulation_problems", "low_ovarian_reserve", "uterus_tubes_condition", "thyroid_condition", "male_factor", "another_reason", "no", "not_tested_yet", "prefer_not_to_say"], "option_labels": {"pcos": "PCOS", "endometriosis": "Endometriosis", "ovulation_problems": "Ovulation problems", "low_ovarian_reserve": "Low ovarian reserve", "uterus_tubes_condition": "A condition involving the uterus or fallopian tubes", "thyroid_condition": "A thyroid condition", "male_factor": "A male-factor issue", "another_reason": "Another reason", "no": "No", "not_tested_yet": "I have not had testing", "prefer_not_to_say": "Prefer not to answer"}, "label": "Has a clinician identified anything that may affect conception?"}, {"field_id": "PLN_TREATMENT", "format": "multi_choice", "profile_path": "planning.treatment", "sensitivity_level": "health", "options": ["ovulation_induction", "iui", "ivf_icsi", "embryo_transfer_prep", "other_treatment", "testing_only", "no", "prefer_not_to_say"], "option_labels": {"ovulation_induction": "Ovulation induction", "iui": "Intrauterine insemination (IUI)", "ivf_icsi": "IVF or ICSI", "embryo_transfer_prep": "Preparing for an embryo transfer", "other_treatment": "Another fertility treatment", "testing_only": "Testing only", "no": "No", "prefer_not_to_say": "Prefer not to answer"}, "required": true, "label": "Are any treatments or procedures currently shaping your schedule?"}, {"field_id": "PLN_TREATMENT_EXPECTED_DATE", "format": "date", "profile_path": "planning.treatment_expected_date", "required": false, "skippable": true, "show_if": {"field_id": "PLN_TREATMENT", "selected_any_in": ["ovulation_induction", "iui", "ivf_icsi", "embryo_transfer_prep"]}, "date_constraint": "future_or_today", "max_future_days": 180, "extra_options": ["i_do_not_know_yet"], "label": "Does your clinic have an expected date for you?", "hint": "For example, a transfer date, an insemination date, or a date your clinician gave you to expect a result.", "extra_option_labels_map": {"i_do_not_know_yet": "I do not know it yet / Prefer not to answer"}}, {"field_id": "PLN_MEDS", "format": "multi_choice", "profile_path": "planning.preparation", "options": ["folic_acid", "iron", "vitamin_d", "clinician_prescribed", "reviewed_meds", "working_on_sleep", "nutrition_attention", "exercise_regularly", "reducing_alcohol", "nothing_specific_yet", "prefer_not_to_say"], "option_labels": {"folic_acid": "Folic acid or a prenatal vitamin", "iron": "Iron", "vitamin_d": "Vitamin D", "clinician_prescribed": "Medication prescribed by a clinician", "reviewed_meds": "I reviewed my regular medications with a clinician", "working_on_sleep": "I am working on sleep", "nutrition_attention": "I am paying more attention to nutrition", "exercise_regularly": "I exercise or move regularly", "reducing_alcohol": "I am reducing or avoiding alcohol", "nothing_specific_yet": "Nothing specific yet", "prefer_not_to_say": "Prefer not to answer"}, "required": true, "label": "What is already part of your preparation?"}, {"field_id": "PLN_CONDITIONS", "format": "multi_choice", "profile_path": "planning.health_conditions", "sensitivity_level": "health", "required": false, "skippable": true, "options": ["chronic_condition", "mental_health_condition", "movement_limits", "food_allergies_restrictions", "recent_surgery_treatment", "clinician_special_instructions", "none", "prefer_not_to_say"], "option_labels": {"chronic_condition": "A chronic health condition", "mental_health_condition": "A mental health condition", "movement_limits": "Movement or exercise limitations", "food_allergies_restrictions": "Food allergies or dietary restrictions", "recent_surgery_treatment": "Recent surgery or medical treatment", "clinician_special_instructions": "Special instructions from a clinician", "none": "None of these", "prefer_not_to_say": "Prefer not to answer"}, "label": "Are there any health needs or limitations Momna should keep in mind?"}, {"field_id": "PLN_FAMILY_CONTEXT", "format": "single_choice", "profile_path": "planning.family_context_status", "required": false, "skippable": true, "options": ["testing_complete", "testing_scheduled", "next_step_undecided", "no", "not_discussed_yet", "not_sure", "prefer_not_to_say"], "option_labels": {"testing_complete": "Yes, the recommended testing is complete", "testing_scheduled": "Yes, testing or counseling is scheduled", "next_step_undecided": "Yes, but the next step has not been decided", "no": "No", "not_discussed_yet": "We have not discussed this yet", "not_sure": "I am not sure", "prefer_not_to_say": "Prefer not to answer"}, "label": "Has a clinician ever recommended extra testing or counseling because of family history?"}, {"field_id": "PLN_FAMILY_DETAILS", "format": "multi_choice", "profile_path": "planning.family_details", "sensitivity_level": "health", "required": false, "skippable": true, "show_if": {"field_id": "PLN_FAMILY_CONTEXT", "in": ["testing_complete", "testing_scheduled", "next_step_undecided"]}, "options": ["condition_in_several_relatives", "congenital_condition", "developmental_condition", "repeated_loss_or_stillbirth", "genetic_counseling_appointment", "something_else", "dont_know_exact_name", "prefer_not_to_say"], "option_labels": {"condition_in_several_relatives": "A condition that appears in several relatives", "congenital_condition": "A congenital condition or serious illness present from birth", "developmental_condition": "A developmental condition in a child in the family", "repeated_loss_or_stillbirth": "Repeated pregnancy loss or stillbirth in the family", "genetic_counseling_appointment": "A genetic counseling appointment", "something_else": "Something else", "dont_know_exact_name": "I do not know the exact name", "prefer_not_to_say": "Prefer not to answer"}, "label": "What did the clinician recommend keeping in mind?"}, {"field_id": "PLN_PARTNER", "format": "single_choice", "profile_path": "person.partner_status", "required": false, "skippable": true, "options": ["steady_partner", "partner_not_living_together", "on_my_own", "complicated_situation", "prefer_not_to_say"], "option_labels": {"steady_partner": "With a steady partner", "partner_not_living_together": "With a partner I do not live with", "on_my_own": "On my own", "complicated_situation": "My situation is more complicated and I would rather not describe it", "prefer_not_to_say": "Prefer not to answer"}, "label": "Do you currently have a partner in this process?"}, {"field_id": "PLN_DONOR_MATERIAL", "format": "single_choice", "profile_path": "planning.donor_material", "required": false, "skippable": true, "options": ["yes", "no", "prefer_not_to_say"], "option_labels": {"yes": "Yes", "no": "No", "prefer_not_to_say": "Prefer not to answer"}, "label": "Are you using donor sperm, eggs, or embryos?"}, {"field_id": "PLN_PARTNER_INVOLVEMENT", "format": "single_choice", "profile_path": "person.partner_involvement", "sensitivity_level": "highly_sensitive", "required": false, "skippable": true, "show_if": {"field_id": "PLN_PARTNER", "in": ["steady_partner", "partner_not_living_together"]}, "options": ["share_equally", "supportive_but_planning_on_me", "tries_hard_to_talk", "not_very_involved", "tension", "pressured_unsafe", "prefer_not_to_say"], "option_labels": {"share_equally": "We share the process and decisions", "supportive_but_planning_on_me": "They are supportive, but most of the planning falls to me", "tries_hard_to_talk": "They try, but it is hard for them to talk about it", "not_very_involved": "They are not very involved", "tension": "Trying to conceive is creating tension between us", "pressured_unsafe": "I feel pressured or unsafe", "prefer_not_to_say": "Prefer not to answer"}, "label": "How involved is your partner in the process?"}, {"field_id": "PLN_PARTNER_HEALTH", "format": "single_choice", "profile_path": "planning.partner_health", "sensitivity_level": "health", "required": false, "skippable": true, "show_if": {"all": [{"field_id": "PLN_PARTNER", "in": ["steady_partner", "partner_not_living_together"]}, {"field_id": "PLN_STAGE", "in": ["actively_trying"]}]}, "options": ["completed_evaluation", "scheduled", "not_yet", "clinician_said_not_needed", "not_sure", "prefer_not_to_say"], "option_labels": {"completed_evaluation": "Yes, they completed the recommended evaluation", "scheduled": "An appointment or testing is scheduled", "not_yet": "Not yet", "clinician_said_not_needed": "A clinician said it is not needed right now", "not_sure": "I am not sure", "prefer_not_to_say": "Prefer not to answer"}, "label": "Has your partner discussed their health with a clinician as part of this process?"}, {"field_id": "PLN_SEX_FREQ", "format": "single_choice", "profile_path": "planning.sex_frequency", "sensitivity_level": "highly_sensitive", "required": false, "skippable": true, "show_if": {"all": [{"field_id": "PLN_PARTNER", "in": ["steady_partner", "partner_not_living_together"]}, {"not": {"field_id": "PLN_TREATMENT", "selected_any_in": ["iui", "ivf_icsi", "embryo_transfer_prep"]}}]}, "options": ["few_times_week", "about_once_week", "few_times_month", "less_often", "varies_a_lot", "prefer_not_to_say"], "option_labels": {"few_times_week": "A few times a week", "about_once_week": "About once a week", "few_times_month": "A few times a month", "less_often": "Less often", "varies_a_lot": "It varies a lot", "prefer_not_to_say": "Prefer not to answer"}, "label": "How often do you usually have sex that could lead to pregnancy?"}, {"field_id": "PLN_INTIMACY", "format": "multi_choice", "profile_path": "planning.intimacy", "sensitivity_level": "highly_sensitive", "required": false, "skippable": true, "show_if": {"all": [{"field_id": "PLN_PARTNER", "in": ["steady_partner", "partner_not_living_together"]}, {"not": {"field_id": "PLN_TREATMENT", "selected_any_in": ["iui", "ivf_icsi", "embryo_transfer_prep"]}}]}, "options": ["enjoyable_natural", "scheduled_around_calendar", "feels_like_obligation", "hard_to_relax", "desire_decreased", "pain_discomfort", "want_closeness_not_about_conception", "prefer_not_to_say"], "option_labels": {"enjoyable_natural": "It still feels enjoyable and natural", "scheduled_around_calendar": "We often schedule it around the calendar", "feels_like_obligation": "It sometimes feels like an obligation", "hard_to_relax": "It is hard to relax because I am focused on the outcome", "desire_decreased": "My desire has decreased", "pain_discomfort": "I sometimes have pain or discomfort", "want_closeness_not_about_conception": "I would like more closeness that is not about conception", "prefer_not_to_say": "Prefer not to answer"}, "label": "Which statements best describe intimacy right now?"}, {"field_id": "PLN_SUPPORT", "format": "multi_choice", "profile_path": "planning.support_network", "required": false, "skippable": true, "options": ["family", "friends", "clinician", "therapist_support_group", "no_one_knows", "very_little_support", "prefer_not_to_say"], "option_labels": {"family": "Family", "friends": "Friends", "clinician": "A clinician or fertility clinic", "therapist_support_group": "A therapist or support group", "no_one_knows": "No one knows we are trying", "very_little_support": "I have very little support right now", "prefer_not_to_say": "Prefer not to answer"}, "label": "Who can you rely on for support besides a partner?"}, {"field_id": "PLN_OCCUPATION", "format": "single_choice", "profile_path": "person.occupation_category", "required": false, "skippable": true, "options": ["work", "student", "manage_household", "not_working_studying", "enter_job", "prefer_not_to_say"], "option_labels": {"work": "I work", "student": "I am a student", "manage_household": "I manage a household or care for other people", "not_working_studying": "I am not currently working or studying", "enter_job": "Optional: briefly enter your job or field", "prefer_not_to_say": "Prefer not to answer"}, "label": "What best describes what you do right now?"}, {"field_id": "PLN_OCCUPATION_DETAIL", "format": "short_text", "profile_path": "person.occupation_detail", "required": false, "max_length": 80, "show_if": {"field_id": "PLN_OCCUPATION", "in": ["enter_job"]}, "label": "Your job or field"}, {"field_id": "PLN_WORK_NATURE", "format": "multi_choice", "max_select": 2, "profile_path": "person.work_nature", "options": ["mostly_sitting", "on_feet_long", "physically_demanding", "high_emotional_responsibility", "shift_overnight", "traveling_commuting", "can_take_breaks", "hard_to_take_breaks", "every_day_different"], "option_labels": {"mostly_sitting": "Mostly sitting", "on_feet_long": "On my feet for long periods", "physically_demanding": "Physically demanding", "high_emotional_responsibility": "High emotional responsibility", "shift_overnight": "Shift work or overnight work", "traveling_commuting": "Frequently traveling or commuting", "can_take_breaks": "I can take breaks when I need them", "hard_to_take_breaks": "It is very hard to take breaks", "every_day_different": "Every day is different"}, "required": true, "label": "What is most of your day like?"}, {"field_id": "PLN_SLEEP", "format": "single_choice", "profile_path": "person.sleep", "options": ["enough_sleep", "not_enough", "schedule_changes_a_lot", "shift_overnight", "trouble_falling_asleep", "wake_often", "prefer_not_to_say"], "option_labels": {"enough_sleep": "I usually get enough sleep", "not_enough": "I often do not get enough sleep", "schedule_changes_a_lot": "My schedule changes a lot", "shift_overnight": "I work shifts or overnight", "trouble_falling_asleep": "I have trouble falling asleep because my mind is busy", "wake_often": "I wake up often", "prefer_not_to_say": "Prefer not to answer"}, "required": true, "label": "What is sleep usually like for you?"}, {"field_id": "PLN_LIFESTYLE", "format": "multi_choice", "profile_path": "planning.lifestyle", "required": false, "skippable": true, "options": ["move_regularly", "mostly_inactive", "smoke_nicotine", "drink_alcohol", "irregular_meals", "dietary_restrictions", "rarely_time_for_myself", "none", "prefer_not_to_say"], "option_labels": {"move_regularly": "I move or exercise regularly", "mostly_inactive": "I am mostly inactive", "smoke_nicotine": "I smoke or use nicotine", "drink_alcohol": "I drink alcohol", "irregular_meals": "My meals are often irregular", "dietary_restrictions": "I have dietary restrictions", "rarely_time_for_myself": "I rarely have time for myself", "none": "None of these", "prefer_not_to_say": "Prefer not to answer"}, "label": "Which of these are part of your life right now?"}, {"field_id": "PLN_MENTAL", "format": "multi_choice", "max_select": 3, "profile_path": "person.emotional_baseline", "sensitivity_level": "health", "options": ["calm", "hopeful", "tired", "anxious", "irritable", "sad", "lonely", "emotions_changed_a_lot", "pregnancy_takes_up_thoughts", "hard_to_tell", "prefer_not_to_say"], "option_labels": {"calm": "Calm", "hopeful": "Hopeful", "tired": "Tired", "anxious": "Anxious", "irritable": "Irritable", "sad": "Sad", "lonely": "Lonely", "emotions_changed_a_lot": "My emotions changed a lot", "pregnancy_takes_up_thoughts": "Pregnancy is taking up nearly all of my thoughts", "hard_to_tell": "It is hard for me to tell", "prefer_not_to_say": "Prefer not to answer"}, "required": true, "label": "How have you felt most often over the past two weeks?"}, {"field_id": "PLN_PRESSURE", "format": "multi_choice", "max_select": 2, "profile_path": "planning.pressure_points", "sensitivity_level": "health", "options": ["knowing_what_to_do", "not_missing_fertile_window", "constant_waiting", "fear_it_wont_happen", "age_time_pressure", "comments_from_others", "testing_treatment", "relationship_tension", "none_right_now", "prefer_not_to_say"], "option_labels": {"knowing_what_to_do": "Knowing what to do", "not_missing_fertile_window": "Not missing the fertile window", "constant_waiting": "The constant waiting", "fear_it_wont_happen": "Fear that it will not happen", "age_time_pressure": "Pressure related to age or time", "comments_from_others": "Comments from other people", "testing_treatment": "Testing or treatment", "relationship_tension": "Tension in the relationship", "none_right_now": "None of these right now", "prefer_not_to_say": "Prefer not to answer"}, "required": true, "label": "What feels hardest right now?"}, {"field_id": "PLN_HEALTH_BEHAVIOR", "format": "single_choice", "profile_path": "person.health_info_style", "options": ["want_details", "short_list_next_steps", "need_help_questions", "read_too_much_anxious", "avoid_info_postpone", "not_sure", "prefer_not_to_say"], "option_labels": {"want_details": "I want details so I can make decisions with my clinician", "short_list_next_steps": "I prefer a short list of next steps", "need_help_questions": "I need help preparing questions", "read_too_much_anxious": "I read too much and become more anxious", "avoid_info_postpone": "I avoid information and put off appointments", "not_sure": "I am not sure", "prefer_not_to_say": "Prefer not to answer"}, "required": true, "label": "How do you prefer to handle medical information?"}, {"field_id": "PLN_REST", "format": "multi_choice", "max_select": 3, "profile_path": "person.recovery_activities", "options": ["work_school", "walk", "exercise", "music", "reading_movies_shows", "creative_activities", "time_with_people", "time_alone", "travel_nature", "nothing_helps", "something_else"], "option_labels": {"work_school": "Work or school", "walk": "A walk", "exercise": "Exercise", "music": "Music", "reading_movies_shows": "Reading, movies, or shows", "creative_activities": "Creative activities", "time_with_people": "Time with people I care about", "time_alone": "Time alone", "travel_nature": "Travel or nature", "nothing_helps": "Nothing helps much right now", "something_else": "Something else"}, "required": true, "label": "What helps you stop thinking about trying to conceive, even for a moment?"}, {"field_id": "PLN_BEHAVIOR", "format": "paired_choice", "profile_path": "person.behavior", "rows": [{"row_id": "planning", "options": ["clear_plan", "flexible_suggestions"], "option_labels": {"clear_plan": "Clear plan", "flexible_suggestions": "Flexible suggestions"}}, {"row_id": "depth", "options": ["action_first", "explain_first"], "option_labels": {"action_first": "Give me the action first", "explain_first": "Explain it first"}}, {"row_id": "length", "options": ["brief", "detailed"], "option_labels": {"brief": "Brief", "detailed": "Detailed"}}, {"row_id": "reminders", "options": ["regular_reminders", "only_important_events"], "option_labels": {"regular_reminders": "Regular reminders", "only_important_events": "Only important events"}}, {"row_id": "steps", "options": ["one_main_step", "few_steps_for_day"], "option_labels": {"one_main_step": "One main step", "few_steps_for_day": "A few steps for the day"}}], "required": true, "label": "How do you prefer to receive support?"}, {"field_id": "PLN_TONE", "format": "single_choice", "profile_path": "person.communication.tone", "options": ["gentle", "friendly", "close_friend", "direct"], "option_labels": {"gentle": "Gentle - soft and careful, with no jokes", "friendly": "Friendly - natural and easy, with occasional light humor", "close_friend": "Like someone who knows me well - informal, conversational, and okay with jokes", "direct": "Direct - brief, honest, and never overly sweet"}, "required": true, "label": "How can Momna talk with you?"}]}]}'::jsonb, 'draft')
on conflict (onboarding_key, version, locale) do update
  set schema = excluded.schema, status = 'draft';

do $$
declare v_id uuid;
begin
  for v_id in
    select id from public.onboarding_definitions
    where onboarding_key = 'planning' and version = 1
  loop
    perform public.publish_onboarding_definition(v_id);
  end loop;
end $$;