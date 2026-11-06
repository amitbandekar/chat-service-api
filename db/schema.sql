-- Rutuja bot runtime-only schema
-- Source of truth for live chat. Files remain as backup/seed.
-- Run: psql $DATABASE_URL -f db/schema.sql

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

CREATE TABLE IF NOT EXISTS prompts (
  id SERIAL PRIMARY KEY,
  name TEXT UNIQUE NOT NULL,
  content_md TEXT NOT NULL,
  version INT NOT NULL DEFAULT 1,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS personas (
  id SERIAL PRIMARY KEY,
  name TEXT UNIQUE NOT NULL,
  data JSONB NOT NULL,
  version INT NOT NULL DEFAULT 1,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS life_contexts (
  id SERIAL PRIMARY KEY,
  name TEXT UNIQUE NOT NULL DEFAULT 'rutuja_life',
  data JSONB NOT NULL,
  version INT NOT NULL DEFAULT 1,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS chat_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  ended_at TIMESTAMPTZ,
  model TEXT,
  persona_version INT,
  metadata JSONB
);

CREATE TABLE IF NOT EXISTS chat_turns (
  id BIGSERIAL PRIMARY KEY,
  session_id UUID NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
  turn_id INT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'system')),
  content TEXT NOT NULL,
  score INT CHECK (score IS NULL OR (score BETWEEN 1 AND 10)),
  notes TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (session_id, turn_id, role)
);

CREATE INDEX IF NOT EXISTS idx_chat_turns_session_turn ON chat_turns (session_id, turn_id);
CREATE INDEX IF NOT EXISTS idx_chat_turns_created ON chat_turns (created_at DESC);

-- Topic cadence tracker to prevent repeating questions daily (enforces 3-4 days gap)
CREATE TABLE IF NOT EXISTS topic_cadence (
  id SERIAL PRIMARY KEY,
  topic_key TEXT UNIQUE NOT NULL,
  last_sent_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  min_cooldown_days INT NOT NULL DEFAULT 3
);

-- Scheduled check-ins (interview prep, love/affection, workout/exercise)
CREATE TABLE IF NOT EXISTS scheduled_topics (
  id SERIAL PRIMARY KEY,
  topic_name TEXT UNIQUE NOT NULL,
  interval_days INT NOT NULL,
  last_triggered_at TIMESTAMPTZ,
  active_start_hour INT NOT NULL DEFAULT 18,
  active_end_hour INT NOT NULL DEFAULT 22,
  prompt_instruction TEXT NOT NULL
);

-- Indian Cricket Match Tracker
CREATE TABLE IF NOT EXISTS cricket_matches (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  match_date DATE NOT NULL,
  status TEXT NOT NULL,
  result TEXT,
  key_performers JSONB,
  notified BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Single default session row used by bot.js (mirrors old session_master.jsonl single-file behavior)
INSERT INTO chat_sessions (id, model, metadata)
VALUES ('00000000-0000-0000-0000-000000000001', 'qwen/qwen3.8-max:free', '{"note": "default single session mirroring session_master.jsonl"}'::jsonb)
ON CONFLICT (id) DO NOTHING;

-- Single-row queue that guarantees no user message stays unanswered.
CREATE TABLE IF NOT EXISTS reply_queue (
  id BIGSERIAL PRIMARY KEY,
  session_id UUID NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
  user_content TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','sent','failed')),
  attempts INT NOT NULL DEFAULT 0,
  last_error TEXT NOT NULL DEFAULT '',
  reply_content TEXT,
  source TEXT NOT NULL DEFAULT 'chat', -- 'chat' = POST failure, 'reconcile' = boot backfill
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  sent_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_reply_queue_due ON reply_queue (status, next_attempt_at);

-- Seed initial scheduled topics
-- NOTE: last_triggered_at is seeded to now() (NOT back-dated). Back-dated seeds
-- made all three topics instantly overdue, so on 2026-11-02 three reminders +
-- the inactivity nudge stacked into one evening. If an existing DB is already
-- overdue, run db/reset_proactive_state.sql instead.
INSERT INTO scheduled_topics (topic_name, interval_days, last_triggered_at, active_start_hour, active_end_hour, prompt_instruction)
VALUES 
  ('interview_prep', 4, now(), 18, 22, 'Casually ask Amit about his interview preparation or coding practice progress in 1 short sentence (e.g., "Interview prep kiti zali?", "Coding practice chalu ahe na?").'),
  ('affection_love', 5, now(), 21, 23, 'Send a rare, short, sweet affectionate message with emoji to Amit (e.g., "Love you re ❤️", "Take care ha 🥺❤️") as per persona rules.'),
  ('exercise_workout', 10, now(), 17, 21, 'Casually ask Amit if he has been exercising or working out recently (e.g., "Workout / gym chalu ahe ka tuza?").')
ON CONFLICT (topic_name) DO NOTHING;

-- Seed initial topic cooldowns (also fresh, not back-dated)
INSERT INTO topic_cadence (topic_key, last_sent_at, min_cooldown_days)
VALUES 
  ('food_inquiry', now(), 3),
  ('good_morning', now(), 3),
  ('good_night', now(), 3)
ON CONFLICT (topic_key) DO NOTHING;
