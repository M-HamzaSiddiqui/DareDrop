export type Category = 'Fitness' | 'Focus' | 'Fun' | 'Learning';

export interface Challenge {
  id: string;
  title: string;
  description: string;
  category: Category;
  durationDays: number;
  participants: number;
  createdAt: Date;
  endsAt: Date;
  creator: string;
  creatorId?: string | null;
  joined: boolean;
  challengeType: 'daily' | 'one_time';
  timezone: string;
}

/**
 * Returns today's and yesterday's calendar dates (YYYY-MM-DD) in the challenge's timezone.
 */
export function getChallengeDates(timeZone: string = 'UTC'): { today: string; yesterday: string } {
  try {
    const formatter = new Intl.DateTimeFormat('en-CA', {
      timeZone: timeZone || 'UTC',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
    const now = new Date();
    const today = formatter.format(now);
    const yesterday = formatter.format(new Date(now.getTime() - 24 * 60 * 60 * 1000));
    return { today, yesterday };
  } catch {
    const today = new Date().toISOString().split('T')[0];
    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().split('T')[0];
    return { today, yesterday };
  }
}

const now = new Date();

function daysFromNow(days: number) {
  const d = new Date(now);
  d.setDate(d.getDate() + days);
  return d;
}

const RAW_MOCK_CHALLENGES = [
  {
    id: '1',
    title: '30-Day Push-Up Challenge',
    description:
      'Start with 10 push-ups on day 1 and add 5 more each day. Build real upper-body strength in just one month.',
    category: 'Fitness',
    durationDays: 30,
    participants: 1243,
    createdAt: new Date(now.getTime() - 5 * 24 * 60 * 60 * 1000),
    endsAt: daysFromNow(25),
    creator: 'Alex K.',
    joined: false,
  },
  {
    id: '2',
    title: 'No-Phone Morning Hour',
    description:
      'Keep your phone off for the first hour after waking up. Journal, stretch, or just breathe. Reclaim your mornings.',
    category: 'Focus',
    durationDays: 21,
    participants: 876,
    createdAt: new Date(now.getTime() - 3 * 24 * 60 * 60 * 1000),
    endsAt: daysFromNow(18),
    creator: 'Maya R.',
    joined: false,
  },
  {
    id: '3',
    title: 'Cook Something New Every Week',
    description:
      'Try a recipe you\'ve never made before every week. Share a photo of your creation. Bonus points for exotic cuisines.',
    category: 'Fun',
    durationDays: 28,
    participants: 534,
    createdAt: new Date(now.getTime() - 8 * 24 * 60 * 60 * 1000),
    endsAt: daysFromNow(20),
    creator: 'Jamie L.',
    joined: false,
  },
  {
    id: '4',
    title: 'Read 15 Minutes Daily',
    description:
      'Pick a book — fiction, non-fiction, anything. Read for at least 15 minutes every day. Small habit, huge impact.',
    category: 'Learning',
    durationDays: 30,
    participants: 2108,
    createdAt: new Date(now.getTime() - 10 * 24 * 60 * 60 * 1000),
    endsAt: daysFromNow(20),
    creator: 'Sam T.',
    joined: true,
  },
  {
    id: '5',
    title: '5K in 30 Days',
    description:
      'Go from couch to running 5 kilometres. Follow the structured plan inside and track your daily progress.',
    category: 'Fitness',
    durationDays: 30,
    participants: 689,
    createdAt: new Date(now.getTime() - 2 * 24 * 60 * 60 * 1000),
    endsAt: daysFromNow(28),
    creator: 'Chris V.',
    joined: false,
  },
  {
    id: '6',
    title: 'Learn 3 New Words Daily',
    description:
      'Expand your vocabulary in any language. Use them in a sentence and share it. Fluency is just habit.',
    category: 'Learning',
    durationDays: 14,
    participants: 412,
    createdAt: new Date(now.getTime() - 1 * 24 * 60 * 60 * 1000),
    endsAt: daysFromNow(13),
    creator: 'Priya M.',
    joined: false,
  },
  {
    id: '7',
    title: 'Gratitude Journal Sprint',
    description:
      'Write 3 things you\'re grateful for every morning. Takes 2 minutes. Changes your whole day.',
    category: 'Focus',
    durationDays: 7,
    participants: 3219,
    createdAt: new Date(now.getTime() - 2 * 24 * 60 * 60 * 1000),
    endsAt: daysFromNow(5),
    creator: 'Dana W.',
    joined: false,
  },
  {
    id: '8',
    title: 'Random Act of Kindness',
    description:
      'Do one random act of kindness daily. Hold a door, buy someone coffee, or just smile more. Spread it.',
    category: 'Fun',
    durationDays: 14,
    participants: 927,
    createdAt: new Date(now.getTime() - 4 * 24 * 60 * 60 * 1000),
    endsAt: daysFromNow(10),
    creator: 'Taylor B.',
    joined: false,
  },
];

export const MOCK_CHALLENGES: Challenge[] = RAW_MOCK_CHALLENGES.map((c) => ({
  ...c,
  category: c.category as Category,
  challengeType: 'daily' as const,
  timezone: 'UTC',
  creatorId: null,
}));

export function timeRemaining(endsAt: Date): string {
  const diff = endsAt.getTime() - Date.now();
  if (diff <= 0) return 'Ended';
  const days = Math.floor(diff / (1000 * 60 * 60 * 24));
  if (days > 0) return `${days}d left`;
  const hours = Math.floor(diff / (1000 * 60 * 60));
  return `${hours}h left`;
}

export function formatParticipants(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

export function calculateProgress(createdAt: Date, durationDays: number): { daysElapsed: number; progressPct: number } {
  const elapsed = Math.max(0, Math.floor((Date.now() - createdAt.getTime()) / (1000 * 60 * 60 * 24)));
  const pct = Math.min(100, Math.round((elapsed / Math.max(1, durationDays)) * 100));
  return { daysElapsed: elapsed, progressPct: pct };
}
