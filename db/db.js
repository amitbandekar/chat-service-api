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

// ----------------- Reply queue ("no message remains unreplied") -----------------
// Every user message that fails to get an LLM reply is stored here and retried
// on a backoff schedule until answered. DB-backed so it survives restarts.

const QUEUE_FILE = path.join(ROOT, 'data', 'reply_queue.json');

function _readQueueFile() {
  try {
    if (fs.existsSync(QUEUE_FILE)) return JSON.parse(fs.readFileSync(QUEUE_FILE, 'utf-8'));
  } catch (e) {
    console.error('[DB] readQueueFile failed:', e.message);
  }
  return [];
}

function _writeQueueFile(list) {
  try {
    if (!fs.existsSync(path.dirname(QUEUE_FILE))) fs.mkdirSync(path.dirname(QUEUE_FILE), { recursive: true });
    fs.writeFileSync(QUEUE_FILE, JSON.stringify(list, null, 2), 'utf-8');
  } catch (e) {
    console.error('[DB] writeQueueFile failed:', e.message);
  }
}

/**
 * Create the reply_queue table when Postgres is enabled.
 * Returns 'db' or 'file' — which store backs the queue.
 */
async function ensureReplyQueue() {
  const pool = getPool();
  if (pool && isDbEnabled()) {
    try {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS reply_queue (
          id BIGSERIAL PRIMARY KEY,
          session_id UUID NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
          user_content TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','sent','failed')),
          attempts INT NOT NULL DEFAULT 0,
          last_error TEXT NOT NULL DEFAULT '',
          reply_content TEXT,
          source TEXT NOT NULL DEFAULT 'chat',
          created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          sent_at TIMESTAMPTZ
        )
      `);
      await pool.query('CREATE INDEX IF NOT EXISTS idx_reply_queue_due ON reply_queue (status, next_attempt_at)');
      return 'db';
    } catch (e) {
      console.error('[DB] ensureReplyQueue failed:', e.message);
    }
  }
  return 'file';
}

/** Add a pending reply job. Returns the job row. */
async function enqueueReply(sessionId, userContent, source = 'chat') {
  const pool = getPool();
  if (pool && isDbEnabled()) {
    try {
      const r = await pool.query(
        `INSERT INTO reply_queue (session_id, user_content, source)
         VALUES ($1, $2, $3) RETURNING *`,
        [sessionId || DEFAULT_SESSION_ID, userContent, source]
      );
      return r.rows[0];
    } catch (e) {
      console.error('[DB] enqueueReply failed, falling back to file:', e.message);
    }
  }
  // file fallback
  const list = _readQueueFile();
  let maxId = list.reduce((m, j) => Math.max(m, Number(j.id) || 0), 0);
  const row = {
    id: ++maxId,
    session_id: sessionId || DEFAULT_SESSION_ID,
    user_content: userContent,
    status: 'pending',
    attempts: 0,
    last_error: '',
    reply_content: null,
    source,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    next_attempt_at: new Date().toISOString(),
    sent_at: null,
  };
  list.push(row);
  _writeQueueFile(list);
  return row;
}

/** Oldest due pending jobs. */
async function getDueReplies(limit = 3) {
  const pool = getPool();
  if (pool && isDbEnabled()) {
    try {
      const r = await pool.query(
        `SELECT id, session_id, user_content, attempts, source, created_at
         FROM reply_queue
         WHERE status = 'pending' AND next_attempt_at <= now()
         ORDER BY created_at ASC
         LIMIT $1`,
        [limit]
      );
      return r.rows;
    } catch (e) {
      console.error('[DB] getDueReplies failed, falling back to file:', e.message);
    }
  }
  const nowMs = Date.now();
  return _readQueueFile()
    .filter((j) => j.status === 'pending' && new Date(j.next_attempt_at).getTime() <= nowMs)
    .sort((a, b) => new Date(a.created_at) - new Date(b.created_at))
    .slice(0, limit);
}

async function markReplySent(id, replyContent) {
  const pool = getPool();
  if (pool && isDbEnabled()) {
    try {
      await pool.query(
        `UPDATE reply_queue SET status='sent', reply_content=$2, sent_at=now(), updated_at=now() WHERE id=$1`,
        [id, replyContent]
      );
      return;
    } catch (e) {
      console.error('[DB] markReplySent failed:', e.message);
    }
  }
  const list = _readQueueFile();
  const job = list.find((j) => Number(j.id) === Number(id));
  if (job) {
    job.status = 'sent';
    job.reply_content = replyContent;
    job.sent_at = new Date().toISOString();
    _writeQueueFile(list);
  }
}

/** Move to pending with the next backoff slot. waitMinutes drives next_attempt_at. */
async function markReplyAttempt(id, attempts, waitMinutes, lastError) {
  const pool = getPool();
  if (pool && isDbEnabled()) {
    try {
      await pool.query(
        `UPDATE reply_queue
         SET attempts=$2, next_attempt_at = now() - INTERVAL '1 second' + ($3 || ' minutes')::interval,
             last_error=$4, updated_at=now(), status='pending'
         WHERE id=$1`,
        [id, attempts, String(waitMinutes), lastError || '']
      );
      return;
    } catch (e) {
      console.error('[DB] markReplyAttempt failed:', e.message);
    }
  }
  const list = _readQueueFile();
  const job = list.find((j) => Number(j.id) === Number(id));
  if (job) {
    job.attempts = attempts;
    job.last_error = lastError || '';
    job.next_attempt_at = new Date(Date.now() + waitMinutes * 60000).toISOString();
    _writeQueueFile(list);
  }
}

async function markReplyFailed(id, attempts, lastError) {
  const pool = getPool();
  if (pool && isDbEnabled()) {
    try {
      await pool.query(
        `UPDATE reply_queue SET status='failed', attempts=$2, last_error=$3, updated_at=now() WHERE id=$1`,
        [id, attempts, lastError || '']
      );
      return;
    } catch (e) {
      console.error('[DB] markReplyFailed failed:', e.message);
    }
  }
  const list = _readQueueFile();
  const job = list.find((j) => Number(j.id) === Number(id));
  if (job) {
    job.status = 'failed';
    job.attempts = attempts;
    job.last_error = lastError || '';
    _writeQueueFile(list);
  }
}

/** counts by status: { pending, sent, failed, total, store } */
async function getReplyQueueStats() {
  const pool = getPool();
  if (pool && isDbEnabled()) {
    try {
      const r = await pool.query(
        `SELECT count(*) FILTER (WHERE status='pending')::int AS pending,
                count(*) FILTER (WHERE status='sent')::int AS sent,
                count(*) FILTER (WHERE status='failed')::int AS failed,
                count(*)::int AS total
         FROM reply_queue`
      );
      return { ...r.rows[0], store: 'db' };
    } catch (e) {
      console.error('[DB] getReplyQueueStats failed:', e.message);
    }
  }
  const list = _readQueueFile();
  return {
    pending: list.filter((j) => j.status === 'pending').length,
    sent: list.filter((j) => j.status === 'sent').length,
    failed: list.filter((j) => j.status === 'failed').length,
    total: list.length,
    store: 'file',
  };
}

/**
 * Backfill: enqueue recent user turns that never got an assistant reply.
 * A turn counts as answered when an assistant turn arrives within 10 minutes.
 * Skips content already queued (unless its only job failed).
 * Returns the number of newly enqueued jobs.
 */
async function enqueueUnansweredTurns(days = 7) {
  const pool = getPool();
  if (pool && isDbEnabled()) {
    try {
      const r = await pool.query(
        `INSERT INTO reply_queue (session_id, user_content, source)
         SELECT t.session_id, t.content, 'reconcile'
         FROM chat_turns t
         WHERE t.role = 'user'
           AND t.created_at > now() - make_interval(days => $1)
           AND NOT EXISTS (
             SELECT 1 FROM chat_turns a
             WHERE a.session_id = t.session_id
               AND a.role = 'assistant'
               AND a.created_at >= t.created_at - interval '1 second'
               AND a.created_at <= t.created_at + interval '10 minutes'
           )
           AND NOT EXISTS (
             SELECT 1 FROM reply_queue q
             WHERE q.session_id = t.session_id
               AND q.user_content = t.content
               AND q.status <> 'failed'
           )
         RETURNING id`,
        [days]
      );
      return r.rowCount || 0;
    } catch (e) {
      console.error('[DB] enqueueUnansweredTurns failed, falling back to file:', e.message);
    }
  }

  // File fallback: scan the mirrored session file for trailing unanswered user turns
  const lines = fs.existsSync(SESSION_FILE)
    ? fs.readFileSync(SESSION_FILE, 'utf-8').split('\n').map((l) => l.trim()).filter(Boolean)
    : [];
  let entries = [];
  try {
    entries = lines.map((l) => JSON.parse(l));
  } catch (e) {
    return 0;
  }

  const cutoff = Date.now() - days * 86400000;
  const unanswered = [];
  entries.forEach((m) => {
    const ts = m.timestamp ? new Date(m.timestamp).getTime() : Date.now();
    if (m.role === 'user' && ts >= cutoff) {
      unanswered.push({ ...m, _ts: ts });
    }
    if (m.role === 'assistant') {
      for (let i = unanswered.length - 1; i >= 0; i--) {
        if (unanswered[i]._ts >= ts - 10 * 60000) {
          // assistant arrived after a recent-ish user turn — assume answers the newest
          unanswered.splice(i, 1);
          break;
        }
      }
    }
  });

  let count = 0;
  for (const u of unanswered) {
    const fresh = await enqueueReply(DEFAULT_SESSION_ID, u.content, 'reconcile');
    if (fresh) count += 1;
  }
  return count;
}

/**
 * Rolling chat memory — a compact natural-language summary of recent chats,
 * stored OUR side (this is the "context storage" the model API can't do).
 * summary = refreshed every REFRESH_EVERY user messages / on boot if missing.
 */
const MEMORY_FILE = path.join(ROOT, 'data', 'chat_memory.json');

async function ensureChatMemory() {
  const pool = getPool();
  if (pool && isDbEnabled()) {
    try {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS chat_memory (
          id SERIAL PRIMARY KEY,
          session_id UUID UNIQUE NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
          summary TEXT NOT NULL,
          through_user_count INT NOT NULL DEFAULT 0,
          updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )
      `);
      return true;
    } catch (e) {
      console.error('[DB] ensureChatMemory failed:', e.message);
    }
  }
  return false;
}

