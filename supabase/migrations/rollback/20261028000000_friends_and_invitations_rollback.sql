-- DareDrop Rollback: Friends & Social Challenges Migration
-- File: supabase/migrations/rollback/20261028000000_friends_and_invitations_rollback.sql
-- Status: PREPARED ROLLBACK — DO NOT EXECUTE DIRECTLY AGAINST PRODUCTION WITHOUT EXPLICIT APPROVAL
--
-- Objective:
-- Reverts all schema objects, tables, indexes, RLS policies, and RPC functions introduced by
-- 20261028000000_friends_and_invitations.sql, restoring the database to the 20261028010000 state.
--
-- DATA LOSS WARNING:
-- Executing this rollback after production deployment permanently deletes:
-- 1. All user profiles and generated Crockford Base32 friend codes (user_profiles).
-- 2. All pending, accepted, declined, and cancelled friendships (friendships).
-- 3. All pending, accepted, declined, and expired challenge invitations (challenge_invitations).
-- 4. Friend code lookup rate limit tracking records (friend_code_lookup_rate_limits).
--
-- Historical In-App Notifications Note:
-- Existing rows in public.notification_deliveries created for social events
-- (friend_request_received, friend_request_accepted, challenge_invitation_received) are
-- NOT deleted by this rollback to preserve notification log immutability.

BEGIN;

-- ============================================================================
-- 1. Drop Social RPC Functions (Reverse Dependency Order)
-- ============================================================================

-- Challenge Invitation RPCs
DROP FUNCTION IF EXISTS public.get_user_challenge_invitations();
DROP FUNCTION IF EXISTS public.respond_to_challenge_invitation(UUID, BOOLEAN);
DROP FUNCTION IF EXISTS public.send_challenge_invitation(UUID, TEXT);

-- Friendship RPCs
DROP FUNCTION IF EXISTS public.get_pending_friend_requests();
DROP FUNCTION IF EXISTS public.get_user_friends();
DROP FUNCTION IF EXISTS public.remove_friend(TEXT);
DROP FUNCTION IF EXISTS public.cancel_friend_request(UUID);
DROP FUNCTION IF EXISTS public.decline_friend_request(UUID);
DROP FUNCTION IF EXISTS public.accept_friend_request(UUID);
DROP FUNCTION IF EXISTS public.send_friend_request(TEXT);

-- Profile & Lookup RPCs
DROP FUNCTION IF EXISTS public.lookup_profile_by_friend_code(TEXT);
DROP FUNCTION IF EXISTS public.update_user_profile(TEXT, TEXT);
DROP FUNCTION IF EXISTS public.get_or_create_user_profile(TEXT, TEXT);

-- Internal Helper Function
DROP FUNCTION IF EXISTS public.generate_secure_friend_code();

-- ============================================================================
-- 2. Drop Tables and Associated Policies, Constraints, and Indexes
-- ============================================================================
-- Dropping with CASCADE automatically removes all dependent RLS policies:
-- - "Users can view own invitations" ON public.challenge_invitations
-- - "Users can view own friendships" ON public.friendships
-- - "Users can view own profile" ON public.user_profiles
-- - "Friends can view public profile" ON public.user_profiles
-- And all partial/full indexes created by the migration.

DROP TABLE IF EXISTS public.challenge_invitations CASCADE;
DROP TABLE IF EXISTS public.friend_code_lookup_rate_limits CASCADE;
DROP TABLE IF EXISTS public.friendships CASCADE;
DROP TABLE IF EXISTS public.user_profiles CASCADE;

COMMIT;
