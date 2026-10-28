-- DareDrop: Fix ambiguous user_id column reference in get_challenge_eligible_verifiers
-- File: supabase/migrations/20261024010000_fix_eligible_verifiers_ambiguous_user_id.sql

CREATE OR REPLACE FUNCTION public.get_challenge_eligible_verifiers(
  p_challenge_id UUID
)
RETURNS TABLE (
  user_id TEXT,
  display_name TEXT,
  is_creator BOOLEAN
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_caller_id TEXT;
  v_challenge public.challenges%ROWTYPE;
BEGIN
  v_caller_id := auth.uid()::text;
  IF v_caller_id IS NULL THEN
    RAISE EXCEPTION 'Authentication required' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_challenge FROM public.challenges c WHERE c.id = p_challenge_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Challenge not found' USING ERRCODE = 'P0002';
  END IF;

  -- Caller must be an active participant or the creator of this challenge
  IF v_challenge.creator_id != v_caller_id THEN
    PERFORM 1 FROM public.challenge_participants cp
    WHERE cp.challenge_id = p_challenge_id AND cp.user_id = v_caller_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Only active challenge members can view eligible verifiers' USING ERRCODE = '42501';
    END IF;
  END IF;

  RETURN QUERY
    -- Creator (if not caller)
    SELECT
      v_challenge.creator_id AS user_id,
      v_challenge.creator_name AS display_name,
      TRUE AS is_creator
    WHERE v_challenge.creator_id IS NOT NULL AND v_challenge.creator_id != v_caller_id

    UNION

    -- Co-participants (excluding caller)
    SELECT
      cp.user_id,
      'Participant ' || pg_catalog.substr(cp.user_id, 1, 6) AS display_name,
      FALSE AS is_creator
    FROM public.challenge_participants cp
    WHERE cp.challenge_id = p_challenge_id
      AND cp.user_id != v_caller_id
      AND (v_challenge.creator_id IS NULL OR cp.user_id != v_challenge.creator_id);
END;
$$;

REVOKE ALL ON FUNCTION public.get_challenge_eligible_verifiers(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_challenge_eligible_verifiers(UUID) TO authenticated;

-- Ownership & security guard (fail closed).
-- Inspects the exact function OID for public.get_challenge_eligible_verifiers(uuid). A missing function or
-- missing table is a hard failure, never a vacuous "zero bad rows" success. The SECURITY DEFINER RPC relies on
-- owner == table owner to bypass (non-forced) RLS on public.challenge_participants, so any other owner fails.
DO $$
DECLARE
  v_func_oid OID;
  v_table_oid OID;
  v_func_owner OID;
  v_table_owner OID;
  v_secdef BOOLEAN;
  v_config TEXT[];
BEGIN
  v_func_oid := pg_catalog.to_regprocedure('public.get_challenge_eligible_verifiers(uuid)');
  IF v_func_oid IS NULL THEN
    RAISE EXCEPTION 'Migration failed: function public.get_challenge_eligible_verifiers(uuid) does not exist'
      USING ERRCODE = '42883';
  END IF;

  v_table_oid := pg_catalog.to_regclass('public.challenge_participants');
  IF v_table_oid IS NULL THEN
    RAISE EXCEPTION 'Migration failed: table public.challenge_participants does not exist'
      USING ERRCODE = '42P01';
  END IF;

  SELECT p.proowner, p.prosecdef, p.proconfig
  INTO v_func_owner, v_secdef, v_config
  FROM pg_catalog.pg_proc p
  WHERE p.oid = v_func_oid;

  SELECT c.relowner INTO v_table_owner
  FROM pg_catalog.pg_class c
  WHERE c.oid = v_table_oid;

  IF v_func_owner IS NULL OR v_table_owner IS NULL OR v_func_owner <> v_table_owner THEN
    RAISE EXCEPTION 'Migration failed: public.get_challenge_eligible_verifiers(uuid) is owned by % but public.challenge_participants is owned by %',
      pg_catalog.pg_get_userbyid(v_func_owner), pg_catalog.pg_get_userbyid(v_table_owner)
      USING ERRCODE = '42501';
  END IF;

  IF pg_catalog.pg_get_userbyid(v_func_owner) IN ('anon', 'authenticated', 'authenticator', 'public') THEN
    RAISE EXCEPTION 'Migration failed: public.get_challenge_eligible_verifiers(uuid) is owned by untrusted role %',
      pg_catalog.pg_get_userbyid(v_func_owner)
      USING ERRCODE = '42501';
  END IF;

  IF NOT v_secdef OR v_config IS NULL OR NOT ('search_path=""' = ANY (v_config)) THEN
    RAISE EXCEPTION 'Migration failed: public.get_challenge_eligible_verifiers(uuid) must be SECURITY DEFINER with SET search_path = '''''
      USING ERRCODE = '42501';
  END IF;
END $$;
