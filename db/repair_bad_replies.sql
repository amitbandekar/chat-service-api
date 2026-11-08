-- One-time repair of "badly replied" assistant turns (Nov 6-7, 2026):
-- the model echoed the [HH:MM] history prefixes and they snowballed over turns
-- ("[16:30] [16:30] [16:30] Changa kela re"). Code now scrubs them, so this
-- script only cleans what is already stored.
--
-- Run on the Render database once (psql):
--   psql "$DATABASE_URL" -f db/repair_bad_replies.sql
-- Or set env REPAIR_BAD_REPLIES=true on Render once and redeploy.

-- 1) Strip echoed [HH:MM] prefixes from the last 4 days of assistant turns
UPDATE chat_turns
SET content = regexp_replace(content, '(\[\d{1,2}:\d{2}\]\s*)+', '', 'g')
WHERE role = 'assistant'
  AND created_at > now() - interval '4 days'
  AND content ~ '(\[\d{1,2}:\d{2}\]\s*)+';

-- 2) Remove the orphan one-word partial reply from Nov 8
DELETE FROM chat_turns
WHERE role = 'assistant'
  AND content = 'baghtey'
  AND created_at > now() - interval '3 days';
