/**
 * Central rate-limiter for proactive ("bot-initiated") messages, shared by
 * server.js (Render bot) and bot.js (whatsapp-web bot).
 *
 * Fixes the 2026-11-02 bombardment where the 8h inactivity nudge + all three
 * scheduled reminders stacked into one evening (4 unsolicited messages in ~6h
 * with zero replies in between).
 *
 * Budget (all windows are IST via timeService):
 *  - Max PROACTIVE_MAX_PER_DAY proactive messages per IST day (default 3)
 *  - Min PROACTIVE_MIN_GAP_HOURS between any two proactive messages (default 4)
 *  - Max NUDGE_MAX_PER_DAY inactivity nudges per IST day (default 1)
 */
const timeService = require('./timeService');

const PROACTIVE_MAX_PER_DAY = parseInt(process.env.PROACTIVE_MAX_PER_DAY || '3', 10);
const PROACTIVE_MIN_GAP_HOURS = parseFloat(process.env.PROACTIVE_MIN_GAP_HOURS || '4');
const NUDGE_MAX_PER_DAY = parseInt(process.env.NUDGE_MAX_PER_DAY || '1', 10);

const state = {
    dayKey: '',
    sends: [], // ISO timestamps of proactive messages sent today (IST)
    nudgeDayKey: '',
    nudgeCount: 0,
};

function _rollDay(now) {
    const day = timeService.istDayKey(now);
    if (state.dayKey !== day) {
        state.dayKey = day;
        state.sends = state.sends.filter((t) => timeService.istDayKey(new Date(t)) === day);
    }
}

/**
 * Whether a proactive message of `kind` ('nudge' | 'other') may be sent now.
 * Never throws — always answers with true/false and logs the reason.
 */
function canSend(now = new Date(), kind = 'other') {
    _rollDay(now);

    if (kind === 'nudge' && state.nudgeDayKey === timeService.istDayKey(now) && state.nudgeCount >= NUDGE_MAX_PER_DAY) {
        console.log('[PROACTIVE] Nudge already sent today (IST) — skipping.');
        return false;
    }

    if (state.sends.length >= PROACTIVE_MAX_PER_DAY) {
        console.log(`[PROACTIVE] Daily cap reached (${PROACTIVE_MAX_PER_DAY}/day IST) — skipping.`);
        return false;
    }

    const last = state.sends.length ? new Date(state.sends[state.sends.length - 1]).getTime() : 0;
    if (now.getTime() - last < PROACTIVE_MIN_GAP_HOURS * 3600000) {
        console.log(`[PROACTIVE] Minimum gap ${PROACTIVE_MIN_GAP_HOURS}h not met since last proactive message — skipping.`);
        return false;
    }

    return true;
}

/**
 * Reserve budget BEFORE the send attempt so a persistently failing LLM call
 * cannot retry-spam every 3 minutes. Safe to call even when send() has not
 * finished — the next eligible slot is simply after the min gap.
 */
function recordSend(now = new Date(), kind = 'other') {
    _rollDay(now);
    state.sends.push(now.toISOString());
    if (kind === 'nudge') {
        const day = timeService.istDayKey(now);
        if (state.nudgeDayKey !== day) {
            state.nudgeDayKey = day;
            state.nudgeCount = 0;
        }
        state.nudgeCount += 1;
    }
}

module.exports = {
    canSend,
    recordSend,
    PROACTIVE_MAX_PER_DAY,
    PROACTIVE_MIN_GAP_HOURS,
    NUDGE_MAX_PER_DAY,
};
