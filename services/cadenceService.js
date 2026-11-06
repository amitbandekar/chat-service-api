const fs = require('fs');
const path = require('path');
const { getPool, isDbEnabled } = require('../db/db');
const timeService = require('./timeService');

const CADENCE_FILE = path.join(__dirname, '..', 'data', 'topic_cadence.json');
const SCHEDULED_TOPICS_FILE = path.join(__dirname, '..', 'data', 'scheduled_topics.json');

const DEFAULT_CADENCE = [
    { topic_key: 'food_inquiry', min_cooldown_days: 3, last_sent_at: new Date(Date.now() - 4 * 86400000).toISOString() },
    { topic_key: 'good_morning', min_cooldown_days: 3, last_sent_at: new Date(Date.now() - 4 * 86400000).toISOString() },
    { topic_key: 'good_night', min_cooldown_days: 3, last_sent_at: new Date(Date.now() - 4 * 86400000).toISOString() }
];

const DEFAULT_SCHEDULED_TOPICS = [
    {
        topic_name: 'interview_prep',
        interval_days: 4,
        last_triggered_at: new Date(Date.now() - 4 * 86400000).toISOString(),
        active_start_hour: 18,
        active_end_hour: 22,
        prompt_instruction: 'Casually ask Amit about his interview preparation or coding practice progress in 1 short sentence (e.g., "Interview prep kiti zali?", "Coding practice chalu ahe na?").'
    },
    {
        topic_name: 'affection_love',
        interval_days: 5,
        last_triggered_at: new Date(Date.now() - 5 * 86400000).toISOString(),
        active_start_hour: 21,
        active_end_hour: 23,
        prompt_instruction: 'Send a rare, short, sweet affectionate message with emoji to Amit (e.g., "Love you re ❤️", "Take care ha 🥺❤️") as per persona rules.'
    },
    {
        topic_name: 'exercise_workout',
        interval_days: 10,
        last_triggered_at: new Date(Date.now() - 10 * 86400000).toISOString(),
        active_start_hour: 17,
        active_end_hour: 21,
        prompt_instruction: 'Casually ask Amit if he has been exercising or working out recently (e.g., "Workout / gym chalu ahe ka tuza?").'
    }
];

/**
 * Get cadence cooldown status for the prompt
 * Returns formatted instructions on which topics are restricted due to 3-4 days cooldown
 */
async function getCadencePromptRestrictions() {
    let list = [];
    const pool = getPool();
    if (pool && isDbEnabled()) {
        try {
            const r = await pool.query('SELECT topic_key, last_sent_at, min_cooldown_days FROM topic_cadence');
            list = r.rows;
        } catch (e) {
            console.error('[CADENCE] DB fetch failed, using fallback file:', e.message);
        }
    }

    if (list.length === 0) {
        if (!fs.existsSync(CADENCE_FILE)) {
            fs.writeFileSync(CADENCE_FILE, JSON.stringify(DEFAULT_CADENCE, null, 2), 'utf-8');
            list = DEFAULT_CADENCE;
        } else {
            try {
                list = JSON.parse(fs.readFileSync(CADENCE_FILE, 'utf-8'));
            } catch (e) {
                list = DEFAULT_CADENCE;
            }
        }
    }

    const now = Date.now();
    const ineligible = [];

    for (const item of list) {
        const lastTime = new Date(item.last_sent_at).getTime();
        const daysPassed = (now - lastTime) / (1000 * 60 * 60 * 24);
        if (daysPassed < item.min_cooldown_days) {
            ineligible.push(item.topic_key);
        }
    }

    let restrictionText = '';
    if (ineligible.includes('food_inquiry')) {
        restrictionText += `- DO NOT ask "Jevan zala ka?" or food routine questions (already asked recently; 3-day cooldown active).\n`;
    }
    if (ineligible.includes('good_morning')) {
        restrictionText += `- DO NOT initiate "Good morning" (cooldown active).\n`;
    }
    if (ineligible.includes('good_night')) {
        restrictionText += `- DO NOT initiate "Good night" unless Amit says it first (cooldown active).\n`;
    }

    return restrictionText;
}

/**
 * Record that a topic was used to restart its 3-4 day cooldown
 */
