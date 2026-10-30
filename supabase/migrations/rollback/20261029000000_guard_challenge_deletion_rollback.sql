-- DareDrop Rollback: Guard Challenge Deletion Migration
-- File: supabase/migrations/rollback/20261029000000_guard_challenge_deletion_rollback.sql
-- Status: PREPARED ROLLBACK — DO NOT EXECUTE DIRECTLY AGAINST PRODUCTION WITHOUT EXPLICIT APPROVAL
--
-- Objective:
-- Reverts all schema objects and triggers introduced by 20261029000000_guard_challenge_deletion.sql,
-- restoring the database to the 20261028020000 state.
--
-- Operational & Security Impact:
-- 1. Drops trigger trg_prevent_active_challenge_deletion from public.challenges.
-- 2. Drops function public.check_challenge_can_be_deleted().
-- 3. Modifies zero tables, zero columns, and zero existing data rows.
-- 4. WARNING: Rolling back this migration removes deletion guarding on challenges,
--    re-exposing Finding H-1 (allowing registered creators to cascade-delete active dares
--    and verification history via direct REST calls). Only execute if operational regressions occur.

BEGIN;

-- ============================================================================
-- 1. Drop Trigger & Trigger Function
-- ============================================================================
DROP TRIGGER IF EXISTS trg_prevent_active_challenge_deletion ON public.challenges;
DROP FUNCTION IF EXISTS public.check_challenge_can_be_deleted();

COMMIT;
