-- DareDrop Private Challenges Migration Rollback
-- File: supabase/migrations/rollback/20261105000000_private_challenges_rollback.sql

BEGIN;

-- 1. Drop new functions, RPCs, and triggers
DROP FUNCTION IF EXISTS public.join_challenge(UUID);
DROP FUNCTION IF EXISTS public.get_challenge_invite_preview(UUID);

DROP TRIGGER IF EXISTS trg_challenge_creator_participation ON public.challenges;
DROP FUNCTION IF EXISTS public.handle_challenge_creator_participation();

-- 2. Restore challenges SELECT policy & grants
DROP POLICY IF EXISTS "Members and creators can view challenges" ON public.challenges;
DROP POLICY IF EXISTS "Public can view challenges" ON public.challenges;

CREATE POLICY "Public can view challenges"
  ON public.challenges
  FOR SELECT
  USING (true);

GRANT SELECT ON public.challenges TO anon, PUBLIC;

-- 3. Drop membership helper functions (both 1-arg and legacy 2-arg)
DROP FUNCTION IF EXISTS public.is_challenge_member(UUID);
DROP FUNCTION IF EXISTS public.is_challenge_member(UUID, TEXT);

-- 4. Restore challenge_participants INSERT grant & policy
GRANT INSERT ON public.challenge_participants TO authenticated;

DROP POLICY IF EXISTS "Registered users can join challenges" ON public.challenge_participants;
CREATE POLICY "Registered users can join challenges"
  ON public.challenge_participants
  FOR INSERT
  TO authenticated
  WITH CHECK (
    auth.uid() IS NOT NULL
    AND user_id = auth.uid()::text
    AND public.is_registered_account()
  );

COMMIT;
