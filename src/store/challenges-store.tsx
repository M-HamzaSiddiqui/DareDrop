import AsyncStorage from '@react-native-async-storage/async-storage';
import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { AppState } from 'react-native';

import { Category, Challenge, MOCK_CHALLENGES } from '@/data/challenges';
import { buildCompletionsChannelName, subscribeToCompletions } from '@/lib/realtime';
import {
  buildPendingReviews,
  buildReviewRpcArgs,
  PendingReview,
  ReviewChallengeInfo,
  ReviewDecision,
  translateReviewError,
} from '@/lib/reviews';
import {
  DbChallenge,
  DbCompletion,
  EligibleVerifier,
  ensureAuthenticatedUser,
  getOrCreateCurrentUserId,
  isSupabaseConfigured,
  ParticipantProgress,
  supabase,
} from '@/lib/supabase';
import { fetchUnreadNotificationCount } from '@/lib/inbox';

const LOCAL_CHALLENGES_KEY = '@daredrop/local_challenges_v1';
const LEGACY_UNSCOPED_JOINED_KEY = '@daredrop/local_joined_ids_v1';
const getJoinedKey = (uid?: string | null) =>
  `@daredrop/local_joined_ids_v1:${uid && uid.trim() ? uid.trim() : 'guest'}`;
const getCompletionsKey = (uid?: string | null) =>
  `@daredrop/local_completions_v1:${uid && uid.trim() ? uid.trim() : 'guest'}`;

export interface CreateChallengeInput {
  title: string;
  description: string;
  category: Category;
  durationDays: number;
  endsAt?: Date | null;
  creator?: string;
  challengeType?: 'daily' | 'one_time';
  timezone?: string;
}

interface ChallengesContextType {
  challenges: Challenge[];
  loading: boolean;
  refreshing: boolean;
  error: string | null;
  isBackendConnected: boolean;
  currentUserId: string;
  refreshChallenges: () => Promise<void>;
  createChallenge: (input: CreateChallengeInput) => Promise<Challenge>;
  addChallenge: (input: CreateChallengeInput) => Promise<Challenge>;
  joinChallenge: (id: string) => Promise<{ success: boolean; joined: boolean; error?: string }>;
  fetchChallengeById: (id: string) => Promise<Challenge | null>;
  isUserJoined: (id: string) => boolean;
  submitCompletion: (params: {
    challengeId: string;
    verifierId: string;
    completionDate: string;
    submissionNote?: string;
  }) => Promise<{ success: boolean; error?: string; completion?: DbCompletion }>;
  fetchCompletions: (challengeId: string) => Promise<DbCompletion[]>;
  fetchEligibleVerifiers: (challengeId: string) => Promise<EligibleVerifier[]>;
  fetchParticipantProgress: (
    challengeId: string,
    userId?: string,
  ) => Promise<ParticipantProgress | null>;
  reassignVerifier: (
    completionId: string,
    newVerifierId: string,
  ) => Promise<{ success: boolean; error?: string; completion?: DbCompletion }>;
  pendingReviews: PendingReview[];
  pendingReviewsLoading: boolean;
  pendingReviewsError: string | null;
  refreshPendingReviews: () => Promise<PendingReview[]>;
  fetchCompletionById: (completionId: string) => Promise<DbCompletion | null>;
  reviewCompletion: (params: {
    completionId: string;
    decision: ReviewDecision;
    rejectionReason?: string | null;
  }) => Promise<{ success: boolean; error?: string; completion?: DbCompletion }>;
  unreadNotificationsCount: number;
  refreshUnreadNotificationsCount: () => Promise<number>;
  decrementUnreadCount: () => void;
}

const ChallengesContext = createContext<ChallengesContextType | null>(null);

function dbToAppChallenge(
  db: DbChallenge,
  participantCount: number,
  isJoined: boolean,
): Challenge {
  const createdAt = new Date(db.created_at);
  const endsAt = db.ends_at
    ? new Date(db.ends_at)
    : new Date(createdAt.getTime() + db.duration_days * 24 * 60 * 60 * 1000);

  const rawCount =
    typeof db.participants_count === 'number'
      ? db.participants_count
      : typeof participantCount === 'number'
        ? participantCount
        : 0;

  return {
    id: db.id,
    title: db.title,
    description: db.description,
    category: db.category,
    durationDays: db.duration_days,
    participants: Math.max(0, rawCount),
    createdAt,
    endsAt,
    creator: db.creator_name || 'Anonymous',
    creatorId: db.creator_id || null,
    joined: isJoined,
    challengeType: db.challenge_type || 'daily',
    timezone: db.timezone || 'UTC',
  };
}