async function recordTopicUsed(topicKey) {
    const pool = getPool();
    if (pool && isDbEnabled()) {
        try {
            await pool.query(
                `INSERT INTO topic_cadence (topic_key, last_sent_at)
                 VALUES ($1, now())
                 ON CONFLICT (topic_key) DO UPDATE SET last_sent_at = now()`,
                [topicKey]
            );
            return;
        } catch (e) {
            console.error('[CADENCE] DB recordTopicUsed failed:', e.message);
        }
    }

    // File fallback
    let list = DEFAULT_CADENCE;
    if (fs.existsSync(CADENCE_FILE)) {
        try {
            list = JSON.parse(fs.readFileSync(CADENCE_FILE, 'utf-8'));
        } catch (e) {}
    }
    const idx = list.findIndex(x => x.topic_key === topicKey);
    if (idx >= 0) {
        list[idx].last_sent_at = new Date().toISOString();
    } else {
        list.push({ topic_key: topicKey, min_cooldown_days: 3, last_sent_at: new Date().toISOString() });
    }
    fs.writeFileSync(CADENCE_FILE, JSON.stringify(list, null, 2), 'utf-8');
}

/**
 * Detect if assistant response touches any cadence topics and record cooldown
 */
function analyzeAndRecordTurnTopics(text) {
    const lower = text.toLowerCase();
    if (lower.includes('jevan') || lower.includes('jevalas') || lower.includes('khallas') || lower.includes('dabba')) {
        recordTopicUsed('food_inquiry');
    }
    if (lower.includes('good morning') || lower.includes('shubh sakal')) {
        recordTopicUsed('good_morning');
    }
    if (lower.includes('good night') || lower.includes('shubh ratri')) {
        recordTopicUsed('good_night');
    }
}

/**
 * Check if any scheduled interval topic is due (Interview prep 4d, Affection 5d, Workout 10d)
 */
async function getDueScheduledTopic() {
    let topics = [];
    const pool = getPool();
    if (pool && isDbEnabled()) {
        try {
            const r = await pool.query('SELECT * FROM scheduled_topics');
            topics = r.rows;
        } catch (e) {
            console.error('[SCHEDULED] DB fetch failed:', e.message);
        }
    }

    if (topics.length === 0) {
        if (!fs.existsSync(SCHEDULED_TOPICS_FILE)) {
            fs.writeFileSync(SCHEDULED_TOPICS_FILE, JSON.stringify(DEFAULT_SCHEDULED_TOPICS, null, 2), 'utf-8');
            topics = DEFAULT_SCHEDULED_TOPICS;
        } else {
            try {
                topics = JSON.parse(fs.readFileSync(SCHEDULED_TOPICS_FILE, 'utf-8'));
            } catch (e) {
                topics = DEFAULT_SCHEDULED_TOPICS;
            }
        }
    }

    const now = new Date();
    // Active topic windows (workout 17–21, interview 18–22, affection 21–23) are defined in IST
    const currentHour = timeService.istHour(now);

    for (const t of topics) {
        // Check active hours window
        if (currentHour < t.active_start_hour || currentHour > t.active_end_hour) {
            continue;
        }

        const lastTriggered = t.last_triggered_at ? new Date(t.last_triggered_at).getTime() : 0;
        const daysElapsed = (now.getTime() - lastTriggered) / (1000 * 60 * 60 * 24);

        if (daysElapsed >= t.interval_days) {
            return t;
        }
    }

    return null;
}

/**
 * Mark a scheduled topic as triggered
 */
async function markScheduledTopicTriggered(topicName) {
    const pool = getPool();
    if (pool && isDbEnabled()) {
        try {
            await pool.query(
                `UPDATE scheduled_topics SET last_triggered_at = now() WHERE topic_name = $1`,
                [topicName]
            );
            return;
        } catch (e) {
            console.error('[SCHEDULED] DB update failed:', e.message);
        }
    }

    let topics = DEFAULT_SCHEDULED_TOPICS;
    if (fs.existsSync(SCHEDULED_TOPICS_FILE)) {
        try {
            topics = JSON.parse(fs.readFileSync(SCHEDULED_TOPICS_FILE, 'utf-8'));
        } catch (e) {}
    }
    const idx = topics.findIndex(t => t.topic_name === topicName);
    if (idx >= 0) {
        topics[idx].last_triggered_at = new Date().toISOString();
        fs.writeFileSync(SCHEDULED_TOPICS_FILE, JSON.stringify(topics, null, 2), 'utf-8');
    }
}

module.exports = {
    getCadencePromptRestrictions,
    recordTopicUsed,
    analyzeAndRecordTurnTopics,
    getDueScheduledTopic,
    markScheduledTopicTriggered
};
