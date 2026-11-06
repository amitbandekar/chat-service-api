const express = require('express');
const cors = require('cors');
const path = require('path');
const dotenv = require('dotenv');
const OpenAI = require('openai');

dotenv.config();

const db = require('./db/db');
const cricketService = require('./services/cricketService');
const cadenceService = require('./services/cadenceService');
const notificationService = require('./services/notificationService');
const timeService = require('./services/timeService');
const llmClient = require('./services/llmClient');
const proactivePolicy = require('./services/proactivePolicy');
const replyQueue = require('./services/replyQueue');

const app = express();
app.use(cors());
app.use(express.json());

// Configuration
const PORT = process.env.PORT || 3000;
const XKIRO_API_KEY = process.env.XKIRO_API_KEY;
const XKIRO_BASE_URL = process.env.XKIRO_BASE_URL || 'https://api.xkiro.com/v1';
const MODEL_NAME = process.env.MODEL_NAME || 'qwen/qwen3.8-max:free';
const INACTIVITY_HOURS_THRESHOLD = parseFloat(process.env.INACTIVITY_HOURS_THRESHOLD || '8');

// Initialize OpenAI client pointing to Xkiro / OpenRouter
const openai = new OpenAI({
    apiKey: XKIRO_API_KEY,
    baseURL: XKIRO_BASE_URL,
});

// Runtime state
let lastMessageTimestamp = new Date();
let messageHistory = [];

/**
 * Load initial chat history on server start
 */
async function loadHistory() {
    try {
        const rows = await db.loadRecentTurns(30);
        messageHistory = rows.map(m => ({
            turn_id: m.turn_id,
            role: m.role,
            content: m.content,
            timestamp: m.timestamp || new Date().toISOString()
        }));

        if (rows.length > 0 && rows[rows.length - 1].timestamp) {
            const loadedTs = new Date(rows[rows.length - 1].timestamp);
            const clamped = timeService.clampRecent(loadedTs);
            if (clamped !== loadedTs) {
                console.log(`[SERVER] Stale last-message timestamp (${loadedTs.toISOString()}) clamped to ${clamped.toISOString()} (prevents "457 inactive hours" nudge on restart).`);
            }
            lastMessageTimestamp = clamped;
        }
        console.log(`[SERVER] Loaded ${messageHistory.length} messages from ${db.isDbEnabled() ? 'PostgreSQL' : 'session file'}.`);
    } catch (err) {
        console.error('[SERVER] History load error:', err.message);
    }
}

/**
 * Build dynamic system prompt with current local time, phase, and topic cooldown restrictions
 */
async function buildSystemPrompt() {
    const [personaCard, lifeContext, promptDoc, cadenceRestrictions] = await Promise.all([
        db.getPersona(),
        db.getLifeContext(),
        db.getActivePrompt(),
        cadenceService.getCadencePromptRestrictions()
    ]);

    const now = new Date();
    const timeStr = timeService.istTimeStr(now);
    const dayStr = timeService.istDayStr(now);

    return `
You are Rutuja (<NAME_B>, female), chatting casually with your friend Amit (<NAME_A>, male) on WhatsApp.
Current local time: ${timeStr} (${dayStr}).

## TOPIC COOLDOWN RESTRICTIONS (3-4 Days Gap):
${cadenceRestrictions || '- None currently active.'}

## GROUND TRUTH CONTEXT:
1. Persona Traits: ${personaCard}
2. Life Lore & Backstories: ${lifeContext}
3. System Instructions:
${promptDoc}

## CRITICAL RULES:
- Reply in 1 to 7 words.
- Natural, teasing, casual Marathi + English code-switching.
- No AI mentions, no breaking character.
- Gender grammar: You are Female ("mi zoptey", "thakle"), Amit is Male ("tu jevalas ka", "re").
`;
}

/**
 * Format message turns with timestamps for the LLM
 */
function formatMessagesForLLM(history) {
    return history.map(m => {
        // Timestamps shown to the LLM must be IST, not the server's UTC clock
        const time = m.timestamp ? timeService.istTimeStr(new Date(m.timestamp)) : '';
        const prefix = time ? `[${time}] ` : '';
        return {
            role: m.role,
            content: `${prefix}${m.content}`
        };
    });
}

/**
 * Generate LLM reply
 */