async function getChatMemory(sessionId = DEFAULT_SESSION_ID) {
  const pool = getPool();
  if (pool && isDbEnabled()) {
    try {
      const r = await pool.query('SELECT summary, through_user_count, updated_at FROM chat_memory WHERE session_id = $1', [sessionId]);
      return r.rows[0] || null;
    } catch (e) {
      console.error('[DB] getChatMemory failed:', e.message);
    }
  }
  try {
    if (fs.existsSync(MEMORY_FILE)) {
      const all = JSON.parse(fs.readFileSync(MEMORY_FILE, 'utf-8'));
      const row = all.find((m) => m.session_id === sessionId);
      return row || null;
    }
  } catch (e) { /* ignore */ }
  return null;
}

async function saveChatMemory(sessionId, summary, throughUserCount) {
  const pool = getPool();
  if (pool && isDbEnabled()) {
    try {
      await pool.query(
        `INSERT INTO chat_memory (session_id, summary, through_user_count, updated_at)
         VALUES ($1, $2, $3, now())
         ON CONFLICT (session_id) DO UPDATE SET summary = $2, through_user_count = $3, updated_at = now()`,
        [sessionId, summary, throughUserCount]
      );
      return true;
    } catch (e) {
      console.error('[DB] saveChatMemory failed:', e.message);
    }
  }
  try {
    let all = [];
    if (fs.existsSync(MEMORY_FILE)) all = JSON.parse(fs.readFileSync(MEMORY_FILE, 'utf-8'));
    const i = all.findIndex((m) => m.session_id === sessionId);
    const row = { session_id: sessionId, summary, through_user_count: throughUserCount, updated_at: new Date().toISOString() };
    if (i >= 0) all[i] = row; else all.push(row);
    if (!fs.existsSync(path.dirname(MEMORY_FILE))) fs.mkdirSync(path.dirname(MEMORY_FILE), { recursive: true });
    fs.writeFileSync(MEMORY_FILE, JSON.stringify(all, null, 2), 'utf-8');
    return true;
  } catch (e) {
    console.error('[DB] file saveChatMemory failed:', e.message);
    return false;
  }
}

/** total user turns in the session (staleness trigger) */
async function getUserTurnCount(sessionId = DEFAULT_SESSION_ID) {
  const pool = getPool();
  if (pool && isDbEnabled()) {
    try {
      const r = await pool.query("SELECT count(*)::int n FROM chat_turns WHERE session_id = $1 AND role = 'user'", [sessionId]);
      return r.rows[0].n;
    } catch (e) {
      console.error('[DB] getUserTurnCount failed:', e.message);
    }
  }
  try {
    if (fs.existsSync(SESSION_FILE)) {
      const lines = fs.readFileSync(SESSION_FILE, 'utf-8').split('\n').filter(Boolean);
      return lines.filter((l) => l.includes('"role":"user"') || l.includes('"role": "user"')).length;
    }
  } catch (e) { /* ignore */ }
  return 0;
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
  ensureReplyQueue,
  enqueueReply,
  getDueReplies,
  markReplySent,
  markReplyAttempt,
  markReplyFailed,
  getReplyQueueStats,
  enqueueUnansweredTurns,
  ensureChatMemory,
  getChatMemory,
  saveChatMemory,
  getUserTurnCount,
};
