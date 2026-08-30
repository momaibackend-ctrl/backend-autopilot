-- ============================================================
-- 1700. Схема perimenopause (RU + en-US).
--
-- Источники: 06_Momna_Perimenopause_Questions_US_EN_v2.md и RU-версия,
-- сверены с финальными макетами дизайнера (7 файлов). Единственное
-- отличие от исходного docx -- вопрос 2 (PERI_LMP): убрана ссылка на
-- дату из роутера (роутер собирает только грубый сигнал об изменении
-- цикла, не дату), вместо неё календарь + две содержательные
-- альтернативы -- "I do not remember" и "I have not had a period
-- for several months". Подтверждено на макете дословно.
--
-- Вопрос 6 (PERI_CONFIRMATION) -- без изменений, уже в исходнике
-- правильно решал главную сложность периода: не требует от женщины
-- самостоятельно ставить себе диагноз, спрашивает только про
-- обращение к врачу, идёт после описания симптомов, а не до него.
-- ============================================================

-- ------------------------------------------------------------
-- Восстановление extra_options в validate_answer_value (см. полное
-- объяснение в комментарии внутри функции ниже). Без этого PERI_LMP
-- не может принять ни "I do not remember", ни "I have not had a
-- period for several months" -- ровно то, что подтверждено на
-- макете дизайнера.
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

  else
    return 'unsupported_format: ' || coalesce(v_format, 'null');
  end if;

  return null;
end;
$$;

insert into public.onboarding_definitions
  (onboarding_key, life_period, version, locale, schema, status)
