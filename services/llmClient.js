/**
 * OpenAI-compatible chat completion with retry/backoff for Xkiro free-tier
 * hiccups — without this, a 429/503 from the provider used to crash the whole
 * process (Render restarted and immediately fired a new proactive message).
 */
const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);

async function chatCompletionWithRetry(openai, params, { maxAttempts = 3 } = {}) {
    let lastErr;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
            return await openai.chat.completions.create(params);
        } catch (err) {
            lastErr = err;
            const status = Number(err?.status) || Number(err?.response?.status) || 0;
            const retryable = status && RETRYABLE_STATUS.has(status);
            console.error(`[LLM] Attempt ${attempt}/${maxAttempts} failed${status ? ` (HTTP ${status})` : ''}: ${err.message}`);

            if (!retryable || attempt === maxAttempts) break;

            const waitMs = 2000 * Math.pow(4, attempt - 1); // 2s, then 8s
            console.warn(`[LLM] Retrying in ${waitMs / 1000}s...`);
            await new Promise((resolve) => setTimeout(resolve, waitMs));
        }
    }
    throw lastErr;
}

module.exports = { chatCompletionWithRetry, RETRYABLE_STATUS };
