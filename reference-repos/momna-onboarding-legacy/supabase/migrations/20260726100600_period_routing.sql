-- ============================================================
-- 0600. Определение жизненного периода по ответам Lifecycle Router.
--
-- Продуктовый документ требует: «Backend является единственным
-- источником истины для маршрутизации. Клиент не должен независимо
-- дублировать бизнес-правила выбора периода».
--
-- До этой миграции такой логики в бэкенде не было: клиенту пришлось бы
-- зашивать таблицу маршрутизации у себя, что документ прямо запрещает.
--
-- Правила лежат внутри schema анкеты, в блоке routing, и зависят от
-- версии анкеты: меняются вопросы — меняются правила вместе с ними.
-- Условия описываются тем же языком, что и show_if, и проверяются той
-- же функцией evaluate_condition — отдельного диалекта условий нет.
--
-- Формат правила:
--   {
--     "priority": 10,
--     "when": {"field_id": "pregnancy_status", "in": ["confirmed_by_doctor"]},
--     "onboarding_key": "pregnancy",
--     "substage": "CONFIRMED",
--     "confidence": "HIGH",
--     "additional_contexts": ["POSSIBLE_PREGNANCY"]
--   }
--
-- Правила проверяются по возрастанию priority, побеждает первое
-- совпавшее. Если не совпало ни одно — берётся routing_fallback.
-- ============================================================

create or replace function public.resolve_period_from_router(
  p_session_id uuid
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_definition_id uuid;
  v_onboarding_key text;
  v_schema jsonb;
  v_rule jsonb;
  v_fallback jsonb;
begin
  if v_user_id is null then
    raise exception 'not_authenticated';
  end if;

  select s.definition_id, s.onboarding_key
    into v_definition_id, v_onboarding_key
  from public.onboarding_sessions s
  where s.id = p_session_id and s.user_id = v_user_id;

  if v_definition_id is null then
    raise exception 'session_not_found';
  end if;

  if v_onboarding_key <> 'lifecycle_router' then
    raise exception 'not_a_router_session';
  end if;

  select d.schema into v_schema
  from public.onboarding_definitions d
  where d.id = v_definition_id;

  -- первое совпавшее правило по возрастанию priority
  for v_rule in
    select r.rule
    from jsonb_array_elements(coalesce(v_schema -> 'routing', '[]'::jsonb)) r(rule)
    order by coalesce((r.rule ->> 'priority')::int, 1000)
  loop
    if public.evaluate_condition(p_session_id, v_rule -> 'when') then
      return jsonb_build_object(
        'onboarding_key',      v_rule ->> 'onboarding_key',
        'substage',            v_rule ->> 'substage',
        'confidence',          coalesce(v_rule ->> 'confidence', 'MEDIUM'),
        'additional_contexts', coalesce(v_rule -> 'additional_contexts', '[]'::jsonb),
        'matched_priority',    coalesce((v_rule ->> 'priority')::int, 1000),
        'source',              'rule'
      );
    end if;
  end loop;

  -- ни одно правило не совпало
  v_fallback := v_schema -> 'routing_fallback';

  if v_fallback is null then
    return jsonb_build_object(
      'onboarding_key', null,
      'substage', null,
      'confidence', 'LOW',
      'additional_contexts', '[]'::jsonb,
      'source', 'none'
    );
  end if;

  return jsonb_build_object(
    'onboarding_key',      v_fallback ->> 'onboarding_key',
    'substage',            v_fallback ->> 'substage',
    'confidence',          coalesce(v_fallback ->> 'confidence', 'LOW'),
    'additional_contexts', coalesce(v_fallback -> 'additional_contexts', '[]'::jsonb),
    'source',              'fallback'
  );
end;
$$;

revoke all on function public.resolve_period_from_router(uuid) from public, anon;
grant execute on function public.resolve_period_from_router(uuid) to authenticated;
