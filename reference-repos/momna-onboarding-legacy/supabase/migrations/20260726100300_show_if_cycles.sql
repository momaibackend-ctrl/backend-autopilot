-- ============================================================
-- Проверка отсутствия циклов в зависимостях show_if.
-- publish_onboarding_definition проверяет, что родитель show_if
-- существует, но не проверяет, что граф зависимостей ациклический.
-- Схема с циклом (A показывается если B, B показывается если A)
-- публикуется успешно, после чего обе ветки навсегда невидимы,
-- validate_onboarding_session не сообщает о пропущенных вопросах,
-- и анкета завершается с молча мёртвой веткой.
-- ============================================================
create or replace function public.validate_no_show_if_cycles(p_schema jsonb)
returns text
language sql
stable
as $$
  with recursive q as (
    select qq.question ->> 'field_id' as fid,
           qq.question -> 'show_if'   as cond
    from jsonb_array_elements(p_schema -> 'sections') s(section)
    cross join lateral jsonb_array_elements(s.section -> 'questions') qq(question)
  ),
  edges as (
    -- ребро «вопрос зависит от поля»; jsonb_path_query достаёт field_id
    -- с любой глубины вложенности all/any/not
    select q.fid as dependent, dep #>> '{}' as depends_on
    from q
    cross join lateral jsonb_path_query(q.cond, 'strict $.**.field_id') dep
    where q.cond is not null
  ),
  walk as (
    select dependent as origin, depends_on as node,
           array[dependent, depends_on] as path, false as looped
    from edges
    union all
    select w.origin, e.depends_on, w.path || e.depends_on,
           e.depends_on = any(w.path)
    from walk w
    join edges e on e.dependent = w.node
    where not w.looped and array_length(w.path, 1) < 50
  )
  select 'show_if_cycle: ' || array_to_string(path, ' -> ')
  from walk where looped limit 1;
$$;
revoke all on function public.validate_no_show_if_cycles(jsonb) from public, anon, authenticated;
