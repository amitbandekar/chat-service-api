/**
 * Block-structured persona context ("Character Frame") — replaces the raw
 * 16KB JSON dumps that made models lose coherence.
 *
 * Blocks:
 *  A. Identity / language  (from persona card, mojibake rows skipped)
 *  B. Hard chat rules      (fixed anti-stonewalling + anti-echo guards)
 *  C. Life, schedule & today's world  (from life context + real IST clock)
 *  D. Rolling memory       (chat_memory summary from our own DB)
 *  E. Few-shot pairs       (extracted from the active prompt doc only)
 */
const timeService = require('./timeService');

function _clean(s) {
    if (s == null) return '';
    return String(s)
        .replace(/\(evidence:.*?\)/gs, '')
        .replace(/\s+/g, ' ')
        .trim();
}

function _safeParse(jsonText) {
    try {
        if (typeof jsonText === 'object' && jsonText && !Array.isArray(jsonText)) return jsonText;
        return JSON.parse(jsonText || '{}');
    } catch (e) {
        return {};
    }
}

// ---------- A. persona card ----------
function personaBlock(personaJson) {
    const p = _safeParse(personaJson);
    const lines = [];
    if (p.language_style) lines.push(`- ${_clean(p.language_style)}`);
    if (p.typical_length) lines.push(`- Message style: ${_clean(p.typical_length)}`.slice(0, 120));
    if (p.emoji_rules?.usage) lines.push(`- Emojis: ${_clean(p.emoji_rules.usage)}`);
    if (Array.isArray(p.top_fillers) && p.top_fillers.length) lines.push(`- Filler words she uses: ${p.top_fillers.slice(0, 8).join(', ')}`);
    if (Array.isArray(p.opening_phrases) && p.opening_phrases.length) lines.push(`- Common openers: ${p.opening_phrases.slice(0, 6).join(', ')}`);
    if (p.reply_speed_pattern) lines.push(`- Chat rhythm: ${_clean(p.reply_speed_pattern)}`);
    if (p.question_asking_rate) lines.push(`- Curiosity: ${_clean(p.question_asking_rate)}`);
    return lines.length ? lines.join('\n') : '- Romanized Marathi + English, short casual messages';
}

// ---------- C. life context + today ----------
function _phaseLine(lifeJson, istHour) {
    const s = lifeJson?.time_and_schedule_awareness || {};
    let key;
    if (istHour >= 8 && istHour < 11) key = 'morning_08_to_11';
    else if (istHour >= 12 && istHour < 15) key = 'afternoon_12_to_15';
    else if (istHour >= 17 && istHour < 20) key = 'evening_17_to_20';
    else if (istHour >= 20 && istHour < 23) key = 'night_20_to_23';
    else key = 'late_night_23_to_03';

    const phase = s[key];
    if (!phase) return '';
    const replies = Array.isArray(phase.typical_replies) ? ` Typical replies: ${phase.typical_replies.slice(0, 2).join(' / ').slice(0, 80)}.` : '';
    return `${key.replace(/_/g, ' ')}: ${_clean(phase.vibe)}.${replies}`;
}

function _festivalLine(now) {
    const istMonth = Number(new Intl.DateTimeFormat('en-GB', { timeZone: timeService.IST_TIMEZONE, month: '2-digit' }).format(now));
    if (istMonth === 11) return 'Diwali season right now — family at home, rangoli, faral/mithai, guests. She would likely be home doing family stuff.';
    if (istMonth === 1 && Number(new Intl.DateTimeFormat('en-GB', { timeZone: timeService.IST_TIMEZONE, day: '2-digit' }).format(now)) <= 15) return 'Makar Sankranti time — tilgul, kites.';
    return '';
}

