// One-shot seed: files -> Postgres (runtime-only). Idempotent.
// Usage: node db/migrate.js
// Requires: DATABASE_URL in .env, Postgres 17 running, db/schema.sql applied.
const fs = require('fs');
const path = require('path');
const dotenv = require('dotenv');

dotenv.config();

const ROOT = path.join(__dirname, '..');
const PROMPT_FILE = path.join(ROOT, 'OPENCODE_RUTUJA_PROMPT.md');
const PERSONA_CARD_FILE = path.join(ROOT, 'data', 'persona_card_rutu.json');
const LIFE_CONTEXT_FILE = path.join(ROOT, 'data', 'rutuja_life_context.json');
const SESSION_FILE = path.join(ROOT, 'chat_sessions', 'session_master.jsonl');

const DEFAULT_SESSION_ID = '00000000-0000-0000-0000-000000000001';

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error('DATABASE_URL is not set. Add it to .env first. See .env.example.');
    process.exit(1);
  }
  let pg;
  try {
    pg = require('pg');
  } catch (e) {
    console.error('npm package "pg" is not installed. Run: npm install pg');
    process.exit(1);
  }

  const schemaSql = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf-8');
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

  try {
    console.log('[migrate] applying schema...');
    await pool.query(schemaSql);

    const promptMd = fs.existsSync(PROMPT_FILE) ? fs.readFileSync(PROMPT_FILE, 'utf-8') : '';
    const personaRaw = fs.existsSync(PERSONA_CARD_FILE) ? fs.readFileSync(PERSONA_CARD_FILE, 'utf-8') : '{}';
    const lifeRaw = fs.existsSync(LIFE_CONTEXT_FILE) ? fs.readFileSync(LIFE_CONTEXT_FILE, 'utf-8') : '{}';

    let personaJson, lifeJson;
    try {
      personaJson = JSON.parse(personaRaw);
    } catch (e) {
      console.error('[migrate] persona_card_rutu.json is not valid JSON:', e.message);
      process.exit(1);
    }
    try {
      lifeJson = JSON.parse(lifeRaw);
    } catch (e) {
      console.error('[migrate] rutuja_life_context.json is not valid JSON:', e.message);
      process.exit(1);
    }

    await pool.query(
      `INSERT INTO prompts (name, content_md, version, is_active)
       VALUES ('opencode_rutuja_base', $1, 1, true)
       ON CONFLICT (name) DO UPDATE SET content_md = EXCLUDED.content_md, updated_at = now()`,
      [promptMd]
    );
    console.log('[migrate] prompts seeded');

    await pool.query(
      `INSERT INTO personas (name, data, version, is_active)
       VALUES ('persona_card_rutu', $1::jsonb, 1, true)
       ON CONFLICT (name) DO UPDATE SET data = EXCLUDED.data, updated_at = now()`,
      [JSON.stringify(personaJson)]
    );
    console.log('[migrate] personas seeded');

    await pool.query(
      `INSERT INTO life_contexts (name, data, version, is_active)
       VALUES ('rutuja_life', $1::jsonb, 1, true)
       ON CONFLICT (name) DO UPDATE SET data = EXCLUDED.data, updated_at = now()`,
      [JSON.stringify(lifeJson)]
    );
    console.log('[migrate] life_contexts seeded');

    // session turns
    if (fs.existsSync(SESSION_FILE)) {
      const lines = fs.readFileSync(SESSION_FILE, 'utf-8').split('\n').map((l) => l.trim()).filter(Boolean);
      let inserted = 0;
      for (const line of lines) {
        let m;
        try {
          m = JSON.parse(line);
        } catch (e) {
          console.warn('[migrate] skipping bad JSONL line:', e.message);
          continue;
        }
        if (!m.role || !m.content || typeof m.turn_id === 'undefined') continue;
        const score = typeof m.score_1_to_10 === 'number' ? m.score_1_to_10 : null;
        const notes = typeof m.notes === 'string' ? m.notes : '';
        const created = m.timestamp ? new Date(m.timestamp).toISOString() : new Date().toISOString();
        await pool.query(
          `INSERT INTO chat_turns (session_id, turn_id, role, content, score, notes, created_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7)
           ON CONFLICT (session_id, turn_id, role) DO NOTHING`,
          [DEFAULT_SESSION_ID, Number(m.turn_id), m.role, String(m.content), score, notes, created]
        );
        inserted += 1;
      }
      console.log(`[migrate] chat_turns seeded (${inserted} lines processed)`);
    } else {
      console.log('[migrate] no session_master.jsonl found, skipping turns');
    }

    console.log('[migrate] done. Files remain on disk as backup.');
  } finally {
    await pool.end();
  }
}

main().catch((e) => {
  console.error('[migrate] failed:', e.message);
  process.exit(1);
});
