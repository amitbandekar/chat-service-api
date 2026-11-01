const fs = require('fs');
const path = require('path');
const { getPool, isDbEnabled } = require('../db/db');

const TOKENS_FILE = path.join(__dirname, '..', 'data', 'push_tokens.json');

/**
 * Register or update an Expo Push Token from the mobile app
 */
async function registerPushToken(token, platform = 'expo') {
    if (!token || typeof token !== 'string') return false;

    const pool = getPool();
    if (pool && isDbEnabled()) {
        try {
            await pool.query(
                `CREATE TABLE IF NOT EXISTS push_tokens (
                    id SERIAL PRIMARY KEY,
                    token TEXT UNIQUE NOT NULL,
                    platform TEXT NOT NULL DEFAULT 'expo',
                    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
                )`
            );
            await pool.query(
                `INSERT INTO push_tokens (token, platform, updated_at)
                 VALUES ($1, $2, now())
                 ON CONFLICT (token) DO UPDATE SET updated_at = now()`,
                [token, platform]
            );
            return true;
        } catch (e) {
            console.error('[PUSH] DB registerPushToken failed, falling back to file:', e.message);
        }
    }

    // File fallback
    try {
        let tokens = [];
        if (fs.existsSync(TOKENS_FILE)) {
            tokens = JSON.parse(fs.readFileSync(TOKENS_FILE, 'utf-8'));
        }
        if (!tokens.includes(token)) {
            tokens.push(token);
            fs.writeFileSync(TOKENS_FILE, JSON.stringify(tokens, null, 2), 'utf-8');
        }
        return true;
    } catch (e) {
        console.error('[PUSH] File registerPushToken failed:', e.message);
        return false;
    }
}

/**
 * Get all registered tokens
 */
async function getRegisteredTokens() {
    const pool = getPool();
    if (pool && isDbEnabled()) {
        try {
            const r = await pool.query('SELECT token FROM push_tokens ORDER BY updated_at DESC');
            return r.rows.map(row => row.token);
        } catch (e) {
            // fallback
        }
    }

    if (fs.existsSync(TOKENS_FILE)) {
        try {
            return JSON.parse(fs.readFileSync(TOKENS_FILE, 'utf-8'));
        } catch (e) {
            return [];
        }
    }
    return [];
}

/**
 * Send Push Notification to all registered devices via Expo Push Service
 */
async function sendPushNotification({ title = 'Rutuja 🦋', body, data = {} }) {
    if (!body) return;

    const tokens = await getRegisteredTokens();
    if (!tokens || tokens.length === 0) {
        console.log(`[PUSH] Notification ready ("${body}"), but no device token registered yet.`);
        return;
    }

    // Prepare Expo push payload
    const messages = tokens.map(token => ({
        to: token,
        sound: 'default',
        title: title,
        body: body,
        data: { ...data, timestamp: new Date().toISOString() },
        priority: 'high'
    }));

    try {
        const response = await fetch('https://exp.host/--/api/v2/push/send', {
            method: 'POST',
            headers: {
                'Accept': 'application/json',
                'Accept-encoding': 'gzip, deflate',
                'Content-Type': 'application/json',
            },
            body: JSON.stringify(messages),
        });

        const resData = await response.json();
        console.log(`[PUSH] Sent notification to ${tokens.length} device(s): "${body}"`);
        return resData;
    } catch (err) {
        console.error('[PUSH] Error sending Expo push notification:', err.message);
    }
}

module.exports = {
    registerPushToken,
    getRegisteredTokens,
    sendPushNotification
};
