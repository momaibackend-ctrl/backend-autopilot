-- ============================================================
-- 0005. Отзыв TRUNCATE, TRIGGER и REFERENCES у ролей anon / authenticated.
--
-- ПРИЧИНА — критическая. Supabase по умолчанию выдаёт этим ролям
-- полный набор прав на таблицы в схеме public. Миграция 100100
-- отозвала insert, update и delete, но TRUNCATE, TRIGGER и REFERENCES
-- остались.
--
-- TRUNCATE, в отличие от DELETE, НЕ подчиняется RLS. Проверено на
-- PostgreSQL 16: под ролью authenticated команда DELETE отклоняется,
-- а TRUNCATE public.profiles CASCADE выполняется успешно и каскадом
-- очищает birth_events, user_lifecycle, onboarding_sessions,
-- onboarding_answers, profile_snapshots и user_children.
-- То есть любой авторизованный пользователь мог одной командой
-- удалить все данные всех пользовательниц.
--
-- TRIGGER позволяет создать триггер на таблице — потенциальный путь
-- к выполнению произвольного кода. REFERENCES позволяет создать
-- внешний ключ на таблицу и косвенно проверять наличие значений.
-- Ни одно из трёх прав клиенту не нужно.
--
-- SELECT сохраняется: без него PostgREST перестанет отдавать данные.
-- Права service_role не затрагиваются.
-- ============================================================

revoke insert, update, delete, truncate, references, trigger
  on public.profiles              from anon, authenticated;
revoke insert, update, delete, truncate, references, trigger
  on public.birth_events          from anon, authenticated;
revoke insert, update, delete, truncate, references, trigger
  on public.user_lifecycle        from anon, authenticated;
revoke insert, update, delete, truncate, references, trigger
  on public.onboarding_sessions   from anon, authenticated;
revoke insert, update, delete, truncate, references, trigger
  on public.onboarding_answers    from anon, authenticated;
revoke insert, update, delete, truncate, references, trigger
  on public.profile_snapshots     from anon, authenticated;
revoke insert, update, delete, truncate, references, trigger
  on public.onboarding_definitions from anon, authenticated;
revoke insert, update, delete, truncate, references, trigger
  on public.user_children         from anon, authenticated;

-- Чтобы права не появились снова у таблиц из будущих миграций.
-- Действует на объекты, создаваемые текущей ролью.
alter default privileges in schema public
  revoke insert, update, delete, truncate, references, trigger
  on tables from anon, authenticated;
