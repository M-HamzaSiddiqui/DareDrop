# DareDrop Supabase Backend Setup

This document explains how to set up the shared Supabase backend for DareDrop.

## 1. Create a Supabase Project
1. Go to [https://supabase.com](https://supabase.com) and create a new project.
2. Under **Project Settings -> API**, copy:
   - **Project URL**
   - **anon / public key**

> ⚠️ **SECURITY WARNING**: NEVER put the `service_role` key into client code or environment variables. Only the public `anon` key is safe for client usage.

## 2. Enable Anonymous Sign-In (Recommended)
1. In your Supabase dashboard, navigate to **Authentication -> Providers**.
2. Click **Anonymous Sign-In** and toggle it **Enabled**.
3. Save changes.
*(DareDrop automatically falls back to a persistent device UUID if anonymous sign-in is disabled, but enabling it allows Supabase's native `auth.uid()` to link user sessions).*

## 3. Run the Database Migration
1. In your Supabase dashboard, go to the **SQL Editor**.
2. Paste the contents of `supabase/migrations/20261022000000_create_challenges_and_participants.sql`.
3. Click **Run**.

This sets up:
- `challenges`: Stores title, description, category, duration, optional deadline, creator info, and timestamps.
- `challenge_participants`: Stores membership joins with a unique constraint `(challenge_id, user_id)` preventing duplicate memberships.
- Row Level Security (RLS) policies allowing public discovery and user creation/joins.

## 4. Configure Client Environment Variables
Create a `.env` file in the root of the project (copy from `.env.example`):

```bash
EXPO_PUBLIC_SUPABASE_URL=https://xyzcompany.supabase.co
EXPO_PUBLIC_SUPABASE_ANON_KEY=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...
# Optional public web domain for HTTPS invite links (e.g., https://daredrop.app)
EXPO_PUBLIC_APP_URL=https://daredrop.app
```
