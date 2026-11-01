// Verify DB matches files. Usage: node db/verify.js
const fs = require('fs');
const path = require('path');
const dotenv = require('dotenv');

dotenv.config();

const ROOT = path.join(__dirname, '..');

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error('DATABASE_URL is not set.');
    process.exit(1);
  }
  const { Pool } = require('pg');
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    const prompts = await pool.query("SELECT name, version, LENGTH(content_md) AS len FROM prompts WHERE name='opencode_rutuja_base'");
    const personas = await pool.query('SELECT name, version FROM personas');
    const life = await pool.query('SELECT name, version FROM life_contexts');
    const turns = await pool.query('SELECT COUNT(*)::int AS c, COALESCE(MAX(turn_id),0)::int AS maxturn FROM chat_turns');
    console.log('prompts:', prompts.rows);
    console.log('personas:', personas.rows);
    console.log('life_contexts:', life.rows);
    console.log('chat_turns:', turns.rows[0]);

    const fp = path.join(ROOT, 'OPENCODE_RUTUJA_PROMPT.md');
    const fsLen = fs.existsSync(fp) ? fs.readFileSync(fp, 'utf-8').length : -1;
    console.log('file OPENCODE_RUTUJA_PROMPT.md chars:', fsLen, '| db chars:', prompts.rows[0] ? Number(prompts.rows[0].len) : 'n/a');

    const sf = path.join(ROOT, 'chat_sessions', 'session_master.jsonl');
    const fileLines = fs.existsSync(sf) ? fs.readFileSync(sf, 'utf-8').split('\n').map((l) => l.trim()).filter(Boolean).length : 0;
    console.log('file session_master lines:', fileLines, '| db turns:', turns.rows[0].c);
    if (fileLines !== Number(turns.rows[0].c)) {
      console.warn('MISMATCH: re-run node db/migrate.js');
    } else {
      console.log('OK: DB matches files');
    }
  } finally {
    await pool.end();
  }
}

main().catch((e) => {
  console.error('[verify] failed:', e.message);
  process.exit(1);
});
