-- DareDrop Rollback: Guard Challenge Updates Migration (Finding M-1)
-- File: supabase/migrations/rollback/20261029010000_guard_challenge_updates_rollback.sql
-- Status: PREPARED ROLLBACK — DO NOT EXECUTE DIRECTLY AGAINST PRODUCTION WITHOUT EXPLICIT APPROVAL
--
-- Objective:
-- Reverts all schema objects and privilege changes introduced by 20261029010000_guard_challenge_updates.sql,
-- restoring the database to the exact pre-migration state (20261029000000 / post H-1 deletion guard).
--
-- Operational & Security Impact:
-- 1. Drops trigger trg_guard_challenge_updates from public.challenges.
-- 2. Drops function public.guard_challenge_updates().
-- 3. Revokes column-level UPDATE privileges on (title, description, category, creator_name) from authenticated,
--    restoring all column attacl entries in pg_attribute to NULL.
-- 4. Restores pre-migration table-level UPDATE grants on public.challenges to anon and authenticated,
--    restoring pg_class relacl to {postgres=arwdDxtm/postgres,anon=arwdDxtm/postgres,authenticated=arwdDxtm/postgres,service_role=arwdDxtm/postgres}.
-- 5. Modifies zero tables, zero columns, and zero existing data rows.
-- 6. Preserves H-1's deletion guard (trg_prevent_active_challenge_deletion) and all pre-existing objects.
-- 7. WARNING: Rolling back this migration re-exposes Finding M-1 (allowing registered creators to mutate
--    participants_count, challenge_type, duration_days, and ends_at via direct REST calls).

BEGIN;

-- ============================================================================
-- 1. Drop Trigger & Trigger Function Introduced by M-1
-- ============================================================================
DROP TRIGGER IF EXISTS trg_guard_challenge_updates ON public.challenges;
DROP FUNCTION IF EXISTS public.guard_challenge_updates();

-- ============================================================================
-- 2. Restore Exact Pre-Migration Privilege State
-- ============================================================================

-- Clean up explicit column-level UPDATE privileges, resetting pg_attribute.attacl to NULL
REVOKE ALL (title, description, category, creator_name) ON public.challenges FROM authenticated;

-- Restore pre-migration table-level UPDATE grants for anon and authenticated
GRANT UPDATE ON public.challenges TO anon, authenticated;

COMMIT;
