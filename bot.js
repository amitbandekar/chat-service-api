const fs = require('fs');
const path = require('path');
const dotenv = require('dotenv');
const qrcode = require('qrcode-terminal');
const { Client, LocalAuth } = require('whatsapp-web.js');
const OpenAI = require('openai');

dotenv.config();

const db = require('./db/db');
const timeService = require('./services/timeService');
const llmClient = require('./services/llmClient');
const proactivePolicy = require('./services/proactivePolicy');

// Configuration
const XKIRO_API_KEY = process.env.XKIRO_API_KEY;
const XKIRO_BASE_URL = process.env.XKIRO_BASE_URL || 'https://api.xkiro.com/v1';
const MODEL_NAME = process.env.MODEL_NAME || 'qwen/qwen3.8-max:free';
const TARGET_PHONE_NUMBER = process.env.TARGET_PHONE_NUMBER || '';
const INACTIVITY_HOURS_THRESHOLD = parseFloat(process.env.INACTIVITY_HOURS_THRESHOLD || '8');

if (db.isDbEnabled()) {
    console.log('[INIT] DATABASE_URL detected — Postgres is source of truth (files kept as fallback/seed).');
} else {
    console.log('[INIT] DATABASE_URL not set — running in file mode. Add DATABASE_URL to use Postgres.');
}

// Initialize OpenAI client pointing to Xkiro / OpenRouter
const openai = new OpenAI({
    apiKey: XKIRO_API_KEY,
    baseURL: XKIRO_BASE_URL,
});

// State
let lastMessageTimestamp = new Date();
let messageHistory = [];

/**
 * Load last 20 messages from Postgres (fallback: session_master.jsonl) to maintain context across restarts
 */
async function loadInitialHistory() {
    try {
        const rows = await db.loadRecentTurns(20);
        messageHistory = rows.map(m => ({
            role: m.role,
            content: m.content
        }));

        if (rows.length > 0 && rows[rows.length - 1].timestamp) {
            const loadedTs = new Date(rows[rows.length - 1].timestamp);
            const clamped = timeService.clampRecent(loadedTs);
            if (clamped !== loadedTs) {
                console.log(`[INIT] Stale last-message timestamp clamped to ${clamped.toISOString()} (prevents instant "457h idle" nudge on restart).`);
            }
            lastMessageTimestamp = clamped;
        }
        console.log(`[INIT] Loaded ${messageHistory.length} messages from ${db.isDbEnabled() ? 'Postgres' : 'session file'}.`);
    } catch (err) {
        console.error('[INIT] Error loading history:', err.message);
    }
}

/**
 * Append message turn to Postgres (fallback: session_master.jsonl)
 */
async function logTurn(turnId, role, content) {
    // Always mirror to file as backup, write to DB as source of truth
    try {
        await db.logTurn(turnId, role, content);
    } catch (err) {
        console.error('[LOG] logTurn failed:', err.message);
    }
    // file mirror for backup (db.js already mirrors when DB is down;
    // when DB is up we keep one extra file copy here)
    if (db.isDbEnabled()) {
        try {
            const sessionFile = path.join(__dirname, 'chat_sessions', 'session_master.jsonl');
            if (!fs.existsSync(path.dirname(sessionFile))) fs.mkdirSync(path.dirname(sessionFile), { recursive: true });
            const entry = { turn_id: turnId, role, content, timestamp: new Date().toISOString() };
            if (role === 'assistant') {
                entry.score_1_to_10 = null;
                entry.notes = '';
            }
            fs.appendFileSync(sessionFile, JSON.stringify(entry) + '\n', 'utf-8');
        } catch (e) {
            console.error('[LOG] file mirror failed:', e.message);
        }
    }
}

/**
 * Build dynamic system prompt with current local time and life schedule
 * Source: Postgres (fallback: files kept as seed/backup)
 */