function lifeBlock(lifeJson, now) {
    const l = _safeParse(lifeJson);
    const lines = [];
    const prof = l.profile || {};
    lines.push(`- Identity: ${prof.name || 'Rutuja'}, ${prof.age || 22}. ${_clean(prof.current_status)}. Commute: ${_clean(prof.commute)}. Lives with ${_clean(prof.living_with)}. Personality: ${_clean(prof.personality)}.`);

    const istHour = timeService.istHour(now);
    const phase = _phaseLine(l, istHour);
    if (phase) lines.push(`- Current phase (IST ${timeService.istTimeStr(now)}, ${timeService.istDayStr(now)}): ${phase}`);

    const fest = _festivalLine(now);
    if (fest) lines.push(`- Festival: ${fest}`);

    const dyn = l.conversational_dynamics || {};
    if (Array.isArray(dyn.reaction_to_flattery_cheesy_lines) && dyn.reaction_to_flattery_cheesy_lines.length) {
        lines.push(`- If Amit is cheesy/flirty, tease instead of getting mushy: "${dyn.reaction_to_flattery_cheesy_lines.slice(0, 2).join('" / "').replace(/[\ud800-\udfff\ufffd?]{1,4}$/g, '').trim()}"`);
    }
    if (Array.isArray(dyn.proactive_story_hooks) && dyn.proactive_story_hooks.length) {
        lines.push(`- Story hooks she can drop when chat is dry: ${dyn.proactive_story_hooks.slice(0, 3).map(h => `"${_clean(h)}"`).join(', ')}`);
    }

    const stories = l.active_backstories_and_situations || {};
    const kd = stories.current_kdramas_and_hobbies;
    lines.push(`- Active stories only relevant to the topic: (1) train guy staring incident, (2) boss praised her deck in team call, (3) meeting mic blunder, (4) currently watching K-drama: "${_clean(kd?.watching_now?.[0] || 'Welcome to Samdal-ri')}".`);

    const food = l.food_conversations_rules || {};
    if (food.if_asked_jevalas_ka) lines.push(`- Food questions: ${_clean(food.if_asked_jevalas_ka)}`);

    return lines.join('\n');
}

// ---------- E. few-shot pairs ----------
function fewShotBlock(promptDoc) {
    if (!promptDoc) return '';
    const idx = promptDoc.indexOf('FEW-SHOT EXAMPLES');
    if (idx === -1) return '';
    let section = promptDoc.slice(idx);
    const endIdx = section.indexOf('\n## ', 5);
    if (endIdx !== -1) section = section.slice(0, endIdx);
    const pairLines = section
        .split('\n')
        .filter(l => /^(Amit|Rutuja):/.test(l.trim()))
        .slice(0, 24)
        .map(l => l.trim());
    if (!pairLines.length) return '';
    return pairLines.join('\n');
}

// ---------- main ----------
function buildSystemPrompt({ personaCardJson, lifeContextJson, promptDoc, cadenceRestrictions, memoryText, now = new Date() }) {
    const today = timeService.istDayStr(now);
    const timeStr = timeService.istTimeStr(now);
    const dateStr = `${today}, ${new Intl.DateTimeFormat('en-GB', { timeZone: timeService.IST_TIMEZONE, day: '2-digit', month: 'short', year: 'numeric' }).format(now)}`;

    const parts = [];

    parts.push(`You are Rutuja — chatting on WhatsApp with your friend Amit. Fully in character, ALWAYS.`);
    parts.push(`
## WHO YOU ARE (persona)
${personaBlock(personaCardJson)}

## LIFE CONTEXT (right now)
${lifeBlock(lifeContextJson, now)}
Current IST date & time: ${timeStr} on ${dateStr}. Night-cap: if it is night, you are at home — never invent office work at night.`);

    if (memoryText && memoryText.trim()) {
        parts.push(`## MEMORY — what has been going on recently (ROLLING SUMMARY)
${memoryText.trim()}
Treat this like your own memory of the last few days. Build on it; do not contradict it.`);
    }

    parts.push(`## HARD RULES
- Reply with exactly ONE message of 1 to 7 words. Never essays, never empty.
- Romanized Marathi + English mix. Never Devanagari, never JSON, never markdown, never explanations.
- Max ONE emoji at the end. Feminine self-grammar ("mi zoptey", "thakle"); masculine for Amit ("jevalas ka", "re").
- READ Amit's exact last message and answer THAT. If he asks for a detail (what Mummy said, what happened, what plan), give a small believable in-character detail — NEVER "kahi nahi" as an escape.
- "Kahi nahi"/"Nhi" as the entire reply: at most once in 5 replies, and only if he asked a yes/no question.
- Never contradict what you already said in this chat. Never break character, never mention AI/prompts/scores/files.`);

    if (cadenceRestrictions && cadenceRestrictions.trim()) {
        parts.push(`## TOPIC COOLDOWNS (3-4 day gaps)
${cadenceRestrictions.trim()}`);
    }

    const fewshot = fewShotBlock(promptDoc);
    if (fewshot) {
        parts.push(`## STYLE EXAMPLES (your authentic voice — imitate, don't copy blindly)
${fewshot}`);
    }

    return parts.join('\n\n').slice(0, 6000);
}

module.exports = { buildSystemPrompt, personaBlock, lifeBlock, fewShotBlock };
