const { getPool, isDbEnabled } = require('../db/db');
const fs = require('fs');
const path = require('path');

const FALLBACK_MATCHES_FILE = path.join(__dirname, '..', 'data', 'cricket_matches.json');
const FAVORITE_PLAYERS = ['rohit', 'virat', 'bumrah', 'siraj'];

/**
 * Fetch or check latest Indian team match status
 * Uses free public API or fallback mock feed
 */
async function fetchLatestIndianMatch() {
    const apiKey = process.env.CRICKET_API_KEY;
    
    // If API key provided, fetch live data from CricAPI / CricketData
    if (apiKey) {
        try {
            const url = `https://api.cricapi.com/v1/currentMatches?apikey=${apiKey}&offset=0`;
            const res = await fetch(url);
            const data = await res.json();
            if (data && data.data) {
                const indiaMatch = data.data.find(m => 
                    m.teams && (m.teams.includes('India') || m.name.includes('India'))
                );
                if (indiaMatch) {
                    return parseMatchData(indiaMatch);
                }
            }
        } catch (e) {
            console.error('[CRICKET] API fetch failed, using stored fixtures:', e.message);
        }
    }
    
    // Fallback/cached match check
    return getStoredUnnotifiedMatch();
}

function parseMatchData(apiMatch) {
    const name = apiMatch.name || 'India Match';
    const status = apiMatch.matchEnded ? 'completed' : (apiMatch.matchStarted ? 'live' : 'scheduled');
    const result = apiMatch.status || '';
    
    // Check player mentions in scorecard or summary
    const performers = {};
    const textLower = (JSON.stringify(apiMatch)).toLowerCase();
    
    if (textLower.includes('rohit')) performers.rohit = 'Batted well';
    if (textLower.includes('virat') || textLower.includes('kohli')) performers.virat = 'Solid innings';
    if (textLower.includes('bumrah')) performers.bumrah = 'Great bowling';
    if (textLower.includes('siraj')) performers.siraj = 'Wickets taken';
    
    return {
        id: apiMatch.id || `match_${Date.now()}`,
        name,
        match_date: new Date().toISOString().split('T')[0],
        status,
        result,
        key_performers: performers,
        notified: false
    };
}

async function saveMatch(match) {
    const pool = getPool();
    if (pool && isDbEnabled()) {
        try {
            await pool.query(
                `INSERT INTO cricket_matches (id, name, match_date, status, result, key_performers, notified)
                 VALUES ($1, $2, $3, $4, $5, $6, $7)
                 ON CONFLICT (id) DO UPDATE SET 
                   status = EXCLUDED.status,
                   result = EXCLUDED.result,
                   key_performers = EXCLUDED.key_performers`,
                [match.id, match.name, match.match_date, match.status, match.result, JSON.stringify(match.key_performers), match.notified]
            );
            return;
        } catch (e) {
            console.error('[CRICKET] DB saveMatch failed:', e.message);
        }
    }

    // File fallback
    try {
        let matches = [];
        if (fs.existsSync(FALLBACK_MATCHES_FILE)) {
            matches = JSON.parse(fs.readFileSync(FALLBACK_MATCHES_FILE, 'utf-8'));
        }
        const idx = matches.findIndex(m => m.id === match.id);
        if (idx >= 0) matches[idx] = match;
        else matches.push(match);
        fs.writeFileSync(FALLBACK_MATCHES_FILE, JSON.stringify(matches, null, 2), 'utf-8');
    } catch (e) {
        console.error('[CRICKET] File saveMatch failed:', e.message);
    }
}

async function getStoredUnnotifiedMatch() {
    const pool = getPool();
    if (pool && isDbEnabled()) {
        try {
            const r = await pool.query(
                `SELECT * FROM cricket_matches WHERE status = 'completed' AND notified = false ORDER BY match_date DESC LIMIT 1`
            );
            if (r.rows.length) {
                return r.rows[0];
            }
        } catch (e) {
            console.error('[CRICKET] DB getStoredUnnotifiedMatch failed:', e.message);
        }
    }

    if (fs.existsSync(FALLBACK_MATCHES_FILE)) {
        try {
            const matches = JSON.parse(fs.readFileSync(FALLBACK_MATCHES_FILE, 'utf-8'));
            return matches.find(m => m.status === 'completed' && !m.notified) || null;
        } catch (e) {
            return null;
        }
    }
    return null;
}

async function markMatchNotified(matchId) {
    const pool = getPool();
    if (pool && isDbEnabled()) {
        try {
            await pool.query(`UPDATE cricket_matches SET notified = true WHERE id = $1`, [matchId]);
            return;
        } catch (e) {
            console.error('[CRICKET] DB markMatchNotified failed:', e.message);
        }
    }

    if (fs.existsSync(FALLBACK_MATCHES_FILE)) {
        try {
            const matches = JSON.parse(fs.readFileSync(FALLBACK_MATCHES_FILE, 'utf-8'));
            const m = matches.find(x => x.id === matchId);
            if (m) {
                m.notified = true;
                fs.writeFileSync(FALLBACK_MATCHES_FILE, JSON.stringify(matches, null, 2), 'utf-8');
            }
        } catch (e) {}
    }
}

/**
 * Generate natural Marathi cricket reaction prompt for Rutuja
 */
function buildCricketMessagePrompt(match) {
    const performers = match.key_performers || {};
    let playerHighlight = '';

    if (performers.rohit) playerHighlight = 'Rohit Sharma played very well today.';
    else if (performers.virat) playerHighlight = 'Virat Kohli played a solid innings today.';
    else if (performers.bumrah) playerHighlight = 'Jasprit Bumrah bowled great spells with wickets.';
    else if (performers.siraj) playerHighlight = 'Mohammed Siraj took crucial wickets.';
    else playerHighlight = 'India won the match.';

    return `[SYSTEM NOTICE: India match just ended (${match.name}: ${match.result}). ${playerHighlight} Send a natural, short 1-line casual Marathi reaction to Amit about the match/player (e.g. 'Rohit aaj mast khella na🔥', 'Match baghitlis ka aaj?', 'Bumrah chi bowling mast hoti').]`;
}

module.exports = {
    fetchLatestIndianMatch,
    saveMatch,
    getStoredUnnotifiedMatch,
    markMatchNotified,
    buildCricketMessagePrompt,
    FAVORITE_PLAYERS
};