values
  ('perimenopause', 'perimenopause', 1, 'ru', '{"sections": [{"id": "perimenopause", "questions": [{"field_id": "PERI_CHANGES", "format": "multi_choice", "profile_path": "perimenopause.changes", "options": ["earlier", "later", "skip_some", "much_heavier", "lighter_shorter", "longer_than_usual", "spotting_between", "not_changed_yet", "hormonal_meds_unclear", "prefer_not_to_say"], "option_labels": {"earlier": "Приходят раньше, чем раньше", "later": "Приходят позже, чем раньше", "skip_some": "Иногда пропускаю месячные", "much_heavier": "Стали намного обильнее", "lighter_shorter": "Стали более скудными или короткими", "longer_than_usual": "Некоторые длятся дольше обычного", "spotting_between": "Бывают кровянистые выделения между месячными", "not_changed_yet": "Пока не сильно изменились", "hormonal_meds_unclear": "Гормональные препараты мешают понять", "prefer_not_to_say": "Не хочу отвечать"}, "required": true, "label": "Как изменились твои месячные?"}, {"field_id": "PERI_LMP", "format": "date", "profile_path": "perimenopause.lmp_date", "date_constraint": "past_or_today", "max_past_days": 395, "extra_options": ["i_do_not_remember", "no_period_several_months"], "required": true, "label": "Когда начались последние месячные?", "hint": "Календарь по умолчанию открыт на сегодня, без предвыбранной даты.", "extra_option_labels_map": {"i_do_not_remember": "Не помню", "no_period_several_months": "Месячных не было уже несколько месяцев"}}, {"field_id": "PERI_SYMPTOMS", "format": "multi_choice", "max_select": 5, "profile_path": "perimenopause.symptoms", "sensitivity_level": "health", "options": ["hot_flashes", "night_sweats", "sleep_problems", "fatigue", "irritability", "anxiety", "low_mood", "memory_concentration", "headaches", "palpitations", "joint_pain", "weight_changes", "vaginal_dryness", "sex_drive_changes", "bladder_symptoms", "nothing_much"], "option_labels": {"hot_flashes": "Приливы", "night_sweats": "Ночная потливость", "sleep_problems": "Проблемы со сном", "fatigue": "Усталость", "irritability": "Раздражительность", "anxiety": "Тревожность", "low_mood": "Пониженное настроение", "memory_concentration": "Проблемы с памятью или концентрацией", "headaches": "Головные боли", "palpitations": "Учащённое сердцебиение", "joint_pain": "Боль в мышцах или суставах", "weight_changes": "Изменения веса или телосложения", "vaginal_dryness": "Сухость или дискомфорт во влагалище", "sex_drive_changes": "Изменения либидо", "bladder_symptoms": "Проблемы с мочевым пузырём", "nothing_much": "Пока ничего особенно не беспокоит"}, "required": true, "label": "Какие изменения ты замечаешь сейчас?"}, {"field_id": "PERI_IMPACT", "format": "single_choice", "profile_path": "perimenopause.impact", "options": ["hardly_at_all", "sometimes_manage", "regularly_affect", "major_effect", "varies_day_to_day", "prefer_not_to_say"], "option_labels": {"hardly_at_all": "Почти не влияют", "sometimes_manage": "Иногда, но я справляюсь", "regularly_affect": "Регулярно влияют на сон, работу или отношения", "major_effect": "Сильно влияют на качество жизни", "varies_day_to_day": "Меняется день ото дня", "prefer_not_to_say": "Не хочу отвечать"}, "required": true, "label": "Насколько эти изменения влияют на твою жизнь?"}, {"field_id": "PERI_DAYPART", "format": "multi_choice", "max_select": 2, "profile_path": "perimenopause.daypart", "options": ["morning", "daytime", "evening", "night", "before_during_period", "varies"], "option_labels": {"morning": "Утром", "daytime": "Днём", "evening": "Вечером", "night": "Ночью", "before_during_period": "Перед месячными или во время них", "varies": "Меняется день ото дня"}, "required": true, "label": "Когда симптомы обычно ощущаются сильнее всего?"}, {"field_id": "PERI_CONFIRMATION", "format": "single_choice", "profile_path": "perimenopause.confirmation", "options": ["clinician_said_perimenopause", "yes_cause_unclear", "appointment_scheduled", "not_yet", "prefer_not_to_say"], "option_labels": {"clinician_said_perimenopause": "Да, врач сказал, что это перименопауза", "yes_cause_unclear": "Да, но причина пока не ясна", "appointment_scheduled": "У меня назначен приём", "not_yet": "Пока нет", "prefer_not_to_say": "Не хочу отвечать"}, "required": true, "label": "Обсуждала ли ты эти изменения с врачом?"}, {"field_id": "PERI_TREATMENT", "format": "multi_choice", "profile_path": "perimenopause.treatment", "required": false, "skippable": true, "options": ["nothing_yet", "lifestyle_changes", "vitamins_supplements", "hormone_therapy", "nonhormonal_prescription", "local_vaginal_treatment", "discussing_with_clinician", "prefer_not_to_say"], "option_labels": {"nothing_yet": "Пока ничего", "lifestyle_changes": "Изменения образа жизни", "vitamins_supplements": "Витамины или добавки", "hormone_therapy": "Менопаузальная гормональная терапия", "nonhormonal_prescription": "Негормональный рецептурный препарат", "local_vaginal_treatment": "Местное лечение сухости или дискомфорта", "discussing_with_clinician": "Обсуждаю варианты с врачом", "prefer_not_to_say": "Не хочу отвечать"}, "label": "Используешь ли ты сейчас что-то для облегчения симптомов?"}, {"field_id": "PERI_CONTRACEPTION", "format": "multi_choice", "profile_path": "perimenopause.contraception", "required": false, "skippable": true, "options": ["pills", "hormonal_iud", "copper_iud", "implant_patch_ring_shot", "other_hormonal", "no", "prefer_not_to_say"], "option_labels": {"pills": "Противозачаточные таблетки", "hormonal_iud": "Гормональная ВМС", "copper_iud": "Медная ВМС", "implant_patch_ring_shot": "Имплант, пластырь, кольцо или инъекция", "other_hormonal": "Другой гормональный препарат", "no": "Нет", "prefer_not_to_say": "Не хочу отвечать"}, "label": "Используешь ли ты сейчас контрацепцию или другие гормональные препараты?"}, {"field_id": "PERI_SURGERY", "format": "multi_choice", "profile_path": "perimenopause.surgery", "sensitivity_level": "health", "required": false, "skippable": true, "options": ["hysterectomy", "ovary_removal_one_or_both", "surgery_uterus_ovaries", "cancer_treatment", "another_surgery_treatment", "no", "not_sure", "prefer_not_to_say"], "option_labels": {"hysterectomy": "Удаление матки", "ovary_removal_one_or_both": "Удаление одного или обоих яичников", "surgery_uterus_ovaries": "Операция на матке или яичниках", "cancer_treatment": "Лечение онкологии", "another_surgery_treatment": "Другая операция или лечение", "no": "Нет", "not_sure": "Не уверена", "prefer_not_to_say": "Не хочу отвечать"}, "label": "Были ли у тебя операции или лечение, которые могут влиять на месячные или гормоны?"}, {"field_id": "PERI_REPRO_HISTORY", "format": "multi_choice", "profile_path": "perimenopause.repro_history", "sensitivity_level": "highly_sensitive", "required": false, "skippable": true, "options": ["pregnancy_birth", "c_section", "preterm_complications", "pregnancy_loss", "ended_by_choice_or_medical", "fertility_treatment", "none", "prefer_not_to_say"], "option_labels": {"pregnancy_birth": "Беременность и роды", "c_section": "Кесарево сечение", "preterm_complications": "Преждевременные роды или осложнения беременности", "pregnancy_loss": "Потеря беременности", "ended_by_choice_or_medical": "Беременность была прервана по решению или по медицинским причинам", "fertility_treatment": "Лечение бесплодия", "none": "Ничего из этого", "prefer_not_to_say": "Не хочу отвечать"}, "label": "Есть ли что-то в репродуктивной истории, что Momna стоит учитывать?"}, {"field_id": "PERI_CONDITIONS", "format": "multi_choice", "profile_path": "perimenopause.conditions", "sensitivity_level": "health", "required": false, "skippable": true, "options": ["high_bp_heart", "blood_clots", "diabetes", "migraine", "thyroid", "osteoporosis_low_bone_density", "cancer_history", "mental_health_condition", "something_else", "no", "prefer_not_to_say"], "option_labels": {"high_bp_heart": "Высокое давление или заболевание сердца", "blood_clots": "Тромбы или нарушение свёртываемости", "diabetes": "Диабет", "migraine": "Мигрень", "thyroid": "Заболевание щитовидной железы", "osteoporosis_low_bone_density": "Остеопороз или низкая плотность костей", "cancer_history": "Онкология в прошлом", "mental_health_condition": "Психологическое или психиатрическое состояние", "something_else": "Другое", "no": "Нет", "prefer_not_to_say": "Не хочу отвечать"}, "label": "Просил ли врач учитывать какие-то состояния здоровья при выборе лечения или активности?"}, {"field_id": "PERI_FAMILY", "format": "multi_choice", "profile_path": "perimenopause.family", "sensitivity_level": "health", "required": false, "skippable": true, "options": ["very_early_menopause", "cancer", "blood_clots", "heart_attack_young", "osteoporosis_fractures", "diabetes", "thyroid_disease", "something_else", "dont_know_family_history", "prefer_not_to_say"], "option_labels": {"very_early_menopause": "Очень ранняя менопауза", "cancer": "Рак груди, яичников или матки", "blood_clots": "Тромбы", "heart_attack_young": "Инфаркт или инсульт в молодом возрасте", "osteoporosis_fractures": "Остеопороз или переломы в старшем возрасте", "diabetes": "Диабет", "thyroid_disease": "Заболевание щитовидной железы", "something_else": "Другое", "dont_know_family_history": "Не знаю семейную историю здоровья", "prefer_not_to_say": "Не хочу отвечать"}, "label": "Есть ли в твоей семье что-то, что врач просил учитывать?"}, {"field_id": "PERI_CARE", "format": "single_choice", "profile_path": "perimenopause.care", "options": ["routine_early", "seek_when_interferes", "often_postpone", "hard_to_find_taken_seriously", "bad_experience", "not_sure_which_clinician", "prefer_not_to_say"], "option_labels": {"routine_early": "Слежу за плановыми визитами и обсуждаю изменения рано", "seek_when_interferes": "Обращаюсь, когда симптомы начинают мешать жизни", "often_postpone": "Часто откладываю визиты", "hard_to_find_taken_seriously": "Трудно найти врача, который серьёзно отнесётся к симптомам", "bad_experience": "Был плохой опыт обращения за помощью", "not_sure_which_clinician": "Не уверена, к какому врачу обращаться", "prefer_not_to_say": "Не хочу отвечать"}, "required": true, "label": "Как ты обычно относишься к профилактике и заботе о здоровье?"}, {"field_id": "PERI_OCCUPATION", "format": "single_choice", "profile_path": "person.occupation_category", "required": false, "skippable": true, "options": ["work", "student", "manage_household", "not_working", "enter_job", "prefer_not_to_say"], "option_labels": {"work": "Работаю", "student": "Учусь", "manage_household": "Занимаюсь домом или уходом за близкими", "not_working": "Сейчас не работаю", "enter_job": "Можно коротко указать профессию или сферу", "prefer_not_to_say": "Не хочу отвечать"}, "label": "Чем ты сейчас занимаешься?"}, {"field_id": "PERI_OCCUPATION_DETAIL", "format": "short_text", "profile_path": "person.occupation_detail", "required": false, "max_length": 80, "show_if": {"field_id": "PERI_OCCUPATION", "in": ["enter_job"]}, "label": "Профессия или сфера"}, {"field_id": "PERI_WORK", "format": "multi_choice", "max_select": 2, "profile_path": "person.work_nature", "options": ["mostly_sitting", "on_feet_long", "physically_demanding", "high_emotional_responsibility", "shift_overnight", "traveling_commuting", "can_take_breaks", "hard_to_take_breaks", "caring_for_children_family", "every_day_different"], "option_labels": {"mostly_sitting": "В основном сижу", "on_feet_long": "Много времени на ногах", "physically_demanding": "Физически тяжело", "high_emotional_responsibility": "Высокая эмоциональная ответственность", "shift_overnight": "Работаю по сменам или ночью", "traveling_commuting": "Часто в дороге", "can_take_breaks": "Могу свободно делать перерывы", "hard_to_take_breaks": "Очень трудно сделать перерыв", "caring_for_children_family": "Забочусь о детях или других близких", "every_day_different": "Каждый день по-разному"}, "required": true, "label": "Каким в основном бывает твой день?"}, {"field_id": "PERI_SLEEP", "format": "multi_choice", "max_select": 2, "profile_path": "person.sleep", "options": ["sleep_well", "trouble_falling_asleep", "wake_often", "heat_sweating_wakes", "wake_too_early", "shift_overnight", "caregiving_limits_sleep", "prefer_not_to_say"], "option_labels": {"sleep_well": "В целом сплю хорошо", "trouble_falling_asleep": "Трудно засыпаю", "wake_often": "Часто просыпаюсь", "heat_sweating_wakes": "Просыпаюсь от жара или потливости", "wake_too_early": "Просыпаюсь слишком рано", "shift_overnight": "Работаю по сменам или ночью", "caregiving_limits_sleep": "Забота о близких ограничивает мой сон", "prefer_not_to_say": "Не хочу отвечать"}, "required": true, "label": "Как обстоят дела со сном?"}, {"field_id": "PERI_ACTIVITY", "format": "single_choice", "profile_path": "perimenopause.activity", "options": ["exercise_regularly", "walk_active_daily", "mixed_days", "mostly_inactive", "work_already_demanding", "pain_limits_movement", "prefer_not_to_say"], "option_labels": {"exercise_regularly": "Регулярно занимаюсь спортом", "walk_active_daily": "Много хожу или активна в повседневной жизни", "mixed_days": "В одни дни двигаюсь, в другие подолгу сижу", "mostly_inactive": "В основном малоподвижна", "work_already_demanding": "Работа и так физически тяжёлая", "pain_limits_movement": "Боль или другие ограничения мешают двигаться", "prefer_not_to_say": "Не хочу отвечать"}, "required": true, "label": "Как сейчас выглядят движение и физическая активность?"}, {"field_id": "PERI_LIFESTYLE", "format": "multi_choice", "max_select": 3, "profile_path": "perimenopause.lifestyle", "required": false, "skippable": true, "options": ["irregular_meals", "alcohol", "nicotine", "lot_of_caffeine", "not_enough_time_for_myself", "high_stress", "caring_for_children_relatives", "frequent_travel", "none", "prefer_not_to_say"], "option_labels": {"irregular_meals": "Нерегулярное питание", "alcohol": "Алкоголь", "nicotine": "Никотин", "lot_of_caffeine": "Много кофеина", "not_enough_time_for_myself": "Не хватает времени на себя", "high_stress": "Сильный стресс", "caring_for_children_relatives": "Забота о детях или близких", "frequent_travel": "Частые поездки", "none": "Ничего из этого", "prefer_not_to_say": "Не хочу отвечать"}, "label": "Что из этого заметно влияет на твоё самочувствие?"}, {"field_id": "PERI_MENTAL", "format": "multi_choice", "max_select": 3, "profile_path": "person.emotional_baseline", "sensitivity_level": "health", "options": ["calm", "tired", "irritable", "anxious", "sad", "overwhelmed", "hard_to_concentrate", "unlike_myself", "emotions_change_a_lot", "prefer_not_to_say"], "option_labels": {"calm": "Спокойно", "tired": "Устало", "irritable": "Раздражённо", "anxious": "Тревожно", "sad": "Грустно", "overwhelmed": "Перегруженно", "hard_to_concentrate": "Трудно концентрироваться", "unlike_myself": "Как будто сама на себя не похожа или теряю контроль", "emotions_change_a_lot": "Эмоции сильно меняются", "prefer_not_to_say": "Не хочу отвечать"}, "required": true, "label": "Что ты чувствовала чаще всего за последние две недели?"}, {"field_id": "PERI_COPING", "format": "multi_choice", "max_select": 3, "profile_path": "person.coping", "options": ["clear_plan", "talking_trusted", "facts_explanations", "movement", "sleep_quiet", "humor", "work_staying_busy", "time_alone", "nothing_helps", "something_else"], "option_labels": {"clear_plan": "Чёткий план", "talking_trusted": "Разговор с близким", "facts_explanations": "Факты и объяснения", "movement": "Движение", "sleep_quiet": "Сон или тишина", "humor": "Юмор", "work_staying_busy": "Работа или занятость", "time_alone": "Время наедине", "nothing_helps": "Пока ничего особо не помогает", "something_else": "Другое"}, "required": true, "label": "Что обычно помогает в трудные дни?"}, {"field_id": "PERI_PARTNER", "format": "single_choice", "profile_path": "person.partner_status", "required": false, "skippable": true, "options": ["live_together", "not_living_together", "casual_multiple", "no_partner", "prefer_not_to_say"], "option_labels": {"live_together": "Да, мы живём вместе", "not_living_together": "Да, но мы не живём вместе", "casual_multiple": "Несколько партнёров или несерьёзные отношения", "no_partner": "Сейчас партнёра нет", "prefer_not_to_say": "Не хочу отвечать"}, "label": "Есть ли у тебя сейчас партнёр?"}, {"field_id": "PERI_PARTNER_SUPPORT", "format": "single_choice", "profile_path": "person.partner_support", "sensitivity_level": "highly_sensitive", "required": false, "skippable": true, "show_if": {"field_id": "PERI_PARTNER", "in": ["live_together", "not_living_together", "casual_multiple"]}, "options": ["understands_supports", "tries_doesnt_know_how", "hard_to_explain", "doesnt_take_seriously", "relationship_more_tense", "pressured_unsafe", "prefer_not_to_say"], "option_labels": {"understands_supports": "Понимает и хорошо поддерживает", "tries_doesnt_know_how": "Старается, но не знает, как помочь", "hard_to_explain": "Мне трудно объяснить, что происходит", "doesnt_take_seriously": "Не относится к этому серьёзно", "relationship_more_tense": "В отношениях стало напряжённее", "pressured_unsafe": "Я чувствую давление или небезопасность", "prefer_not_to_say": "Не хочу отвечать"}, "label": "Насколько хорошо партнёр понимает происходящие с тобой изменения?"}, {"field_id": "PERI_SEX_ACTIVE", "format": "single_choice", "profile_path": "perimenopause.sexual_activity", "sensitivity_level": "highly_sensitive", "required": false, "skippable": true, "options": ["yes_regularly", "sometimes", "not_right_now", "prefer_not_to_say"], "option_labels": {"yes_regularly": "Да, регулярно", "sometimes": "Иногда", "not_right_now": "Сейчас нет", "prefer_not_to_say": "Не хочу отвечать"}, "label": "Есть ли в твоей жизни сейчас сексуальная близость?"}, {"field_id": "PERI_SEX_FREQ", "format": "single_choice", "profile_path": "perimenopause.sex_frequency", "sensitivity_level": "highly_sensitive", "required": false, "skippable": true, "show_if": {"field_id": "PERI_SEX_ACTIVE", "in": ["yes_regularly", "sometimes"]}, "options": ["few_times_week", "about_once_week", "few_times_month", "less_often", "varies_a_lot", "prefer_not_to_say"], "option_labels": {"few_times_week": "Несколько раз в неделю", "about_once_week": "Примерно раз в неделю", "few_times_month": "Несколько раз в месяц", "less_often": "Реже", "varies_a_lot": "Сильно варьируется", "prefer_not_to_say": "Не хочу отвечать"}, "label": "Как часто у тебя обычно секс или интимный контакт?"}, {"field_id": "PERI_INTIMACY", "format": "multi_choice", "profile_path": "perimenopause.intimacy", "sensitivity_level": "highly_sensitive", "required": false, "skippable": true, "show_if": {"field_id": "PERI_SEX_ACTIVE", "in": ["yes_regularly", "sometimes"]}, "options": ["comfortable", "desire_decreased", "desire_unpredictable", "dryness_pain", "harder_to_relax", "less_confident_in_body", "want_more_affection", "want_help_talking", "not_important_now", "prefer_not_to_say"], "option_labels": {"comfortable": "Меня всё устраивает", "desire_decreased": "Желание снизилось", "desire_unpredictable": "Желание стало непредсказуемым", "dryness_pain": "Бывает сухость или боль", "harder_to_relax": "Стало труднее расслабиться", "less_confident_in_body": "Чувствую себя менее уверенно в своём теле", "want_more_affection": "Хотела бы больше нежности и близости", "want_help_talking": "Хотела бы помощи в разговоре с партнёром", "not_important_now": "Секс сейчас не важен для меня", "prefer_not_to_say": "Не хочу отвечать"}, "label": "Какие утверждения лучше всего описывают твою интимную жизнь сейчас?"}, {"field_id": "PERI_SUPPORT", "format": "multi_choice", "profile_path": "perimenopause.support_network", "required": false, "skippable": true, "options": ["partner", "family", "friends", "clinician", "therapist_support_group", "very_little_support", "prefer_not_to_say"], "option_labels": {"partner": "Партнёр", "family": "Семья", "friends": "Друзья", "clinician": "Врач", "therapist_support_group": "Психолог или группа поддержки", "very_little_support": "Сейчас почти нет поддержки", "prefer_not_to_say": "Не хочу отвечать"}, "label": "На кого ты можешь рассчитывать?"}, {"field_id": "PERI_REST", "format": "multi_choice", "max_select": 3, "profile_path": "person.recovery_activities", "options": ["walking_nature", "exercise", "music", "reading", "creative_activities", "spending_time_with_people", "time_alone", "travel", "personal_care", "not_sure_yet", "something_else"], "option_labels": {"walking_nature": "Прогулки или время на природе", "exercise": "Спорт", "music": "Музыка", "reading": "Чтение", "creative_activities": "Творчество", "spending_time_with_people": "Время с людьми", "time_alone": "Время наедине", "travel": "Путешествия", "personal_care": "Уход за собой", "not_sure_yet": "Пока не уверена", "something_else": "Другое"}, "required": true, "label": "Каким занятиям тебе хотелось бы снова уделять больше времени?"}, {"field_id": "PERI_BEHAVIOR", "format": "paired_choice", "profile_path": "person.behavior", "rows": [{"row_id": "planning", "options": ["clear_plan", "flexible_suggestions"], "option_labels": {"clear_plan": "Чёткий план", "flexible_suggestions": "Гибкие подсказки"}}, {"row_id": "depth", "options": ["action_first", "explain_first"], "option_labels": {"action_first": "Сначала действие", "explain_first": "Сначала объяснение"}}, {"row_id": "length", "options": ["brief", "detailed"], "option_labels": {"brief": "Коротко", "detailed": "Подробно"}}, {"row_id": "reminders", "options": ["regular_reminders", "only_important_events"], "option_labels": {"regular_reminders": "Регулярные напоминания", "only_important_events": "Только важные события"}}, {"row_id": "steps", "options": ["one_main_step", "few_steps_for_day"], "option_labels": {"one_main_step": "Один главный шаг", "few_steps_for_day": "Несколько шагов на день"}}], "required": true, "label": "Как тебе удобнее получать поддержку?"}, {"field_id": "PERI_TONE", "format": "single_choice", "profile_path": "person.communication.tone", "options": ["gentle", "friendly", "close_friend", "direct"], "option_labels": {"gentle": "Бережно — мягко и деликатно, без шуток", "friendly": "По-дружески — живо, просто, иногда с лёгким юмором", "close_friend": "Как своя — неформально, можно шутить и говорить разговорно", "direct": "Прямо — коротко, честно, без сюсюканья"}, "required": true, "label": "Как Momna может с тобой разговаривать?"}]}]}'::jsonb, 'draft')