async function generateResponse(messages) {
    const systemPrompt = await buildSystemPrompt();
    const formatted = formatMessagesForLLM(messages);

    const response = await llmClient.chatCompletionWithRetry(openai, {
        model: MODEL_NAME,
        messages: [
            { role: 'system', content: systemPrompt },
            ...formatted
        ],
        temperature: 0.7,
        max_tokens: 60
    });

    let text = response.choices[0]?.message?.content?.trim() || 'Hi';
    text = text.replace(/^["']|["']$/g, '').trim();
    return text;
}

// ----------------- API ROUTES ----------------- //

// Health check endpoint for Render
app.get('/', (req, res) => {
    res.json({
        service: 'Rutuja WhatsApp Bot API',
        status: 'online',
        database: db.isDbEnabled() ? 'PostgreSQL' : 'File Fallback',
        local_time: new Date().toLocaleTimeString('en-IN')
    });
});

app.get('/health', (req, res) => {
    res.status(200).send('OK');
});

// Keep-alive endpoint to prevent Render free instance from sleeping
app.get('/api/keep-alive', (req, res) => {
    res.json({
        status: 'alive',
        service: 'chat-service-api',
        uptime_seconds: Math.floor(process.uptime()),
        timestamp: new Date().toISOString()
    });
});

// GET /api/messages - Returns conversation history for frontend
// Optional ?limit=2..250 (default 50) — lets a fresh install deep-load old chats
app.get('/api/messages', async (req, res) => {
    try {
        const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 2), 250);
        const turns = await db.loadRecentTurns(limit);
        res.json({ success: true, count: turns.length, messages: turns });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// POST /api/messages - User sends a message, gets Rutuja's reply
app.post('/api/messages', async (req, res) => {
    const { text } = req.body;
    if (!text || !text.trim()) {
        return res.status(400).json({ success: false, error: 'Text message is required' });
    }

    const userText = text.trim();
    const now = new Date();
    lastMessageTimestamp = now;

    const currentTurnId = (messageHistory.length ? messageHistory[messageHistory.length - 1].turn_id || 0 : 0) + 1;

    // Log user turn
    const userTurn = {
        turn_id: currentTurnId,
        role: 'user',
        content: userText,
        timestamp: now.toISOString()
    };
    messageHistory.push(userTurn);
    await db.logTurn(currentTurnId, 'user', userText);

    try {
        // Generate Rutuja reply
        const botReply = await generateResponse(messageHistory.slice(-12));

        const assistantTurn = {
            turn_id: currentTurnId,
            role: 'assistant',
            content: botReply,
            timestamp: new Date().toISOString()
        };
        messageHistory.push(assistantTurn);
        await db.logTurn(currentTurnId, 'assistant', botReply);

        // Update topic cadence cooldowns if applicable
        cadenceService.analyzeAndRecordTurnTopics(botReply);

        res.json({
            success: true,
            turn_id: currentTurnId,
            reply: botReply,
            timestamp: assistantTurn.timestamp
        });
    } catch (err) {
        // Never 500-and-forget: queue the message so the retry worker can answer it later
        console.error('[API ERROR] LLM generation failed — enqueuing for retry:', err.message);
        try {
            await replyQueue.enqueueReply(userText, 'chat');
        } catch (qErr) {
            console.error('[API ERROR] Could not enqueue reply job:', qErr.message);
        }
        // 200 + queued flag — the app's 5s poll picks the reply up from history
        return res.json({
            success: true,
            queued: true,
            turn_id: currentTurnId,
            reply: null,
            timestamp: new Date().toISOString()
        });
    }
});

// In-memory / DB profile state
let profileData = {
    name: 'Rutuja 🦋',
    phone: '+91 98765 43210',
    about: 'Busy aahe call nako karu... ✨',
    avatar_url: 'https://images.pexels.com/photos/415829/pexels-photo-415829.jpeg?auto=compress&cs=tinysrgb&dpr=2&h=400&w=400'
};

// GET /api/profile - Fetch contact profile details & avatar
app.get('/api/profile', (req, res) => {
    res.json({ success: true, profile: profileData });
});

// POST /api/profile - Update profile picture / name / details
app.post('/api/profile', (req, res) => {
    const { avatar_url, about, name } = req.body;
    if (avatar_url) profileData.avatar_url = avatar_url;
    if (about) profileData.about = about;
    if (name) profileData.name = name;
    console.log(`[PROFILE] Updated profile: name=${profileData.name}, avatar=${profileData.avatar_url}`);
    res.json({ success: true, profile: profileData });
});

// POST /api/rate - Rate an assistant response (1-10)
app.post('/api/rate', async (req, res) => {
    const { turn_id, score, notes } = req.body;
    if (!turn_id || score === undefined) {
        return res.status(400).json({ success: false, error: 'turn_id and score (1-10) required' });
    }

    const pool = db.getPool();
    if (pool && db.isDbEnabled()) {
        try {
            await pool.query(
                `UPDATE chat_turns SET score = $1, notes = $2 WHERE turn_id = $3 AND role = 'assistant'`,
                [score, notes || '', turn_id]
            );
            return res.json({ success: true, message: `Turn ${turn_id} rated ${score}/10` });
        } catch (e) {
            console.error('[RATE] DB update failed:', e.message);
        }
    }
    res.json({ success: true, message: `Recorded rating for turn ${turn_id}` });
});

// POST /api/push-token - Register mobile device for Push Notifications
app.post('/api/push-token', async (req, res) => {
    const { token, platform } = req.body;
    if (!token) {
        return res.status(400).json({ success: false, error: 'Push token is required' });
    }

    const success = await notificationService.registerPushToken(token, platform || 'expo');
    res.json({ success, message: success ? 'Token registered' : 'Failed to register token' });
});

// GET /api/status - Debug status of cadence cooldowns, reminders and reply queue
app.get('/api/status', async (req, res) => {
    const restrictions = await cadenceService.getCadencePromptRestrictions();
    let queue = { store: db.isDbEnabled() ? 'db' : 'file' };
    try {
        queue = await db.getReplyQueueStats();
    } catch (e) {
        console.error('[STATUS] Queue stats failed:', e.message);
    }
    res.json({
        active_cooldowns: restrictions || 'None',
        tokens_registered: (await notificationService.getRegisteredTokens()).length,
        last_message_at: lastMessageTimestamp,
        reply_queue: queue
    });
});

// ----------------- PROACTIVE BACKGROUND MONITOR ----------------- //

/**
 * Runs periodically to trigger:
 * 1. 8-Hour daytime inactivity check
 * 2. Cricket match results (Rohit, Virat, Bumrah, Siraj)
 * 3. Scheduled interval reminders (Interview prep 4d, Affection 5d, Workout 10d)
 */
async function runProactiveMonitor() {
    const now = new Date();
    // All proactive windows are evaluated in IST (Amit's clock), not the Render UTC clock
    const currentHour = timeService.istHour(now);

    // 1. Check Cricket Match Highlights
    try {
        const match = await cricketService.fetchLatestIndianMatch();
        if (match && match.status === 'completed' && !match.notified) {
            if (!proactivePolicy.canSend(now, 'other')) {
                return; // match stays unnotified — retried on a later tick
            }
            console.log(`[PROACTIVE] India match completed: ${match.name}`);
            proactivePolicy.recordSend(now, 'other');

            const cricketPrompt = [
                ...messageHistory.slice(-6),
                { role: 'system', content: cricketService.buildCricketMessagePrompt(match) }
            ];

            const botReply = await generateResponse(cricketPrompt);
            const currentTurnId = (messageHistory.length ? messageHistory[messageHistory.length - 1].turn_id || 0 : 0) + 1;

            await db.logTurn(currentTurnId, 'assistant', botReply);
            messageHistory.push({ turn_id: currentTurnId, role: 'assistant', content: botReply, timestamp: now.toISOString() });
            await cricketService.markMatchNotified(match.id);

            // Push Notification to User
            await notificationService.sendPushNotification({
                title: 'Rutuja 🦋',
                body: botReply,
                data: { type: 'cricket', match: match.name }
            });
            return;
        }
    } catch (e) {
        console.error('[PROACTIVE] Cricket check error:', e.message);
    }

    // 2. Check Scheduled Reminders (Interview 4d, Affection 5d, Workout 10d)
    try {
        const dueTopic = await cadenceService.getDueScheduledTopic();
        if (dueTopic) {
            if (!proactivePolicy.canSend(now, 'other')) {
                return; // reminder stays due — tried again after the budget frees up
            }
            console.log(`[PROACTIVE] Scheduled reminder due: ${dueTopic.topic_name}`);
            proactivePolicy.recordSend(now, 'other');

            const reminderPrompt = [
                ...messageHistory.slice(-6),
                { role: 'system', content: `[SYSTEM NOTICE: Scheduled reminder due. ${dueTopic.prompt_instruction}]` }
            ];

            const botReply = await generateResponse(reminderPrompt);
            const currentTurnId = (messageHistory.length ? messageHistory[messageHistory.length - 1].turn_id || 0 : 0) + 1;

            await db.logTurn(currentTurnId, 'assistant', botReply);
            messageHistory.push({ turn_id: currentTurnId, role: 'assistant', content: botReply, timestamp: now.toISOString() });
            await cadenceService.markScheduledTopicTriggered(dueTopic.topic_name);

            // Push Notification to User
            await notificationService.sendPushNotification({
                title: 'Rutuja 🦋',
                body: botReply,
                data: { type: 'reminder', topic: dueTopic.topic_name }
            });
            return;
        }
    } catch (e) {
        console.error('[PROACTIVE] Reminder check error:', e.message);
    }

    // 3. 8-Hour Daytime Inactivity Check (active only 08:00–22:59 IST)
    if (currentHour >= 8 && currentHour < 23) {
        const activeMinutes = timeService.getActiveDaytimeElapsedMinutesIST(lastMessageTimestamp, now);
        const activeHours = activeMinutes / 60;

        if (activeHours >= INACTIVITY_HOURS_THRESHOLD) {
            if (!proactivePolicy.canSend(now, 'nudge')) {
                return;
            }
            console.log(`[PROACTIVE] ${activeHours.toFixed(1)} daytime (IST) hours elapsed without message. Sending nudge...`);
            proactivePolicy.recordSend(now, 'nudge');
            lastMessageTimestamp = now;

            try {
                const timeStr = timeService.istTimeStr(now);
                const nudgePrompt = [
                    ...messageHistory.slice(-6),
                    {
                        role: 'system',
                        content: `[SYSTEM NOTICE: It is ${timeStr} IST. Amit has not messaged for ${Math.round(activeHours)} daytime hours. Send a short, natural Marathi greeting/check-in suitable for this time of day (e.g. 'Hi', 'Kay kartos?', 'Busy aahes ka?').]`
                    }
                ];

                const botReply = await generateResponse(nudgePrompt);
                const currentTurnId = (messageHistory.length ? messageHistory[messageHistory.length - 1].turn_id || 0 : 0) + 1;

                await db.logTurn(currentTurnId, 'assistant', botReply);
                messageHistory.push({ turn_id: currentTurnId, role: 'assistant', content: botReply, timestamp: now.toISOString() });

                // Push Notification to User
                await notificationService.sendPushNotification({
                    title: 'Rutuja 🦋',
                    body: botReply,
                    data: { type: 'inactivity_nudge' }
                });
            } catch (e) {
                // Never let a failed nudge kill the process (the Nov 1 crash loop)
                console.error('[PROACTIVE] Nudge send failed (backing off, retried later):', e.message);
            }
        }
    }
}

// Auto self-ping (every 10 minutes) so Render free instance never sleeps
function startKeepAlivePing() {
    const renderUrl = process.env.RENDER_EXTERNAL_URL || process.env.APP_URL;
    if (!renderUrl) {
        console.log('[KEEP-ALIVE] RENDER_EXTERNAL_URL not set (running locally). Self-ping will activate on Render.');
        return;
    }

    console.log(`[KEEP-ALIVE] Auto self-ping active for ${renderUrl}/api/keep-alive (every 10m)`);

    setInterval(async () => {
        try {
            const res = await fetch(`${renderUrl}/api/keep-alive`);
            if (res.ok) {
                console.log(`[KEEP-ALIVE] Ping successful at ${new Date().toLocaleTimeString('en-IN')}`);
            }
        } catch (e) {
            console.error('[KEEP-ALIVE] Ping error:', e.message);
        }
    }, 10 * 60 * 1000);
}

/**
 * One-time cleanup of overdue proactive state (bombardment reset).
 * The scheduled reminders were seeded "already overdue", so on the first
 * monitor tick after the settings were added, 3 reminders + the inactivity
 * nudge stacked into one evening. Running this once staggers the next due
 * dates instead of letting everything fire together.
 *
 * Enable once via env var RESET_PROACTIVE_STATE=true (Render), then remove it.
 * Equivalent manual run: psql "$DATABASE_URL" -f db/reset_proactive_state.sql
 */
async function resetProactiveState() {
    const pool = db.getPool();
    if (!pool || !db.isDbEnabled()) {
        console.log('[RESET] RESET_PROACTIVE_STATE set but no database configured — skipping.');
        return;
    }
    try {
        const r1 = await pool.query(`
            UPDATE scheduled_topics SET last_triggered_at = now() - INTERVAL '2 days'
            WHERE topic_name = 'interview_prep';
        `);
        const r2 = await pool.query(`
            UPDATE scheduled_topics SET last_triggered_at = now() - INTERVAL '2 days 12 hours'
            WHERE topic_name = 'affection_love';
        `);
        const r3 = await pool.query(`
            UPDATE scheduled_topics SET last_triggered_at = now() - INTERVAL '5 days'
            WHERE topic_name = 'exercise_workout';
        `);
        const r4 = await pool.query(`
            UPDATE topic_cadence SET last_sent_at = now() - INTERVAL '1 day';
        `);
        console.log(`[RESET] Proactive state staggered. scheduled_topics rows updated: ${(r1.rowCount || 0) + (r2.rowCount || 0) + (r3.rowCount || 0)}, topic_cadence rows updated: ${r4.rowCount || 0}`);
        console.log('[RESET] Next reminders: interview_prep in ~2d, affection_love in ~2.5d, exercise_workout in ~5d. Now run without RESET_PROACTIVE_STATE.');
    } catch (e) {
        console.error('[RESET] Failed to reset proactive state:', e.message);
    }
}

/**
 * Reply-queue worker — retries every failed/unanswered user message.
 * Single-flight so parallel ticks never stampede the (rate-limited) model.
 */
let queueTickBusy = false;

async function processQueuedJob(job) {
    console.log(`[QUEUE] Generating late reply for job ${job.id} (${job.source}) — "${job.user_content}"`);

    // History: recent turns from the DB (sorted oldest→newest) + the queued user message
    const recent = await db.loadRecentTurns(12);
    const hist = recent.map(m => ({ role: m.role, content: m.content }));
    const last = hist[hist.length - 1];
    if (!last || last.role !== 'user' || last.content !== job.user_content) {
        hist.push({ role: 'user', content: job.user_content });
    }

    const botReply = await generateResponse(hist.slice(-12));

    const currentTurnId = (messageHistory.length ? messageHistory[messageHistory.length - 1].turn_id || 0 : 0) + 1;
    const turnTs = new Date().toISOString();
    await db.logTurn(currentTurnId, 'assistant', botReply);
    messageHistory.push({ turn_id: currentTurnId, role: 'assistant', content: botReply, timestamp: turnTs });

    // Late replies can land while Amit is away — notify like proactive messages do
    await notificationService.sendPushNotification({
        title: 'Rutuja 🦋',
        body: botReply,
        data: { type: 'late_reply', queue_job: String(job.id) }
    });

    return botReply;
}

async function runReplyQueueTick() {
    if (queueTickBusy) return;
    queueTickBusy = true;
    try {
        const result = await replyQueue.processDue(processQueuedJob);
        if (result.processed > 0) {
            console.log(`[QUEUE] Tick: processed ${result.processed}, replied now ${result.repliedNow}, pending ${result.pending}, failed ${result.failed} (store: ${result.store})`);
        }
    } catch (e) {
        console.error('[QUEUE] Tick error:', e.message);
    } finally {
        queueTickBusy = false;
    }
}

// Start server
(async () => {
    await loadHistory();

    // Reply queue: create table + re-queue anything the model ever left unanswered
    const store = await db.ensureReplyQueue();
    const reconcileDays = parseInt(process.env.REPLY_RECONCILE_DAYS || '7', 10);
    try {
        const resurrected = await db.enqueueUnansweredTurns(reconcileDays);
        if (resurrected > 0) {
            console.log(`[QUEUE] Reconciled ${resurrected} unanswered user message(s) from the last ${reconcileDays} days — the worker will reply to them.`);
        }
    } catch (e) {
        console.error('[QUEUE] Reconciliation failed:', e.message);
    }

    if (String(process.env.RESET_PROACTIVE_STATE || '').trim().toLowerCase() === 'true') {
        await resetProactiveState();
    }

    // Reply queue worker: first pass shortly after boot, then every 30 seconds
    setTimeout(runReplyQueueTick, 5000);
    setInterval(runReplyQueueTick, 30 * 1000);

    app.listen(PORT, () => {
        console.log(`\n========================================`);
        console.log(`  Rutuja API Server running on port ${PORT}`);
        console.log(`  Ready for Render & WhatsApp Clone`);
        console.log(`========================================\n`);

        // Run proactive check every 3 minutes
        setInterval(runProactiveMonitor, 3 * 60 * 1000);

        // Keep Render free tier awake 24/7
        startKeepAlivePing();
    });
})();