export function ChallengesProvider({ children }: { children: React.ReactNode }) {
  const [challenges, setChallenges] = useState<Challenge[]>(
    isSupabaseConfigured ? [] : MOCK_CHALLENGES,
  );
  const [loading, setLoading] = useState<boolean>(true);
  const [refreshing, setRefreshing] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const [currentUserId, setCurrentUserId] = useState<string>('');
  const [joinedIds, setJoinedIds] = useState<Set<string>>(new Set());
  const [pendingReviews, setPendingReviews] = useState<PendingReview[]>([]);
  const [pendingReviewsLoading, setPendingReviewsLoading] = useState<boolean>(false);
  const [pendingReviewsError, setPendingReviewsError] = useState<string | null>(null);
  const [unreadNotificationsCount, setUnreadNotificationsCount] = useState<number>(0);
  const challengesRef = useRef<Challenge[]>(challenges);
  useEffect(() => {
    challengesRef.current = challenges;
  }, [challenges]);

  const currentUserIdRef = useRef<string>(currentUserId);
  useEffect(() => {
    currentUserIdRef.current = currentUserId;
  }, [currentUserId]);

  const loadRequestIdRef = useRef<number>(0);

  const refreshUnreadNotificationsCount = useCallback(async (): Promise<number> => {
    try {
      const count = await fetchUnreadNotificationCount();
      setUnreadNotificationsCount(count);
      return count;
    } catch {
      return 0;
    }
  }, []);

  const decrementUnreadCount = useCallback(() => {
    setUnreadNotificationsCount((prev) => Math.max(0, prev - 1));
  }, []);

  // Initialize identity and load challenges
  const loadChallenges = useCallback(
    async (userId?: string) => {
      const reqId = ++loadRequestIdRef.current;
      let activeUserId = userId !== undefined ? userId : currentUserIdRef.current;
      if (!activeUserId && activeUserId !== '') {
        try {
          activeUserId = await getOrCreateCurrentUserId();
        } catch {
          // Public browsing without write credentials
        }
      }

      if (!isSupabaseConfigured || !supabase) {
        // Pure local/demo mode without configured Supabase credentials
        try {
          const stored = await AsyncStorage.getItem(LOCAL_CHALLENGES_KEY);
          if (stored) {
            const parsed: Challenge[] = JSON.parse(stored).map((c: any) => ({
              ...c,
              createdAt: new Date(c.createdAt),
              endsAt: new Date(c.endsAt),
            }));

            // Deduplicate with mock
            const map = new Map<string, Challenge>();
            [...parsed, ...MOCK_CHALLENGES].forEach((c) => map.set(c.id, c));
            if (reqId === loadRequestIdRef.current) {
              setChallenges(Array.from(map.values()));
            }
          } else if (reqId === loadRequestIdRef.current) {
            setChallenges(MOCK_CHALLENGES);
          }
        } catch {
          if (reqId === loadRequestIdRef.current) {
            setChallenges(MOCK_CHALLENGES);
          }
        } finally {
          if (reqId === loadRequestIdRef.current) {
            setLoading(false);
            setRefreshing(false);
          }
        }
        return;
      }

      try {
        setError(null);

        // 1. Fetch all challenges from Supabase (public read)
        const { data: dbChallenges, error: fetchErr } = await supabase
          .from('challenges')
          .select('*')
          .order('created_at', { ascending: false });

        if (fetchErr) throw fetchErr;

        // Race check: discard if another request started or active user changed
        if (
          reqId !== loadRequestIdRef.current ||
          currentUserIdRef.current !== (userId !== undefined ? userId : currentUserIdRef.current)
        ) {
          return;
        }

        // 2. Fetch user's joined challenges
        // Respects privacy-conscious RLS where users only see their own participation rows
        const countsByChallenge: Record<string, number> = {};
        const userJoinedSet = new Set<string>();

        if (activeUserId) {
          try {
            const { data: participants } = await supabase
              .from('challenge_participants')
              .select('challenge_id, user_id');

            // Race check: discard if user changed while fetching participants
            if (reqId !== loadRequestIdRef.current || currentUserIdRef.current !== activeUserId) {
              return;
            }

            if (participants) {
              participants.forEach((p: any) => {
                countsByChallenge[p.challenge_id] = (countsByChallenge[p.challenge_id] || 0) + 1;
                if (activeUserId && p.user_id === activeUserId) {
                  userJoinedSet.add(p.challenge_id);
                }
              });
              setJoinedIds(userJoinedSet);
              const userJoinedKey = getJoinedKey(activeUserId);
              AsyncStorage.setItem(userJoinedKey, JSON.stringify(Array.from(userJoinedSet))).catch(
                () => {},
              );
            }
          } catch {
            // Keep local joined IDs if participant fetch fails
          }
        } else {
          // Guest mode: load guest-scoped joined IDs (if any offline/guest local joins exist)
          const guestJoinedKey = getJoinedKey('guest');
          try {
            const cached = await AsyncStorage.getItem(guestJoinedKey);
            if (cached && reqId === loadRequestIdRef.current && !currentUserIdRef.current) {
              const parsed = JSON.parse(cached);
              if (Array.isArray(parsed)) {
                parsed.forEach((id: string) => userJoinedSet.add(id));
                setJoinedIds(userJoinedSet);
              }
            }
          } catch {}
        }

        // Final race check before committing state
        if (
          reqId !== loadRequestIdRef.current ||
          currentUserIdRef.current !== (userId !== undefined ? userId : currentUserIdRef.current)
        ) {
          return;
        }

        const typedChallenges = (dbChallenges || []) as DbChallenge[];
        const mapped: Challenge[] = typedChallenges.map((db) => {
          const count =
            typeof db.participants_count === 'number'
              ? db.participants_count
              : (countsByChallenge[db.id] ?? 0);
          const joined = userJoinedSet.has(db.id);
          return dbToAppChallenge(db, count, joined);
        });

        // Always display real Supabase records in production mode (never merge dummy mock data)
        setChallenges(mapped);

        // Cache public challenges with joined: false so other users or guests never inherit joined: true
        const publicCache = mapped.map((c) => ({ ...c, joined: false }));
        AsyncStorage.setItem(LOCAL_CHALLENGES_KEY, JSON.stringify(publicCache)).catch(() => {});
      } catch (err: any) {
        if (reqId === loadRequestIdRef.current) {
          const errorMsg = err?.message || 'Could not connect to Supabase';
          setError(errorMsg);
          // Fall back gracefully to genuine locally cached challenges if offline
          try {
            const cached = await AsyncStorage.getItem(LOCAL_CHALLENGES_KEY);
            if (cached && reqId === loadRequestIdRef.current) {
              const userJoinedKey = getJoinedKey(activeUserId);
              const cachedJoined = await AsyncStorage.getItem(userJoinedKey);
              const joinedSet = new Set(cachedJoined ? JSON.parse(cachedJoined) : []);

              const parsed: Challenge[] = JSON.parse(cached).map((c: any) => ({
                ...c,
                createdAt: new Date(c.createdAt),
                endsAt: new Date(c.endsAt),
                joined: joinedSet.has(c.id),
              }));
              if (parsed.length > 0) {
                setChallenges(parsed);
              }
            }
          } catch {
            // Keep current in-memory challenges
          }
        }
      } finally {
        if (reqId === loadRequestIdRef.current) {
          setLoading(false);
          setRefreshing(false);
        }
      }
    },
    [],
  );

  // Initialize identity and load challenges on mount
  useEffect(() => {
    let isMounted = true;

    async function init() {
      try {
        // Clean legacy unscoped joined key to avoid contaminated state from previous runs
        AsyncStorage.removeItem(LEGACY_UNSCOPED_JOINED_KEY).catch(() => {});

        // Pre-load cached challenges immediately from local storage for offline responsiveness
        if (isSupabaseConfigured) {
          try {
            const cached = await AsyncStorage.getItem(LOCAL_CHALLENGES_KEY);
            if (cached && isMounted) {
              const parsed: Challenge[] = JSON.parse(cached).map((c: any) => ({
                ...c,
                createdAt: new Date(c.createdAt),
                endsAt: new Date(c.endsAt),
                joined: false, // Clean default: never assume joined from global cache
              }));
              if (parsed.length > 0) {
                setChallenges(parsed);
              }
            }
          } catch {
            // Ignore cache read errors
          }
        }

        let uid = '';
        if (isSupabaseConfigured && supabase) {
          try {
            const { data } = await supabase.auth.getSession();
            uid = data?.session?.user?.id || '';
            currentUserIdRef.current = uid;
            if (isMounted) setCurrentUserId(uid);
          } catch (authErr: any) {
            console.warn('[DareDrop] Initial session read notice:', authErr?.message || authErr);
          }
        } else {
          uid = await getOrCreateCurrentUserId();
          currentUserIdRef.current = uid;
          if (isMounted) setCurrentUserId(uid);
        }

        // Load cached joined IDs scoped to this specific user / guest
        const userJoinedKey = getJoinedKey(uid);
        const cachedJoined = await AsyncStorage.getItem(userJoinedKey);
        if (cachedJoined && isMounted && currentUserIdRef.current === uid) {
          try {
            const joinedSet = new Set<string>(JSON.parse(cachedJoined));
            setJoinedIds(joinedSet);
            setChallenges((prev) =>
              prev.map((c) => ({
                ...c,
                joined: joinedSet.has(c.id),
              })),
            );
          } catch {
            // Ignore parse errors
          }
        }

        await loadChallenges(uid);
        if (isMounted) {
          fetchUnreadNotificationCount()
            .then((count) => {
              if (isMounted) setUnreadNotificationsCount(count);
            })
            .catch(() => {});
        }
      } catch (err: any) {
        if (isMounted) {
          setError(err?.message || 'Failed to initialize challenges');
          setLoading(false);
        }
      }
    }

    init();
    return () => {
      isMounted = false;
    };
  }, [loadChallenges]);

  const refreshChallenges = useCallback(async () => {
    setRefreshing(true);
    await loadChallenges(currentUserIdRef.current);
  }, [loadChallenges]);

  const fetchChallengeById = useCallback(
    async (id: string): Promise<Challenge | null> => {
      // 1. Check existing in-memory list first
      const existing = challenges.find((c) => c.id === id);
      if (existing) return existing;

      // 2. If Supabase is connected, fetch from remote database
      if (isSupabaseConfigured && supabase) {
        try {
          const { data: dbChallenge, error: dbErr } = await supabase
            .from('challenges')
            .select('*')
            .eq('id', id)
            .single();

          if (!dbErr && dbChallenge) {
            let joined = joinedIds.has(id);
            try {
              const activeUid = currentUserIdRef.current;
              if (activeUid) {
                const { data: parts } = await supabase
                  .from('challenge_participants')
                  .select('user_id')
                  .eq('challenge_id', id)
                  .eq('user_id', activeUid);

                joined = Boolean(parts && parts.length > 0);
              } else {
                joined = joinedIds.has(id);
              }
            } catch {
              // Fall through to joinedIds
            }

            const count =
              typeof (dbChallenge as DbChallenge).participants_count === 'number'
                ? (dbChallenge as DbChallenge).participants_count!
                : 0;
            const challenge = dbToAppChallenge(dbChallenge as DbChallenge, count, joined);
            setChallenges((prev) => [challenge, ...prev.filter((c) => c.id !== id)]);
            return challenge;
          }
        } catch {
          // Fall through
        }
      }

      // 3. Check locally cached challenges
      try {
        const stored = await AsyncStorage.getItem(LOCAL_CHALLENGES_KEY);
        if (stored) {
          const parsed = JSON.parse(stored);
          const found = parsed.find((c: any) => c.id === id);
          if (found) {
            return {
              ...found,
              createdAt: new Date(found.createdAt),
              endsAt: new Date(found.endsAt),
            };
          }
        }
      } catch {
        // Fall through
      }

      // 4. Check mock challenges only in pure local mode
      if (!isSupabaseConfigured) {
        const mockMatch = MOCK_CHALLENGES.find((c) => c.id === id);
        return mockMatch || null;
      }

      return null;
    },
    [challenges, joinedIds],
  );

  const createChallenge = useCallback(
    async (input: CreateChallengeInput): Promise<Challenge> => {
      const now = new Date();
      const endsAt =
        input.endsAt ||
        new Date(now.getTime() + input.durationDays * 24 * 60 * 60 * 1000);

      if (isSupabaseConfigured && supabase) {
        // MUST wait for valid authenticated session before inserting to Supabase
        const authUserId = await ensureAuthenticatedUser();
        if (authUserId !== currentUserId) {
          setCurrentUserId(authUserId);
        }

        // Insert into Supabase with verified auth.uid()
        const { data: inserted, error: insertErr } = await supabase
          .from('challenges')
          .insert({
            title: input.title,
            description: input.description,
            category: input.category,
            duration_days: input.durationDays,
            ends_at: endsAt.toISOString(),
            creator_id: authUserId,
            creator_name: input.creator || 'You',
            challenge_type: input.challengeType || 'daily',
            timezone: input.timezone || 'UTC',
          } as any)
          .select()
          .single();

        if (insertErr || !inserted) {
          throw new Error(insertErr?.message || 'Failed to save challenge to Supabase');
        }

        const typedInserted = inserted as DbChallenge;

        let joinSuccess = false;
        // Creator automatically joins their created challenge
        try {
          const { error: partErr } = await supabase.from('challenge_participants').insert({
            challenge_id: typedInserted.id,
            user_id: authUserId,
          } as any);
          joinSuccess = !partErr;
        } catch {
          // Non-fatal if participant record fails
        }

        const initialCount = joinSuccess ? 1 : 0;
        const newAppChallenge = dbToAppChallenge(
          { ...typedInserted, participants_count: initialCount },
          initialCount,
          joinSuccess,
        );

        // Update state, local cache, and joined list
        setChallenges((prev) => {
          const next = [newAppChallenge, ...prev];
          const publicNext = next.map((c) => ({ ...c, joined: false }));
          AsyncStorage.setItem(LOCAL_CHALLENGES_KEY, JSON.stringify(publicNext)).catch(() => {});
          return next;
        });
        setJoinedIds((prev) => {
          const next = new Set(prev);
          next.add(typedInserted.id);
          const userJoinedKey = getJoinedKey(authUserId);
          AsyncStorage.setItem(userJoinedKey, JSON.stringify(Array.from(next))).catch(() => {});
          return next;
        });

        return newAppChallenge;
      }

      // Offline / Local fallback (when Supabase is NOT configured)
      const localId = 'dare_' + Date.now().toString(36) + '_' + Math.random().toString(36).substring(2, 6);
      const localChallenge: Challenge = {
        id: localId,
        title: input.title,
        description: input.description,
        category: input.category,
        durationDays: input.durationDays,
        participants: 1,
        createdAt: now,
        endsAt,
        creator: input.creator || 'You',
        creatorId: null,
        joined: true,
        challengeType: input.challengeType || 'daily',
        timezone: input.timezone || 'UTC',
      };

      setChallenges((prev) => {
        const next = [localChallenge, ...prev];
        const publicNext = next.map((c) => ({ ...c, joined: false }));
        AsyncStorage.setItem(LOCAL_CHALLENGES_KEY, JSON.stringify(publicNext)).catch(() => {});
        return next;
      });

      setJoinedIds((prev) => {
        const next = new Set(prev);
        next.add(localId);
        const userJoinedKey = getJoinedKey(currentUserIdRef.current);
        AsyncStorage.setItem(userJoinedKey, JSON.stringify(Array.from(next))).catch(() => {});
        return next;
      });

      return localChallenge;
    },
    [currentUserId],
  );

  const joinChallenge = useCallback(
    async (id: string): Promise<{ success: boolean; joined: boolean; error?: string }> => {
      const challenge = challenges.find((c) => c.id === id);
      const currentlyJoined = joinedIds.has(id);
      const targetJoined = !currentlyJoined;
      const initialUid = currentUserIdRef.current;

      // Optimistic update
      setJoinedIds((prev) => {
        const next = new Set(prev);
        if (targetJoined) {
          next.add(id);
        } else {
          next.delete(id);
        }
        const userJoinedKey = getJoinedKey(initialUid);
        AsyncStorage.setItem(userJoinedKey, JSON.stringify(Array.from(next))).catch(() => {});
        return next;
      });

      setChallenges((prev) =>
        prev.map((c) =>
          c.id === id
            ? {
                ...c,
                joined: targetJoined,
                participants: targetJoined ? c.participants + 1 : Math.max(0, c.participants - 1),
              }
            : c,
        ),
      );

      // If connected to Supabase, synchronize with challenge_participants
      if (isSupabaseConfigured && supabase) {
        let authUserId = initialUid;
        try {
          authUserId = await ensureAuthenticatedUser();
          if (authUserId !== currentUserIdRef.current) {
            currentUserIdRef.current = authUserId;
            setCurrentUserId(authUserId);
          }
        } catch (authErr: any) {
          // Revert optimistic update
          setJoinedIds((prev) => {
            const next = new Set(prev);
            if (currentlyJoined) next.add(id);
            else next.delete(id);
            const userJoinedKey = getJoinedKey(currentUserIdRef.current);
            AsyncStorage.setItem(userJoinedKey, JSON.stringify(Array.from(next))).catch(() => {});
            return next;
          });
          setChallenges((prev) =>
            prev.map((c) =>
              c.id === id
                ? {
                    ...c,
                    joined: currentlyJoined,
                    participants: challenge ? challenge.participants : c.participants,
                  }
                : c,
            ),
          );
          return {
            success: false,
            joined: currentlyJoined,
            error: authErr?.message || 'Authentication required to join challenge.',
          };
        }

        // Race check: confirm user didn't switch or log out
        if (currentUserIdRef.current !== authUserId) {
          return {
            success: false,
            joined: currentlyJoined,
            error: 'User session changed during operation.',
          };
        }

        try {
          if (targetJoined) {
            const { error: joinErr } = await supabase.from('challenge_participants').insert({
              challenge_id: id,
              user_id: authUserId,
            } as any);

            // Ignore duplicate key violation (already joined)
            if (joinErr && !joinErr.message.includes('unique') && !joinErr.code?.includes('23505')) {
              throw joinErr;
            }
          } else {
            const { error: leaveErr } = await supabase
              .from('challenge_participants')
              .delete()
              .eq('challenge_id', id)
              .eq('user_id', authUserId);

            if (leaveErr) throw leaveErr;
          }

          // Confirm identity hasn't changed during remote network call
          if (currentUserIdRef.current !== authUserId) {
            return { success: false, joined: currentlyJoined, error: 'User session changed' };
          }

          // Refresh authoritative participant count from challenges table (updated by trigger)
          try {
            const { data: updatedChallenge } = await supabase
              .from('challenges')
              .select('participants_count')
              .eq('id', id)
              .single();

            if (updatedChallenge && typeof updatedChallenge.participants_count === 'number') {
              setChallenges((prev) =>
                prev.map((c) =>
                  c.id === id
                    ? { ...c, participants: Math.max(0, updatedChallenge.participants_count!) }
                    : c,
                ),
              );
            }
          } catch {
            // Keep optimistic count if fetch fails
          }

          return { success: true, joined: targetJoined };
        } catch (err: any) {
          // Revert optimistic update on hard error
          setJoinedIds((prev) => {
            const next = new Set(prev);
            if (currentlyJoined) next.add(id);
            else next.delete(id);
            const userJoinedKey = getJoinedKey(authUserId);
            AsyncStorage.setItem(userJoinedKey, JSON.stringify(Array.from(next))).catch(() => {});
            return next;
          });

          setChallenges((prev) =>
            prev.map((c) =>
              c.id === id
                ? {
                    ...c,
                    joined: currentlyJoined,
                    participants: challenge ? challenge.participants : c.participants,
                  }
                : c,
            ),
          );

          return { success: false, joined: currentlyJoined, error: err?.message || 'Failed to update membership' };
        }
      }

      return { success: true, joined: targetJoined };
    },
    [challenges, joinedIds],
  );

  const isUserJoined = useCallback(
    (id: string) => {
      return joinedIds.has(id);
    },
    [joinedIds],
  );

  const submitCompletion = useCallback(
    async (params: {
      challengeId: string;
      verifierId: string;
      completionDate: string;
      submissionNote?: string;
    }): Promise<{ success: boolean; error?: string; completion?: DbCompletion }> => {
      if (isSupabaseConfigured && supabase) {
        try {
          await ensureAuthenticatedUser();
          const { data, error: rpcErr } = await supabase.rpc('submit_challenge_completion', {
            p_challenge_id: params.challengeId,
            p_verifier_id: params.verifierId,
            p_completion_date: params.completionDate,
            p_submission_note: params.submissionNote?.trim() || null,
          });

          if (rpcErr) {
            let userMsg = rpcErr.message;
            if (rpcErr.code === '23505' || rpcErr.message.includes('already')) {
              if (rpcErr.message.includes('pending')) {
                userMsg = 'A submission for this date/dare is already pending verification.';
              } else if (rpcErr.message.includes('approved')) {
                userMsg = 'This completion date/dare has already been approved!';
              } else {
                userMsg = 'A submission already exists for this challenge date.';
              }
            } else if (rpcErr.code === '42501') {
              userMsg = 'You must be an active participant to submit proof.';
            } else if (rpcErr.code === '22023') {
              userMsg = rpcErr.message;
            }
            return { success: false, error: userMsg };
          }

          return { success: true, completion: data as DbCompletion };
        } catch (err: any) {
          return { success: false, error: err?.message || 'Failed to submit challenge completion' };
        }
      }

      // Offline / Local mock fallback
      const offlineCompletion: DbCompletion = {
        id: 'local_comp_' + Date.now().toString(36),
        challenge_id: params.challengeId,
        challenge_type: 'daily',
        participant_id: currentUserIdRef.current || 'local_user',
        verifier_id: params.verifierId,
        completion_date: params.completionDate,
        status: 'pending',
        submission_note: params.submissionNote?.trim() || null,
        rejection_reason: null,
        submitted_at: new Date().toISOString(),
        reviewed_at: null,
      };

      try {
        const userCompKey = getCompletionsKey(currentUserIdRef.current);
        const stored = await AsyncStorage.getItem(userCompKey);
        const list: DbCompletion[] = stored ? JSON.parse(stored) : [];
        list.unshift(offlineCompletion);
        await AsyncStorage.setItem(userCompKey, JSON.stringify(list));
      } catch {
        // Ignore local storage error
      }

      return { success: true, completion: offlineCompletion };
    },
    [],
  );

  const fetchCompletions = useCallback(
    async (challengeId: string): Promise<DbCompletion[]> => {
      if (isSupabaseConfigured && supabase) {
        try {
          await ensureAuthenticatedUser();
          const { data, error: fetchErr } = await supabase
            .from('challenge_completions')
            .select('*')
            .eq('challenge_id', challengeId)
            .order('completion_date', { ascending: false })
            .order('submitted_at', { ascending: false });

          if (fetchErr) {
            console.warn('[DareDrop] Failed to fetch completions:', fetchErr.message);
            return [];
          }
          return (data || []) as DbCompletion[];
        } catch {
          return [];
        }
      }

      try {
        const userCompKey = getCompletionsKey(currentUserIdRef.current);
        const stored = await AsyncStorage.getItem(userCompKey);
        if (stored) {
          const list: DbCompletion[] = JSON.parse(stored);
          return list.filter((c) => c.challenge_id === challengeId);
        }
      } catch {
        // Ignore
      }
      return [];
    },
    [],
  );

  const fetchEligibleVerifiers = useCallback(
    async (challengeId: string): Promise<EligibleVerifier[]> => {
      if (isSupabaseConfigured && supabase) {
        try {
          await ensureAuthenticatedUser();
          const { data, error: rpcErr } = await supabase.rpc('get_challenge_eligible_verifiers', {
            p_challenge_id: challengeId,
          });

          if (rpcErr) {
            console.warn('[DareDrop] Failed to fetch eligible verifiers:', rpcErr.message);
            return [];
          }
          return (data || []) as EligibleVerifier[];
        } catch {
          return [];
        }
      }

      return [
        { user_id: 'mock_creator', display_name: 'Referee (Creator)', is_creator: true },
      ];
    },
    [],
  );

  const fetchParticipantProgress = useCallback(
    async (challengeId: string, userId?: string): Promise<ParticipantProgress | null> => {
      if (isSupabaseConfigured && supabase) {
        try {
          const targetUser = userId || (await ensureAuthenticatedUser());
          const { data, error: rpcErr } = await supabase.rpc('get_participant_challenge_progress', {
            p_challenge_id: challengeId,
            p_user_id: targetUser,
          });

          if (rpcErr) {
            console.warn('[DareDrop] Failed to fetch participant progress:', rpcErr.message);
            return null;
          }
          if (data && data.length > 0) {
            return data[0] as ParticipantProgress;
          }
          return null;
        } catch {
          return null;
        }
      }

      return null;
    },
    [],
  );

  const reassignVerifier = useCallback(
    async (
      completionId: string,
      newVerifierId: string,
    ): Promise<{ success: boolean; error?: string; completion?: DbCompletion }> => {
      if (isSupabaseConfigured && supabase) {
        try {
          await ensureAuthenticatedUser();
          const { data, error: rpcErr } = await supabase.rpc('reassign_challenge_verifier', {
            p_completion_id: completionId,
            p_new_verifier_id: newVerifierId,
          });

          if (rpcErr) {
            return { success: false, error: rpcErr.message };
          }
          return { success: true, completion: data as DbCompletion };
        } catch (err: any) {
          return { success: false, error: err?.message || 'Failed to reassign verifier' };
        }
      }

      return { success: true };
    },
    [],
  );

  // Pending reviews: submissions assigned to the signed-in user as verifier.
  // RLS on challenge_completions only returns rows where the caller is submitter, verifier, or challenge
  // creator; the explicit verifier_id filter narrows that to reviews this user can actually act on.
  const refreshPendingReviews = useCallback(async (): Promise<PendingReview[]> => {
    if (!isSupabaseConfigured || !supabase) {
      setPendingReviews([]);
      return [];
    }

    setPendingReviewsLoading(true);
    try {
      const uid = await ensureAuthenticatedUser();
      const { data, error: fetchErr } = await supabase
        .from('challenge_completions')
        .select('*')
        .eq('verifier_id', uid)
        .eq('status', 'pending')
        .order('submitted_at', { ascending: true });

      if (fetchErr) throw fetchErr;
      const rows = (data || []) as DbCompletion[];

      // Resolve challenge titles/creator names (challenges are publicly readable)
      const challengesById: Record<string, ReviewChallengeInfo> = {};
      challengesRef.current.forEach((c) => {
        challengesById[c.id] = { id: c.id, title: c.title, creatorId: c.creatorId ?? null, creator: c.creator };
      });
      const missingIds = Array.from(new Set(rows.map((r) => r.challenge_id))).filter(
        (cid) => !challengesById[cid],
      );
      if (missingIds.length > 0) {
        const { data: extra } = await supabase
          .from('challenges')
          .select('id, title, creator_id, creator_name')
          .in('id', missingIds);
        (extra || []).forEach((c: any) => {
          challengesById[c.id] = {
            id: c.id,
            title: c.title,
            creatorId: c.creator_id ?? null,
            creator: c.creator_name || 'Anonymous',
          };
        });
      }

      const list = buildPendingReviews(rows, challengesById, uid);
      setPendingReviews(list);
      setPendingReviewsError(null);
      return list;
    } catch (err: any) {
      console.warn('[DareDrop] Failed to fetch pending reviews:', err?.message);
      setPendingReviewsError(err?.message || 'Could not load pending reviews');
      return [];
    } finally {
      setPendingReviewsLoading(false);
    }
  }, []);

  const fetchCompletionById = useCallback(
    async (completionId: string): Promise<DbCompletion | null> => {
      if (!isSupabaseConfigured || !supabase) return null;
      try {
        await ensureAuthenticatedUser();
        // RLS returns nothing unless the caller is the submitter, assigned verifier, or challenge creator
        const { data, error: fetchErr } = await supabase
          .from('challenge_completions')
          .select('*')
          .eq('id', completionId)
          .maybeSingle();
        if (fetchErr) {
          console.warn('[DareDrop] Failed to fetch completion:', fetchErr.message);
          return null;
        }
        return (data as DbCompletion) || null;
      } catch {
        return null;
      }
    },
    [],
  );

  const reviewCompletion = useCallback(
    async (params: {
      completionId: string;
      decision: ReviewDecision;
      rejectionReason?: string | null;
    }): Promise<{ success: boolean; error?: string; completion?: DbCompletion }> => {
      if (!isSupabaseConfigured || !supabase) {
        return { success: false, error: 'Reviewing submissions requires a Supabase connection.' };
      }
      try {
        await ensureAuthenticatedUser();
        const args = buildReviewRpcArgs(params.completionId, params.decision, params.rejectionReason);
        // Server enforces: assigned verifier only, no self-verification, pending-only, active membership
        const { data, error: rpcErr } = await supabase.rpc('review_challenge_completion', args);
        if (rpcErr) {
          return { success: false, error: translateReviewError(rpcErr) };
        }
        refreshPendingReviews().catch(() => {});
        return { success: true, completion: data as DbCompletion };
      } catch (err: any) {
        return { success: false, error: err?.message || 'Failed to submit your review.' };
      }
    },
    [refreshPendingReviews],
  );

  // Supabase Realtime subscription for pending reviews
  // Automatically keeps pending review requests in sync across devices
  useEffect(() => {
    if (!isSupabaseConfigured || !supabase || !currentUserId) return;

    const channelName = buildCompletionsChannelName('pending-reviews', currentUserId);
    const unsubscribe = subscribeToCompletions({
      supabase,
      channelName,
      debounceMs: 200,
      onEvent: () => {
        refreshPendingReviews().catch(() => {});
      },
      onStatusChange: (status) => {
        if (status === 'SUBSCRIBED') {
          refreshPendingReviews().catch(() => {});
        }
      },
    });

    const appStateSub = AppState.addEventListener('change', (nextState) => {
      if (nextState === 'active') {
        refreshPendingReviews().catch(() => {});
        refreshUnreadNotificationsCount().catch(() => {});
      }
    });

    return () => {
      appStateSub.remove();
      unsubscribe();
    };
  }, [currentUserId, refreshPendingReviews, refreshUnreadNotificationsCount]);

  // Supabase Auth lifecycle handler: ensures complete account isolation across logins, logouts, and user switches
  useEffect(() => {
    if (!isSupabaseConfigured || !supabase) return;

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange(async (event, session) => {
      // Ignore background token refresh events that don't alter the user identity
      if (event === 'TOKEN_REFRESHED') return;

      const newUid = session?.user?.id || '';

      if (event === 'SIGNED_OUT' || !newUid) {
        // User logged out: immediately clear all user-specific in-memory state
        currentUserIdRef.current = '';
        setCurrentUserId('');
        setJoinedIds(new Set());
        setPendingReviews([]);
        setUnreadNotificationsCount(0);
        setChallenges((prev) => prev.map((c) => ({ ...c, joined: false })));

        // Pre-load clean guest-scoped joined state if any exists locally
        const guestJoinedKey = getJoinedKey('guest');
        try {
          const cached = await AsyncStorage.getItem(guestJoinedKey);
          if (cached && !currentUserIdRef.current) {
            const parsed = JSON.parse(cached);
            if (Array.isArray(parsed)) {
              setJoinedIds(new Set(parsed));
            }
          }
        } catch {}

        // Reload public challenges for guest mode without any user membership
        await loadChallenges('');
      } else if (newUid !== currentUserIdRef.current || event === 'SIGNED_IN') {
        // Genuine user change or fresh sign-in: isolate new user from previous user
        currentUserIdRef.current = newUid;
        setCurrentUserId(newUid);
        setJoinedIds(new Set());
        setPendingReviews([]);
        setUnreadNotificationsCount(0);

        // Pre-load user-scoped cache immediately for fast rendering
        const userJoinedKey = getJoinedKey(newUid);
        try {
          const cached = await AsyncStorage.getItem(userJoinedKey);
          if (cached && currentUserIdRef.current === newUid) {
            const parsed = JSON.parse(cached);
            if (Array.isArray(parsed)) {
              setJoinedIds(new Set(parsed));
            }
          }
        } catch {}

        // Load authoritative data for the new user
        await loadChallenges(newUid);
        refreshPendingReviews().catch(() => {});
        refreshUnreadNotificationsCount().catch(() => {});
      }
    });

    return () => {
      subscription.unsubscribe();
    };
  }, [loadChallenges, refreshPendingReviews, refreshUnreadNotificationsCount]);

  return (
    <ChallengesContext.Provider
      value={{
        challenges,
        loading,
        refreshing,
        error,
        isBackendConnected: isSupabaseConfigured,
        currentUserId,
        refreshChallenges,
        createChallenge,
        addChallenge: createChallenge,
        joinChallenge,
        fetchChallengeById,
        isUserJoined,
        submitCompletion,
        fetchCompletions,
        fetchEligibleVerifiers,
        fetchParticipantProgress,
        reassignVerifier,
        pendingReviews,
        pendingReviewsLoading,
        pendingReviewsError,
        refreshPendingReviews,
        fetchCompletionById,
        reviewCompletion,
        unreadNotificationsCount,
        refreshUnreadNotificationsCount,
        decrementUnreadCount,
      }}>
      {children}
    </ChallengesContext.Provider>
  );
}

export function useChallenges() {
  const ctx = useContext(ChallengesContext);
  if (!ctx) throw new Error('useChallenges must be used within ChallengesProvider');
  return ctx;
}