on conflict (onboarding_key, version, locale) do update
  set schema = excluded.schema, status = 'draft';

insert into public.onboarding_definitions
  (onboarding_key, life_period, version, locale, schema, status)
values
  ('perimenopause', 'perimenopause', 1, 'en-US', '{"sections": [{"id": "perimenopause", "questions": [{"field_id": "PERI_CHANGES", "format": "multi_choice", "profile_path": "perimenopause.changes", "options": ["earlier", "later", "skip_some", "much_heavier", "lighter_shorter", "longer_than_usual", "spotting_between", "not_changed_yet", "hormonal_meds_unclear", "prefer_not_to_say"], "option_labels": {"earlier": "They come earlier than they used to", "later": "They come later than they used to", "skip_some": "I skip some periods", "much_heavier": "Bleeding has become much heavier", "lighter_shorter": "Bleeding has become lighter or shorter", "longer_than_usual": "Some periods last longer than usual", "spotting_between": "I have spotting or bleeding between periods", "not_changed_yet": "They have not changed much yet", "hormonal_meds_unclear": "Hormonal medication makes it hard to tell", "prefer_not_to_say": "Prefer not to answer"}, "required": true, "label": "How have your periods changed?"}, {"field_id": "PERI_LMP", "format": "date", "profile_path": "perimenopause.lmp_date", "date_constraint": "past_or_today", "max_past_days": 395, "extra_options": ["i_do_not_remember", "no_period_several_months"], "required": true, "label": "When did your most recent period start?", "hint": "Calendar defaults to today, no date preselected.", "extra_option_labels_map": {"i_do_not_remember": "I do not remember", "no_period_several_months": "I have not had a period for several months"}}, {"field_id": "PERI_SYMPTOMS", "format": "multi_choice", "max_select": 5, "profile_path": "perimenopause.symptoms", "sensitivity_level": "health", "options": ["hot_flashes", "night_sweats", "sleep_problems", "fatigue", "irritability", "anxiety", "low_mood", "memory_concentration", "headaches", "palpitations", "joint_pain", "weight_changes", "vaginal_dryness", "sex_drive_changes", "bladder_symptoms", "nothing_much"], "option_labels": {"hot_flashes": "Hot flashes", "night_sweats": "Night sweats", "sleep_problems": "Sleep problems", "fatigue": "Fatigue", "irritability": "Irritability", "anxiety": "Anxiety", "low_mood": "Low mood", "memory_concentration": "Memory or concentration problems", "headaches": "Headaches", "palpitations": "Heart palpitations", "joint_pain": "Muscle or joint pain", "weight_changes": "Changes in weight or body composition", "vaginal_dryness": "Vaginal dryness or discomfort", "sex_drive_changes": "Changes in sex drive", "bladder_symptoms": "Bladder symptoms", "nothing_much": "Nothing is bothering me much"}, "required": true, "label": "Which changes are you noticing now?"}, {"field_id": "PERI_IMPACT", "format": "single_choice", "profile_path": "perimenopause.impact", "options": ["hardly_at_all", "sometimes_manage", "regularly_affect", "major_effect", "varies_day_to_day", "prefer_not_to_say"], "option_labels": {"hardly_at_all": "Hardly at all", "sometimes_manage": "Sometimes, but I can manage", "regularly_affect": "They regularly affect sleep, work, or relationships", "major_effect": "They have a major effect on my quality of life", "varies_day_to_day": "It changes from day to day", "prefer_not_to_say": "Prefer not to answer"}, "required": true, "label": "How much are these changes affecting your life?"}, {"field_id": "PERI_DAYPART", "format": "multi_choice", "max_select": 2, "profile_path": "perimenopause.daypart", "options": ["morning", "daytime", "evening", "night", "before_during_period", "varies"], "option_labels": {"morning": "Morning", "daytime": "Daytime", "evening": "Evening", "night": "Night", "before_during_period": "Before or during a period", "varies": "It changes from day to day"}, "required": true, "label": "When do symptoms tend to be hardest?"}, {"field_id": "PERI_CONFIRMATION", "format": "single_choice", "profile_path": "perimenopause.confirmation", "options": ["clinician_said_perimenopause", "yes_cause_unclear", "appointment_scheduled", "not_yet", "prefer_not_to_say"], "option_labels": {"clinician_said_perimenopause": "Yes, a clinician said this is perimenopause", "yes_cause_unclear": "Yes, but the cause is still unclear", "appointment_scheduled": "I have an appointment scheduled", "not_yet": "Not yet", "prefer_not_to_say": "Prefer not to answer"}, "required": true, "label": "Have you discussed these changes with a clinician?"}, {"field_id": "PERI_TREATMENT", "format": "multi_choice", "profile_path": "perimenopause.treatment", "required": false, "skippable": true, "options": ["nothing_yet", "lifestyle_changes", "vitamins_supplements", "hormone_therapy", "nonhormonal_prescription", "local_vaginal_treatment", "discussing_with_clinician", "prefer_not_to_say"], "option_labels": {"nothing_yet": "Nothing yet", "lifestyle_changes": "Lifestyle changes", "vitamins_supplements": "Vitamins or supplements", "hormone_therapy": "Menopausal hormone therapy", "nonhormonal_prescription": "Nonhormonal prescription medication", "local_vaginal_treatment": "Local vaginal treatment for dryness or discomfort", "discussing_with_clinician": "I am discussing options with a clinician", "prefer_not_to_say": "Prefer not to answer"}, "label": "Are you currently using anything to manage symptoms?"}, {"field_id": "PERI_CONTRACEPTION", "format": "multi_choice", "profile_path": "perimenopause.contraception", "required": false, "skippable": true, "options": ["pills", "hormonal_iud", "copper_iud", "implant_patch_ring_shot", "other_hormonal", "no", "prefer_not_to_say"], "option_labels": {"pills": "Birth control pills", "hormonal_iud": "Hormonal IUD", "copper_iud": "Copper IUD", "implant_patch_ring_shot": "Implant, patch, ring, or shot", "other_hormonal": "Other hormonal medication", "no": "No", "prefer_not_to_say": "Prefer not to answer"}, "label": "Are you currently using birth control or other hormonal medication?"}, {"field_id": "PERI_SURGERY", "format": "multi_choice", "profile_path": "perimenopause.surgery", "sensitivity_level": "health", "required": false, "skippable": true, "options": ["hysterectomy", "ovary_removal_one_or_both", "surgery_uterus_ovaries", "cancer_treatment", "another_surgery_treatment", "no", "not_sure", "prefer_not_to_say"], "option_labels": {"hysterectomy": "Hysterectomy", "ovary_removal_one_or_both": "Removal of one or both ovaries", "surgery_uterus_ovaries": "Surgery involving the uterus or ovaries", "cancer_treatment": "Cancer treatment", "another_surgery_treatment": "Another surgery or medical treatment", "no": "No", "not_sure": "I am not sure", "prefer_not_to_say": "Prefer not to answer"}, "label": "Have you had surgery or treatment that may affect periods or hormone changes?"}, {"field_id": "PERI_REPRO_HISTORY", "format": "multi_choice", "profile_path": "perimenopause.repro_history", "sensitivity_level": "highly_sensitive", "required": false, "skippable": true, "options": ["pregnancy_birth", "c_section", "preterm_complications", "pregnancy_loss", "ended_by_choice_or_medical", "fertility_treatment", "none", "prefer_not_to_say"], "option_labels": {"pregnancy_birth": "Pregnancy and birth", "c_section": "C-section", "preterm_complications": "Preterm birth or pregnancy complications", "pregnancy_loss": "Pregnancy loss", "ended_by_choice_or_medical": "A pregnancy ended by choice or for medical reasons", "fertility_treatment": "Fertility treatment", "none": "None of these", "prefer_not_to_say": "Prefer not to answer"}, "label": "Is there any reproductive history Momna should keep in mind?"}, {"field_id": "PERI_CONDITIONS", "format": "multi_choice", "profile_path": "perimenopause.conditions", "sensitivity_level": "health", "required": false, "skippable": true, "options": ["high_bp_heart", "blood_clots", "diabetes", "migraine", "thyroid", "osteoporosis_low_bone_density", "cancer_history", "mental_health_condition", "something_else", "no", "prefer_not_to_say"], "option_labels": {"high_bp_heart": "High blood pressure or heart disease", "blood_clots": "Blood clots or a clotting condition", "diabetes": "Diabetes", "migraine": "Migraine", "thyroid": "Thyroid disease", "osteoporosis_low_bone_density": "Osteoporosis or low bone density", "cancer_history": "A history of cancer", "mental_health_condition": "A mental health condition", "something_else": "Something else", "no": "No", "prefer_not_to_say": "Prefer not to answer"}, "label": "Has a clinician asked you to keep any health conditions in mind when considering treatment or activity?"}, {"field_id": "PERI_FAMILY", "format": "multi_choice", "profile_path": "perimenopause.family", "sensitivity_level": "health", "required": false, "skippable": true, "options": ["very_early_menopause", "cancer", "blood_clots", "heart_attack_young", "osteoporosis_fractures", "diabetes", "thyroid_disease", "something_else", "dont_know_family_history", "prefer_not_to_say"], "option_labels": {"very_early_menopause": "Very early menopause", "cancer": "Breast, ovarian, or uterine cancer", "blood_clots": "Blood clots", "heart_attack_young": "Heart attack or stroke at a young age", "osteoporosis_fractures": "Osteoporosis or fractures later in life", "diabetes": "Diabetes", "thyroid_disease": "Thyroid disease", "something_else": "Something else", "dont_know_family_history": "I do not know my family health history", "prefer_not_to_say": "Prefer not to answer"}, "label": "Are there health patterns in your family that a clinician has told you to keep in mind?"}, {"field_id": "PERI_CARE", "format": "single_choice", "profile_path": "perimenopause.care", "options": ["routine_early", "seek_when_interferes", "often_postpone", "hard_to_find_taken_seriously", "bad_experience", "not_sure_which_clinician", "prefer_not_to_say"], "option_labels": {"routine_early": "I keep up with routine care and discuss changes early", "seek_when_interferes": "I seek care when symptoms start interfering with life", "often_postpone": "I often put off appointments", "hard_to_find_taken_seriously": "It is hard to find a clinician who takes these symptoms seriously", "bad_experience": "I have had a bad experience with care", "not_sure_which_clinician": "I am not sure which type of clinician to see", "prefer_not_to_say": "Prefer not to answer"}, "required": true, "label": "How do you usually approach reproductive and preventive care?"}, {"field_id": "PERI_OCCUPATION", "format": "single_choice", "profile_path": "person.occupation_category", "required": false, "skippable": true, "options": ["work", "student", "manage_household", "not_working", "enter_job", "prefer_not_to_say"], "option_labels": {"work": "I work", "student": "I am a student", "manage_household": "I manage a household or care for other people", "not_working": "I am not currently working", "enter_job": "Optional: briefly enter your job or field", "prefer_not_to_say": "Prefer not to answer"}, "label": "What best describes what you do right now?"}, {"field_id": "PERI_OCCUPATION_DETAIL", "format": "short_text", "profile_path": "person.occupation_detail", "required": false, "max_length": 80, "show_if": {"field_id": "PERI_OCCUPATION", "in": ["enter_job"]}, "label": "Your job or field"}, {"field_id": "PERI_WORK", "format": "multi_choice", "max_select": 2, "profile_path": "person.work_nature", "options": ["mostly_sitting", "on_feet_long", "physically_demanding", "high_emotional_responsibility", "shift_overnight", "traveling_commuting", "can_take_breaks", "hard_to_take_breaks", "caring_for_children_family", "every_day_different"], "option_labels": {"mostly_sitting": "Mostly sitting", "on_feet_long": "On my feet for long periods", "physically_demanding": "Physically demanding", "high_emotional_responsibility": "High emotional responsibility", "shift_overnight": "Shift work or overnight work", "traveling_commuting": "Frequently traveling or commuting", "can_take_breaks": "I can take breaks when I need them", "hard_to_take_breaks": "It is very hard to take breaks", "caring_for_children_family": "I care for children or other family members", "every_day_different": "Every day is different"}, "required": true, "label": "What is most of your day like?"}, {"field_id": "PERI_SLEEP", "format": "multi_choice", "max_select": 2, "profile_path": "person.sleep", "options": ["sleep_well", "trouble_falling_asleep", "wake_often", "heat_sweating_wakes", "wake_too_early", "shift_overnight", "caregiving_limits_sleep", "prefer_not_to_say"], "option_labels": {"sleep_well": "I generally sleep well", "trouble_falling_asleep": "I have trouble falling asleep", "wake_often": "I wake up often", "heat_sweating_wakes": "Heat or sweating wakes me up", "wake_too_early": "I wake up too early", "shift_overnight": "I work shifts or overnight", "caregiving_limits_sleep": "Caregiving or responsibilities limit my sleep", "prefer_not_to_say": "Prefer not to answer"}, "required": true, "label": "What is happening with your sleep?"}, {"field_id": "PERI_ACTIVITY", "format": "single_choice", "profile_path": "perimenopause.activity", "options": ["exercise_regularly", "walk_active_daily", "mixed_days", "mostly_inactive", "work_already_demanding", "pain_limits_movement", "prefer_not_to_say"], "option_labels": {"exercise_regularly": "I exercise regularly", "walk_active_daily": "I walk a lot or stay active in daily life", "mixed_days": "Some days I move, and other days I sit for long periods", "mostly_inactive": "I am mostly inactive", "work_already_demanding": "My work is already physically demanding", "pain_limits_movement": "Pain or other limitations affect movement", "prefer_not_to_say": "Prefer not to answer"}, "required": true, "label": "What does movement and physical activity look like for you now?"}, {"field_id": "PERI_LIFESTYLE", "format": "multi_choice", "max_select": 3, "profile_path": "perimenopause.lifestyle", "required": false, "skippable": true, "options": ["irregular_meals", "alcohol", "nicotine", "lot_of_caffeine", "not_enough_time_for_myself", "high_stress", "caring_for_children_relatives", "frequent_travel", "none", "prefer_not_to_say"], "option_labels": {"irregular_meals": "Irregular meals", "alcohol": "Alcohol", "nicotine": "Nicotine", "lot_of_caffeine": "A lot of caffeine", "not_enough_time_for_myself": "Not enough time for myself", "high_stress": "High stress", "caring_for_children_relatives": "Caring for children or relatives", "frequent_travel": "Frequent travel", "none": "None of these", "prefer_not_to_say": "Prefer not to answer"}, "label": "Which of these noticeably affect how you feel?"}, {"field_id": "PERI_MENTAL", "format": "multi_choice", "max_select": 3, "profile_path": "person.emotional_baseline", "sensitivity_level": "health", "options": ["calm", "tired", "irritable", "anxious", "sad", "overwhelmed", "hard_to_concentrate", "unlike_myself", "emotions_change_a_lot", "prefer_not_to_say"], "option_labels": {"calm": "Calm", "tired": "Tired", "irritable": "Irritable", "anxious": "Anxious", "sad": "Sad", "overwhelmed": "Overwhelmed", "hard_to_concentrate": "It is hard to concentrate", "unlike_myself": "I feel unlike myself or out of control", "emotions_change_a_lot": "My emotions change a lot", "prefer_not_to_say": "Prefer not to answer"}, "required": true, "label": "How have you felt most often over the past two weeks?"}, {"field_id": "PERI_COPING", "format": "multi_choice", "max_select": 3, "profile_path": "person.coping", "options": ["clear_plan", "talking_trusted", "facts_explanations", "movement", "sleep_quiet", "humor", "work_staying_busy", "time_alone", "nothing_helps", "something_else"], "option_labels": {"clear_plan": "A clear plan", "talking_trusted": "Talking with someone I trust", "facts_explanations": "Facts and explanations", "movement": "Movement", "sleep_quiet": "Sleep or quiet", "humor": "Humor", "work_staying_busy": "Work or staying busy", "time_alone": "Time alone", "nothing_helps": "Nothing helps much right now", "something_else": "Something else"}, "required": true, "label": "What tends to help on difficult days?"}, {"field_id": "PERI_PARTNER", "format": "single_choice", "profile_path": "person.partner_status", "required": false, "skippable": true, "options": ["live_together", "not_living_together", "casual_multiple", "no_partner", "prefer_not_to_say"], "option_labels": {"live_together": "Yes, we live together", "not_living_together": "Yes, but we do not live together", "casual_multiple": "I have casual or multiple partners", "no_partner": "I do not currently have a partner", "prefer_not_to_say": "Prefer not to answer"}, "label": "Do you currently have a partner?"}, {"field_id": "PERI_PARTNER_SUPPORT", "format": "single_choice", "profile_path": "person.partner_support", "sensitivity_level": "highly_sensitive", "required": false, "skippable": true, "show_if": {"field_id": "PERI_PARTNER", "in": ["live_together", "not_living_together", "casual_multiple"]}, "options": ["understands_supports", "tries_doesnt_know_how", "hard_to_explain", "doesnt_take_seriously", "relationship_more_tense", "pressured_unsafe", "prefer_not_to_say"], "option_labels": {"understands_supports": "They understand and support me well", "tries_doesnt_know_how": "They try, but do not know how to help", "hard_to_explain": "It is hard for me to explain what is happening", "doesnt_take_seriously": "They do not take the changes seriously", "relationship_more_tense": "The relationship feels more tense", "pressured_unsafe": "I feel pressured or unsafe", "prefer_not_to_say": "Prefer not to answer"}, "label": "How well does your partner understand the changes you are going through?"}, {"field_id": "PERI_SEX_ACTIVE", "format": "single_choice", "profile_path": "perimenopause.sexual_activity", "sensitivity_level": "highly_sensitive", "required": false, "skippable": true, "options": ["yes_regularly", "sometimes", "not_right_now", "prefer_not_to_say"], "option_labels": {"yes_regularly": "Yes, regularly", "sometimes": "Sometimes", "not_right_now": "Not right now", "prefer_not_to_say": "Prefer not to answer"}, "label": "Is sexual activity part of your life right now?"}, {"field_id": "PERI_SEX_FREQ", "format": "single_choice", "profile_path": "perimenopause.sex_frequency", "sensitivity_level": "highly_sensitive", "required": false, "skippable": true, "show_if": {"field_id": "PERI_SEX_ACTIVE", "in": ["yes_regularly", "sometimes"]}, "options": ["few_times_week", "about_once_week", "few_times_month", "less_often", "varies_a_lot", "prefer_not_to_say"], "option_labels": {"few_times_week": "A few times a week", "about_once_week": "About once a week", "few_times_month": "A few times a month", "less_often": "Less often", "varies_a_lot": "It varies a lot", "prefer_not_to_say": "Prefer not to answer"}, "label": "How often do you usually have sex or sexual contact?"}, {"field_id": "PERI_INTIMACY", "format": "multi_choice", "profile_path": "perimenopause.intimacy", "sensitivity_level": "highly_sensitive", "required": false, "skippable": true, "show_if": {"field_id": "PERI_SEX_ACTIVE", "in": ["yes_regularly", "sometimes"]}, "options": ["comfortable", "desire_decreased", "desire_unpredictable", "dryness_pain", "harder_to_relax", "less_confident_in_body", "want_more_affection", "want_help_talking", "not_important_now", "prefer_not_to_say"], "option_labels": {"comfortable": "I am comfortable with it as it is", "desire_decreased": "My desire has decreased", "desire_unpredictable": "My desire feels unpredictable", "dryness_pain": "I have dryness or pain", "harder_to_relax": "It is harder to relax", "less_confident_in_body": "I feel less confident in my body", "want_more_affection": "I would like more affection and closeness", "want_help_talking": "I would like help talking with my partner", "not_important_now": "Sex is not important to me right now", "prefer_not_to_say": "Prefer not to answer"}, "label": "Which statements best describe your sexual life right now?"}, {"field_id": "PERI_SUPPORT", "format": "multi_choice", "profile_path": "perimenopause.support_network", "required": false, "skippable": true, "options": ["partner", "family", "friends", "clinician", "therapist_support_group", "very_little_support", "prefer_not_to_say"], "option_labels": {"partner": "Partner", "family": "Family", "friends": "Friends", "clinician": "Clinician", "therapist_support_group": "Therapist or support group", "very_little_support": "I have very little support right now", "prefer_not_to_say": "Prefer not to answer"}, "label": "Who can you rely on for support?"}, {"field_id": "PERI_REST", "format": "multi_choice", "max_select": 3, "profile_path": "person.recovery_activities", "options": ["walking_nature", "exercise", "music", "reading", "creative_activities", "spending_time_with_people", "time_alone", "travel", "personal_care", "not_sure_yet", "something_else"], "option_labels": {"walking_nature": "Walking or time in nature", "exercise": "Exercise", "music": "Music", "reading": "Reading", "creative_activities": "Creative activities", "spending_time_with_people": "Spending time with people", "time_alone": "Time alone", "travel": "Travel", "personal_care": "Personal care", "not_sure_yet": "I am not sure yet", "something_else": "Something else"}, "required": true, "label": "Which activities would you like to make more room for again?"}, {"field_id": "PERI_BEHAVIOR", "format": "paired_choice", "profile_path": "person.behavior", "rows": [{"row_id": "planning", "options": ["clear_plan", "flexible_suggestions"], "option_labels": {"clear_plan": "Clear plan", "flexible_suggestions": "Flexible suggestions"}}, {"row_id": "depth", "options": ["action_first", "explain_first"], "option_labels": {"action_first": "Give me the action first", "explain_first": "Explain it first"}}, {"row_id": "length", "options": ["brief", "detailed"], "option_labels": {"brief": "Brief", "detailed": "Detailed"}}, {"row_id": "reminders", "options": ["regular_reminders", "only_important_events"], "option_labels": {"regular_reminders": "Regular reminders", "only_important_events": "Only important events"}}, {"row_id": "steps", "options": ["one_main_step", "few_steps_for_day"], "option_labels": {"one_main_step": "One main step", "few_steps_for_day": "A few steps for the day"}}], "required": true, "label": "How do you prefer to receive support?"}, {"field_id": "PERI_TONE", "format": "single_choice", "profile_path": "person.communication.tone", "options": ["gentle", "friendly", "close_friend", "direct"], "option_labels": {"gentle": "Gentle - soft and careful, with no jokes", "friendly": "Friendly - natural and easy, with occasional light humor", "close_friend": "Like someone who knows me well - informal, conversational, and okay with jokes", "direct": "Direct - brief, honest, and never overly sweet"}, "required": true, "label": "How can Momna talk with you?"}]}]}'::jsonb, 'draft')
on conflict (onboarding_key, version, locale) do update
  set schema = excluded.schema, status = 'draft';

do $$
declare v_id uuid;
begin
  for v_id in
    select id from public.onboarding_definitions
    where onboarding_key = 'perimenopause' and version = 1
  loop
    perform public.publish_onboarding_definition(v_id);
  end loop;
end $$;