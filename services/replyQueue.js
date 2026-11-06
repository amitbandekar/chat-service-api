/**
 * Reply queue orchestrator — "no message remains unreplied".
 *
 * Any user message whose LLM reply fails is persisted (Postgres, file fallback)
 * and retried with exponential backoff until it gets an answer:
 *   1m → 5m → 15m → 30m → 1h → 1h ... (cap REPLY_MAX_ATTEMPTS, default 8)
 *
 * This service only manages queue state; generating replies and logging them
 * is the caller's `generate(job)` callback so server.js can reuse its own
 * system-prompt/history logic.
 */
const db = require('../db/db');

const MAX_ATTEMPTS = parseInt(process.env.REPLY_MAX_ATTEMPTS || '8', 10);
const BACKOFF_MINUTES = [1, 5, 15, 30, 60];
const PROCESS_BATCH = 3;

function backoffMinutes(value) {
    if (value <= BACKOFF_MINUTES.length) {
        return BACKOFF_MINUTES[value - 1];
    }
    return BACKOFF_MINUTES[BACKOFF_MINUTES.length - 1];
}

/** Queue a user message for (re)reply. */
async function enqueueReply(userContent, source = 'chat', sessionId = db.DEFAULT_SESSION_ID) {
    if (!userContent || !userContent.trim()) return null;
    return db.enqueueReply(sessionId, userContent.trim(), source);
}

/**
 * Process up to 3 due jobs, oldest first.
 * `generate(job)` must return the reply text (or throw). On success the caller
 * has already logged the assistant turn + pushed — the queue only records 'sent'.
 */
async function processDue(generate) {
    const jobs = await db.getDueReplies(PROCESS_BATCH);
    let sent = 0;
    let late = 0;

    for (const job of jobs) {
        try {
            const reply = await generate(job);
            if (!reply || !String(reply).trim()) {
                throw new Error('Empty reply from model');
            }
            await db.markReplySent(job.id, reply);
            sent += 1;
            // A "late" reply = anything that needed this queue at least once
            if ((job.attempts || 0) > 0 || job.source === 'reconcile') {
                late += 1;
            }
        } catch (e) {
            const attempts = (job.attempts || 0) + 1;
            const msg = (e && e.message) || String(e);
            if (attempts >= MAX_ATTEMPTS) {
                console.error(`[QUEUE] Job ${job.id} FAILED permanently after ${attempts} attempts (${msg}). User message: "${job.user_content}"`);
                await db.markReplyFailed(job.id, attempts, msg);
            } else {
                const waitMin = backoffMinutes(attempts);
                console.warn(`[QUEUE] Job ${job.id} will retry in ${waitMin}m (attempt ${attempts}/${MAX_ATTEMPTS}): ${msg}`);
                await db.markReplyAttempt(job.id, attempts, waitMin, msg);
            }
        }
    }

    const stats = await db.getReplyQueueStats();
    return {
        processed: jobs.length,
        repliedNow: sent,
        lateNow: late,
        pending: stats.pending,
        failed: stats.failed,
        total: stats.total,
        store: stats.store,
    };
}

module.exports = {
    enqueueReply,
    processDue,
    MAX_ATTEMPTS,
    BACKOFF_MINUTES,
    PROCESS_BATCH,
};
