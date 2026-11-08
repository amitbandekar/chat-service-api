/**
 * Rolling memory service — OUR-side "context storage".
 * Keeps a ~160-word natural-language summary of the recent chat in
 * chat_memory (DB/file) and refreshes it every REFRESH_EVERY_USER user
 * messages. That summary is injected into every system prompt as block D,
 * so replacing the model/provider never loses the character's memory.
 */
const db = require('../db/db');

const REFRESH_EVERY_USER = parseInt(process.env.MEMORY_REFRESH_EVERY || '8', 10);
const SUMMARY_MAX_WORDS = process.env.MEMORY_MAX_WORDS || '160';

let refreshBusy = false;

const SUMMARY_PROMPT = (turnsText) => `
You maintain the memory of a WhatsApp chatbot persona "Rutuja" who chats in Romanized Marathi with her friend Amit.

Below is the recent chat so far. Write a rolling-memory summary in SIMPLE ENGLISH (max ${SUMMARY_MAX_WORDS} words) to be injected into future prompts.

CRITICAL: We are replacing the chatbot backend. Any details Amit shared about himself, his family, his plans, and current events (like festivals, holidays, being at home, exams, work) MUST be captured EXACTLY — this survives model/provider swaps. 
Example: if Amit says he is on Diwali holidays at home, or is suffering with exams, or is travelling — that MUST appear in the memory.

Include: topics talked about, facts about both people, moods/plans, unfinished stories, promises in chat, anything important now. Exclude filler/greetings/chatting chit-chat. Output ONLY the summary text, third person (e.g., "Amit is ...", "Rutuja told ..."), no markdown.

CHAT:
${turnsText}
`;

function _turnsText(rows) {
    return rows
        .map((r) => `${(r.role === 'user' ? 'Amit' : 'Rutuja')}: ${r.content}`)
        .join('\n')
        .slice(0, 14000);
}

/** True when the stored summary is missing or >= N user messages old. */
async function isStale(sessionId = db.DEFAULT_SESSION_ID) {
    const row = await db.getChatMemory(sessionId);
    if (!row || !row.summary || !row.summary.trim()) return true;
    const currentUserCount = await db.getUserTurnCount(sessionId);
    const through = Number(row.through_user_count) || 0;
    return currentUserCount - through >= REFRESH_EVERY_USER;
}

/**
 * Generate + store the memory summary if stale (skips while one run is busy).
 * `llmCall(textPrompt) -> string` is injected by the caller (server/bot).
 * Returns the current summary text (fresh or cached).
 */
async function refreshIfNeeded(sessionId = db.DEFAULT_SESSION_ID, llmCall, force = false) {
    const stale = force ? true : await isStale(sessionId);
    if (!stale) {
        const row = await db.getChatMemory(sessionId);
        return row ? row.summary : '';
    }
    if (refreshBusy) {
        const row = await db.getChatMemory(sessionId);
        return row ? row.summary : '';
    }

    refreshBusy = true;
    try {
        const rows = await db.loadRecentTurns(60, sessionId);
        if (!rows.length) return '';

        const through = await db.getUserTurnCount(sessionId);
        const summary = (await llmCall(SUMMARY_PROMPT(_turnsText(rows))))?.trim();
        if (summary && summary.length > 30) {
            await db.saveChatMemory(sessionId, summary, through);
            console.log(`[MEMORY] Rolling summary refreshed (${summary.split(/\s+/).length} words, through user msg #${through}).`);
            return summary;
        }
        console.warn('[MEMORY] Summarizer returned empty/short output — keeping old summary.');
        const row = await db.getChatMemory(sessionId);
        return row ? row.summary : '';
    } catch (e) {
        console.error('[MEMORY] Refresh failed:', e.message);
        const row = await db.getChatMemory(sessionId);
        return row ? row.summary : '';
    } finally {
        refreshBusy = false;
    }
}

module.exports = { refreshIfNeeded, isStale, REFRESH_EVERY_USER };
