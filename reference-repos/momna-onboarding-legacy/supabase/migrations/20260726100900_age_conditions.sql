-- ============================================================
-- 0900. Возрастные условия показа вопросов.
--
-- ЗАЧЕМ. В анкете менархе два вопроса помечены возрастным
-- ограничением: «Есть ли у тебя сейчас романтические отношения?»
-- (для разрешённой возрастной группы) и «Есть ли в твоей жизни
-- сексуальная близость?» (только для совершеннолетних).
--
-- До этой миграции условия показа умели читать только ответы внутри
-- той же анкеты. Возраст в ответах не лежит: он собирается роутером
-- один раз и хранится в profiles.date_of_birth. Значит возрастную
-- блокировку пришлось бы делать на клиенте — и любая ошибка там
-- означала бы показ вопроса о сексуальной близости ребёнку,
-- проходящему анкету менархе.
--
-- Формат условия:
--   {"age_gte": 18}            — только с 18 лет
--   {"age_lt": 16}             — только до 16 лет
--   {"age_gte": 14, "age_lt": 18}
--
-- Комбинируется с обычными условиями через all / any / not.
--
-- ПОВЕДЕНИЕ ПРИ НЕИЗВЕСТНОМ ВОЗРАСТЕ. Если дата рождения не указана
-- (вопрос можно пропустить), условие всегда ложно и вопрос не
-- показывается. Отказ в небезопасную сторону здесь недопустим:
-- лучше не задать вопрос взрослой, чем задать его ребёнку.
-- ============================================================

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
