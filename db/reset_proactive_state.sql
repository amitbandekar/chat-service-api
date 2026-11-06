-- One-time cleanup after the 2026-11-02 bombardment.
--
-- What happened: scheduled_topics / topic_cadence were seeded with
-- back-dated timestamps, so every reminder was instantly "overdue".
-- That evening the bot sent 4 unsolicited messages in ~6 hours
-- (inactivity nudge 20:59, workout 22:32, interview 23:32, affection 02:32 IST).
--
-- This script staggers the next due dates instead of letting everything
-- fire together again. Safe to re-run; does not touch chat_turns.
--
-- Run on the Render database once (psql):
--   psql "$DATABASE_URL" -f db/reset_proactive_state.sql
-- Or set env RESET_PROACTIVE_STATE=true on Render once and redeploy.

-- 1) Stagger scheduled reminders so none is immediately due again:
--    interview_prep due again in ~2 days
UPDATE scheduled_topics
SET last_triggered_at = now() - INTERVAL '2 days'
WHERE topic_name = 'interview_prep';

--    affection_love due again in ~2.5 days
UPDATE scheduled_topics
SET last_triggered_at = now() - INTERVAL '2 days 12 hours'
WHERE topic_name = 'affection_love';

--    exercise_workout due again in ~5 days
UPDATE scheduled_topics
SET last_triggered_at = now() - INTERVAL '5 days'
WHERE topic_name = 'exercise_workout';

-- 2) Refresh topic cooldowns (food / good-morning / good-night restricted
--    for ~2 more days so the cooldown system can resume cleanly).
UPDATE topic_cadence SET last_sent_at = now() - INTERVAL '1 day';