async function buildSystemPrompt() {
    const [personaCard, lifeContext, promptDoc] = await Promise.all([
        db.getPersona(),
        db.getLifeContext(),
        db.getActivePrompt(),
    ]);

    const now = new Date();
    // IST explicitly: en-IN alone uses the host timezone (UTC on Render/overlap)
    const timeStr = timeService.istTimeStr(now);
    const dayStr = timeService.istDayStr(now);

    return `
You are Rutuja (<NAME_B>, female), chatting casually with your friend Amit (<NAME_A>, male) on WhatsApp.
Current local time: ${timeStr} (${dayStr}).

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
 * Generate LLM reply
 */
async function generateResponse(messages) {
    const systemPrompt = await buildSystemPrompt();

    const response = await llmClient.chatCompletionWithRetry(openai, {
        model: MODEL_NAME,
        messages: [
            { role: 'system', content: systemPrompt },
            ...messages
        ],
        temperature: 0.7,
        max_tokens: 60
    });

    let text = response.choices[0]?.message?.content?.trim() || 'Hi';
    // Clean any markdown formatting or quotes
    text = text.replace(/^["']|["']$/g, '').trim();
    // Models sometimes echo our [HH:MM] history prefixes — never send those to the user
    text = text.replace(/(\[\d{1,2}:\d{2}\]\s*)+/g, '').trim();
    return text;
}

// Initialize WhatsApp Web Client
const client = new Client({
    authStrategy: new LocalAuth({ dataPath: path.join(__dirname, '.wwebjs_auth') }),
    puppeteer: {
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox']
    }
});

client.on('qr', (qr) => {
    console.log('\n[QR] Scan this QR code with WhatsApp on your phone:');
    qrcode.generate(qr, { small: true });
});

client.on('ready', () => {
    console.log(`\n[READY] Rutuja WhatsApp Bot is online!`);
    console.log(`[CONFIG] Model: ${MODEL_NAME}`);
    console.log(`[CONFIG] Target: ${TARGET_PHONE_NUMBER || 'ALL (Warning: set TARGET_PHONE_NUMBER in .env)'}`);
    console.log(`[CONFIG] Inactivity Threshold: ${INACTIVITY_HOURS_THRESHOLD} daytime hours\n`);

    // Start proactive inactivity monitor (checks every 5 minutes)
    setInterval(checkInactivityAndNudge, 5 * 60 * 1000);
});

// Incoming message handler
client.on('message', async (msg) => {
    const sender = msg.from;

    // Filter to only target user if configured
    if (TARGET_PHONE_NUMBER && sender !== TARGET_PHONE_NUMBER) {
        return;
    }

    // Ignore status updates or broadcast messages
    if (msg.isStatus || msg.from.includes('broadcast')) {
        return;
    }

    const userText = msg.body;
    if (!userText) return;

    console.log(`\n[INCOMING] Amit: "${userText}"`);

    lastMessageTimestamp = new Date();

    // Add to history
    messageHistory.push({ role: 'user', content: userText });
    await logTurn(messageHistory.length, 'user', userText);

    try {
        const chat = await msg.getChat();
        await chat.sendStateTyping();

        // Realistic typing delay: 2.5s to 5.5s
        const delayMs = Math.floor(Math.random() * 3000) + 2500;
        await new Promise(res => setTimeout(res, delayMs));

        // Generate Rutuja response
        const botReply = await generateResponse(messageHistory.slice(-12));
        console.log(`[REPLY] Rutuja: "${botReply}"`);

        await msg.reply(botReply);

        messageHistory.push({ role: 'assistant', content: botReply });
        await logTurn(messageHistory.length, 'assistant', botReply);

        await chat.clearState();
    } catch (err) {
        console.error('[ERROR] Failed to send reply:', err.message);
    }
});

/**
 * Proactive Inactivity Checker
 * Runs every 5 mins (IST clock): if >= 8 active daytime hours have passed
 * without a message, sends a nudge — max 1/day, within the shared proactive budget.
 */
async function checkInactivityAndNudge() {
    if (!TARGET_PHONE_NUMBER) return;

    const now = new Date();
    // IST hour — bot.js used to compare the host's UTC hours on Render
    const currentHour = timeService.istHour(now);

    // Only send proactive messages between 08:00 and 22:59 IST
    if (currentHour < 8 || currentHour >= 23) {
        return;
    }

    const activeMinutesElapsed = timeService.getActiveDaytimeElapsedMinutesIST(lastMessageTimestamp, now);
    const activeHoursElapsed = activeMinutesElapsed / 60;

    console.log(`[TIMER] Active daytime (IST) hours since last message: ${activeHoursElapsed.toFixed(2)}h`);

    if (activeHoursElapsed >= INACTIVITY_HOURS_THRESHOLD) {
        // Anti-spam budget (shared with scheduled reminders on server.js)
        if (!proactivePolicy.canSend(now, 'nudge')) return;

        console.log(`[NUDGE] Inactivity threshold reached (${activeHoursElapsed.toFixed(2)}h >= ${INACTIVITY_HOURS_THRESHOLD}h). Sending nudge...`);
        proactivePolicy.recordSend(now, 'nudge');
        lastMessageTimestamp = now;

        try {
            const timeStr = timeService.istTimeStr(now);
            const nudgePrompt = [
                ...messageHistory.slice(-8),
                {
                    role: 'system',
                    content: `[SYSTEM NOTICE: It is ${timeStr} IST. Amit has not messaged for ${Math.round(activeHoursElapsed)} daytime hours. Send a short, natural Marathi greeting/check-in suitable for this time of day (e.g. 'Hi', 'Kay kartos?', 'Busy aahes ka?', 'Office madhe aahes ka?').]`
                }
            ];

            const botReply = await generateResponse(nudgePrompt);
            console.log(`[PROACTIVE NUDGE] Rutuja: "${botReply}"`);

            await client.sendMessage(TARGET_PHONE_NUMBER, botReply);

            messageHistory.push({ role: 'assistant', content: botReply });
            await logTurn(messageHistory.length, 'assistant', botReply);
        } catch (err) {
            console.error('[NUDGE ERROR]', err.message);
        }
    }
}

// Start bot
(async () => {
    await loadInitialHistory();
    client.initialize();
})();
