const fs = require('fs');
const path = require('path');

let Pool = null;
try {
  ({ Pool } = require('pg'));
} catch (e) {
  // pg not installed yet — db.js will run in file-only mode
}

const DEFAULT_SESSION_ID = '00000000-0000-0000-0000-000000000001';

const ROOT = path.join(__dirname, '..');
const SESSION_FILE = path.join(ROOT, 'chat_sessions', 'session_master.jsonl');
const PERSONA_CARD_FILE = path.join(ROOT, 'data', 'persona_card_rutu.json');
const LIFE_CONTEXT_FILE = path.join(ROOT, 'data', 'rutuja_life_context.json');
const PROMPT_FILE = path.join(ROOT, 'OPENCODE_RUTUJA_PROMPT.md');

let _pool = null;

function getPool() {
  if (_pool) return _pool;
  if (!Pool) return null;
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) return null;
  _pool = new Pool({ connectionString });
  _pool.on('error', (err) => console.error('[DB] pool error:', err.message));
  return _pool;
}

function isDbEnabled() {
  return Boolean(process.env.DATABASE_URL && Pool);
}

function readFileSafe(p, fallback) {
  try {
    if (fs.existsSync(p)) return fs.readFileSync(p, 'utf-8');
  } catch (e) {
    console.error('[DB] file fallback read failed:', p, e.message);
  }
  return fallback;
}

async function getActivePrompt() {
  const pool = getPool();
  if (pool) {
    try {
      const r = await pool.query(
        "SELECT content_md FROM prompts WHERE name = 'opencode_rutuja_base' AND is_active ORDER BY version DESC LIMIT 1"
      );
      if (r.rows.length) return r.rows[0].content_md;
    } catch (e) {
      console.error('[DB] getActivePrompt failed, falling back to file:', e.message);
    }
  }
  return readFileSafe(PROMPT_FILE, '');
}

async function getPersona() {
  const pool = getPool();
  if (pool) {
    try {
      const r = await pool.query(
        "SELECT data FROM personas WHERE name = 'persona_card_rutu' AND is_active ORDER BY version DESC LIMIT 1"
      );
      if (r.rows.length) return JSON.stringify(r.rows[0].data);
    } catch (e) {
      console.error('[DB] getPersona failed, falling back to file:', e.message);
    }
  }
  return readFileSafe(PERSONA_CARD_FILE, '{}');
}

async function getLifeContext() {
  const pool = getPool();
  if (pool) {
    try {
      const r = await pool.query(
        "SELECT data FROM life_contexts WHERE name = 'rutuja_life' AND is_active ORDER BY version DESC LIMIT 1"
      );
      if (r.rows.length) return JSON.stringify(r.rows[0].data);
    } catch (e) {
      console.error('[DB] getLifeContext failed, falling back to file:', e.message);
    }
  }
  return readFileSafe(LIFE_CONTEXT_FILE, '{}');
}

// Returns [{role, content, timestamp}] oldest-first
async function loadRecentTurns(limit = 20, sessionId = DEFAULT_SESSION_ID) {
  const pool = getPool();
  if (pool) {
    try {
      const r = await pool.query(
        `SELECT turn_id, role, content, created_at FROM chat_turns
         WHERE session_id = $1 ORDER BY turn_id DESC, id DESC LIMIT $2`,
        [sessionId, limit * 2]
      );
      // turn_id is shared by user+assistant pair; sort ascending for history
      return r.rows.reverse().map((m) => ({
        role: m.role,
        content: m.content,
        timestamp: m.created_at ? new Date(m.created_at).toISOString() : undefined,
        turn_id: m.turn_id,
      }));
    } catch (e) {
      console.error('[DB] loadRecentTurns failed, falling back to file:', e.message);
    }
  }
  // file fallback mirrors old bot.js logic
  if (!fs.existsSync(SESSION_FILE)) return [];
  try {
    const lines = fs.readFileSync(SESSION_FILE, 'utf-8').split('\n').map((l) => l.trim()).filter(Boolean);
    const parsed = lines.map((l) => JSON.parse(l));
    return parsed.slice(-limit).map((m) => ({ role: m.role, content: m.content, timestamp: m.timestamp, turn_id: m.turn_id }));
  } catch (e) {
    console.error('[DB] file history read failed:', e.message);
    return [];
  }
}

async function getMaxTurnId(sessionId = DEFAULT_SESSION_ID) {
  const pool = getPool();
  if (pool) {
    try {
      const r = await pool.query('SELECT COALESCE(MAX(turn_id), 0) AS m FROM chat_turns WHERE session_id = $1', [sessionId]);
      return Number(r.rows[0].m) || 0;
    } catch (e) {
      console.error('[DB] getMaxTurnId failed:', e.message);
    }
  }
  return 0;
}

async function logTurn(turnId, role, content, sessionId = DEFAULT_SESSION_ID) {
  const pool = getPool();
  if (pool) {
    try {
      await pool.query(
        `INSERT INTO chat_turns (session_id, turn_id, role, content, score, notes)
         VALUES ($1, $2, $3, $4, NULL, '') ON CONFLICT (session_id, turn_id, role) DO NOTHING`,
        [sessionId, turnId, role, content]
      );
      return;
    } catch (e) {
      console.error('[DB] logTurn failed, falling back to file:', e.message);
    }
  }
  // file fallback (old behavior)
  try {
    const entry = { turn_id: turnId, role, content, timestamp: new Date().toISOString() };
    if (role === 'assistant') {
      entry.score_1_to_10 = null;
      entry.notes = '';
    }
    if (!fs.existsSync(path.dirname(SESSION_FILE))) fs.mkdirSync(path.dirname(SESSION_FILE), { recursive: true });
    fs.appendFileSync(SESSION_FILE, JSON.stringify(entry) + '\n', 'utf-8');
  } catch (e) {
    console.error('[DB] file logTurn failed:', e.message);
  }
}

async function closePool() {
  if (_pool) {
    await _pool.end();
    _pool = null;
  }
}

module.exports = {
  DEFAULT_SESSION_ID,
  getPool,
  isDbEnabled,
  getActivePrompt,
  getPersona,
  getLifeContext,
  loadRecentTurns,
  getMaxTurnId,
  logTurn,
  closePool,
};
