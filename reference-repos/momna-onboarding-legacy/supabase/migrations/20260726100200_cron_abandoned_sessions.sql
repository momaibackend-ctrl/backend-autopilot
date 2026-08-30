-- Включение расширения и создание задачи — в одной миграции,
-- чтобы порядок применения не зависел от ручных действий в Dashboard.
-- cron.schedule идемпотентна: повторный вызов с тем же jobname
-- обновляет задачу, а не создаёт вторую.
create extension if not exists pg_cron;

select cron.schedule(
  'mark-abandoned-onboarding-sessions',
  '0 3 * * *',
  $$select public.mark_abandoned_sessions();$$
);
