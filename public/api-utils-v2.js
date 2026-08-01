/**
 * API Utility Functions with Smart Model Fallback
 * FACIT - Gemini AI Integration
 * 
 * قوانین انتخاب مدل:
 * 1. اگر کاربر مدل خاصی انتخاب کرده → فقط همان مدل
 * 2. در حالت Auto → فقط مدل‌های فعال (کپسول روشن)
 * 3. intent تعیین‌کننده ترتیب: quick = ضعیف‌ترین اول، strong = قوی‌ترین اول
 * 
 * استراتژی کلیدها:
 * 1. کلیدها رندوم انتخاب می‌شوند (توزیع بار)
 * 2. برای هر مدل، همه کلیدها امتحان می‌شوند
 * 3. اگر موفق شد → برگشت، اگر همه fail شدند → مدل بعدی
 */

// ═══════════════════════════════════════════════════════════════════
// CONFIGURATION
// ═══════════════════════════════════════════════════════════════════

const RETRY_CONFIG = {
    maxRetries: 2,
    initialDelay: 1000,
    maxDelay: 5000,
    timeout: 60000
};

const ERROR_TYPES = {
    NETWORK: 'NETWORK_ERROR',
    AUTH: 'AUTH_ERROR',
    SERVER: 'SERVER_ERROR',
    UNKNOWN: 'UNKNOWN_ERROR',
    MODEL_ERROR: 'MODEL_ERROR'
};

const ERROR_MESSAGES = {
    [ERROR_TYPES.NETWORK]: 'خطا در اتصال به اینترنت.',
    [ERROR_TYPES.AUTH]: 'کلید API معتبر نیست.',
    [ERROR_TYPES.SERVER]: 'خطای سرویس گوگل.',
    [ERROR_TYPES.UNKNOWN]: 'خطای ناشناخته.',
    [ERROR_TYPES.MODEL_ERROR]: 'مدل‌های درخواست شده در دسترس نیستند.'
};

// Model definitions (strongest to weakest and weakest to strongest)
// Updated July 2026: gemini-2.0-flash/1.5-* shut down June 2026.
// gemini-3.x is the current generation. gemini-2.5-* is legacy (retiring Oct 2026).
const MODELS_STRONG_TO_WEAK = [
    'gemini-3.1-pro-preview',   // Flagship reasoning / complex analysis
    'gemini-3.6-flash',         // Newest GA flash (Jul 21 2026)
    'gemini-3.5-flash',         // Previous GA flash
    'gemini-2.5-pro',           // Legacy pro (retiring Oct 2026)
    'gemini-2.5-flash',         // Legacy flash (retiring Oct 2026)
    'gemini-3.5-flash-lite',    // Cheapest / high-volume automation
];
const MODELS_WEAK_TO_STRONG = [
    'gemini-3.5-flash-lite',    // Cheapest / high-volume
    'gemini-2.5-flash',         // Legacy flash
    'gemini-3.5-flash',         // Previous GA flash
    'gemini-3.6-flash',         // Newest GA flash
    'gemini-2.5-pro',           // Legacy pro
    'gemini-3.1-pro-preview',   // Flagship reasoning
];

const SUPPORTED_MODELS = new Set([
    ...MODELS_STRONG_TO_WEAK,
    ...MODELS_WEAK_TO_STRONG
]);

// Pro models disabled by default (lower free-tier quota)
const DEFAULT_DISABLED_MODELS = ['gemini-3.1-pro-preview', 'gemini-2.5-pro'];

function normalizeModelId(modelId) {
    if (!modelId) return null;
    // Already supported → pass through
    if (SUPPORTED_MODELS.has(modelId)) return modelId;
    // Deprecated / shutdown models → nearest active equivalent
    if (modelId === 'gemini-2.0-flash') return 'gemini-3.6-flash';
    if (modelId === 'gemini-2.0-flash-thinking-exp') return 'gemini-3.6-flash';
    if (modelId === 'gemini-2.0-pro-exp') return 'gemini-3.1-pro-preview';
    if (modelId === 'gemini-1.5-pro') return 'gemini-2.5-pro';
    if (modelId === 'gemini-1.5-flash') return 'gemini-3.6-flash';
    // Alternate names for current models
    if (modelId === 'gemini-3-flash-preview') return 'gemini-3.5-flash';
    if (modelId === 'gemini-3-pro-preview') return 'gemini-3.1-pro-preview';
    // 'hybrid' = Auto mode (not a real model)
    if (modelId === 'hybrid') return 'hybrid';
    return null;
}

// ═══════════════════════════════════════════════════════════════════
// STATE
// ═══════════════════════════════════════════════════════════════════

let cachedGeminiKeys = [];
let cachedGeminiKeysPromise = null;
let apiKeyStatsRefreshPromise = null;

const KEY_RUNTIME_STATE_STORAGE_KEY = 'facit_gemini_key_runtime_state_v1';
const KEY_SELECTOR_META_STORAGE_KEY = 'facit_gemini_key_selector_meta_v1';
const MODEL_RUNTIME_STATE_STORAGE_KEY = 'facit_gemini_model_runtime_state_v2';
let keyRuntimeState = {};
let keySelectorMeta = { rr: 0 };
let modelRuntimeState = {};
let lastStatsRefreshAt = 0;

try {
    const saved = localStorage.getItem(KEY_RUNTIME_STATE_STORAGE_KEY);
    if (saved) keyRuntimeState = JSON.parse(saved) || {};
} catch {
    keyRuntimeState = {};
}

// Clean up expired runtime states on load so keys with stale cooldowns
// (e.g. from yesterday's daily-quota 429) are immediately usable again.
try {
    const _loadNow = Date.now();
    let _stateChanged = false;
    for (const _stateId of Object.keys(keyRuntimeState)) {
        const _st = keyRuntimeState[_stateId];
        if (_st.disabledUntil && _loadNow >= _st.disabledUntil) {
            delete _st.disabledUntil;
            _stateChanged = true;
        }
        if (_st.cooldownUntil && _loadNow >= _st.cooldownUntil) {
            delete _st.cooldownUntil;
            delete _st.dailyQuotaExceeded;
            _st.consecutiveFails = 0;
            _st.consecutive429 = 0;
            _stateChanged = true;
        }
    }
    if (_stateChanged) {
        localStorage.setItem(KEY_RUNTIME_STATE_STORAGE_KEY, JSON.stringify(keyRuntimeState));
    }
} catch {}

try {
    const savedMeta = localStorage.getItem(KEY_SELECTOR_META_STORAGE_KEY);
    if (savedMeta) keySelectorMeta = JSON.parse(savedMeta) || { rr: 0 };
} catch {
    keySelectorMeta = { rr: 0 };
}

try {
    const savedModel = localStorage.getItem(MODEL_RUNTIME_STATE_STORAGE_KEY);
    if (savedModel) modelRuntimeState = JSON.parse(savedModel) || {};
} catch {
    modelRuntimeState = {};
}

function persistKeyRuntimeState() {
    try {
        localStorage.setItem(KEY_RUNTIME_STATE_STORAGE_KEY, JSON.stringify(keyRuntimeState));
    } catch {
    }
}

function persistKeySelectorMeta() {
    try {
        localStorage.setItem(KEY_SELECTOR_META_STORAGE_KEY, JSON.stringify(keySelectorMeta));
    } catch {
    }
}

function persistModelRuntimeState() {
    try {
        localStorage.setItem(MODEL_RUNTIME_STATE_STORAGE_KEY, JSON.stringify(modelRuntimeState));
    } catch {
    }
}

function getKeyState(keyId) {
    if (!keyId) return {};
    if (!keyRuntimeState[keyId]) keyRuntimeState[keyId] = {};
    return keyRuntimeState[keyId];
}

// BUGFIX: runtime state (disabledUntil after an auth error, cooldownUntil after
// rate limits/failures, consecutiveFails, etc.) used to be keyed purely by
// keyObj.id — the Firestore FIELD NAME (e.g. "gemini_key_1"), not the actual key
// VALUE. If an old key under that field failed (e.g. an auth error disables it
// for 7 days), and the user later ROTATES the value in Firebase to a brand new,
// valid key but keeps the same field name, the new key silently inherited the
// old key's ban/cooldown from localStorage — so the app kept skipping it and
// never actually used the freshly-updated key. Folding a short fingerprint of
// the key's own VALUE into the state id means a rotated key always starts with
// a clean slate, while the (server-tracked, field-based) usage/quota stats in
// window.apiKeyStatsCache are intentionally left untouched.
function getKeyValueFingerprint(value) {
    try {
        const v = String(value || '').trim();
        if (!v) return 'novalue';
        return v.slice(-10);
    } catch {
        return 'novalue';
    }
}

function getKeyStateId(keyObj) {
    const id = (keyObj && keyObj.id) ? String(keyObj.id) : '';
    const fp = getKeyValueFingerprint(keyObj && keyObj.value);
    return id ? `${id}::${fp}` : '';
}

// ═══════════════════════════════════════════════════════════════════
// GOOGLE-DRIVEN QUOTA / RATE-LIMIT HANDLING
//
// There used to be a second, app-invented quota system here: a hard-coded
// "5000 requests / 2M tokens per month" cap (see the old API_QUOTA_LIMITS in
// index.html) that the app tracked itself and used to permanently gray out
// a key for the rest of the calendar month. That cap had no relationship to
// Google's actual per-key limits (which are per-minute / per-day, not
// monthly, and are usually far more generous than 5000/mo across a shared
// pool of keys) — it just caused keys to get benched early, shrinking the
// usable pool and pushing the remaining keys into real 429s faster, which is
// what produced "ارتباط با هوش مصنوعی برقرار نشد" even though several keys
// still had plenty of real Google quota left.
//
// The app no longer invents its own limits. Every cooldown/disable decision
// below comes from something Google itself told us in a response:
//   - A 429's structured error body (google.rpc.RetryInfo.retryDelay and/or
//     google.rpc.QuotaFailure.violations[].quotaId) tells us exactly how
//     long to wait, and whether it's a per-minute throttle or a per-day
//     quota exhaustion.
//   - A 401/403 with an API_KEY_INVALID-style message tells us the key
//     itself is bad.
// See extractGoogleQuotaInfo() and markKeyFailure() below.
// ═══════════════════════════════════════════════════════════════════

/**
 * Parse Google's structured 429 error body to find out exactly how long to
 * wait and what kind of limit was hit, instead of guessing.
 *
 * Typical Gemini API 429 body:
 * {
 *   "error": {
 *     "code": 429, "status": "RESOURCE_EXHAUSTED",
 *     "details": [
 *       { "@type": ".../google.rpc.QuotaFailure",
 *         "violations": [{ "quotaId": "GenerateRequestsPerDayPerProjectPerModel-FreeTier", ... }] },
 *       { "@type": ".../google.rpc.RetryInfo", "retryDelay": "31s" }
 *     ]
 *   }
 * }
 */
function extractGoogleQuotaInfo(parsedBody) {
    try {
        const details = parsedBody?.error?.details;
        if (!Array.isArray(details)) return null;

        let retryDelaySeconds = null;
        let isPerDay = false;
        let isPerMinute = false;
        let quotaId = null;

        for (const d of details) {
            const type = String(d?.['@type'] || '');
            if (type.includes('RetryInfo') && d?.retryDelay) {
                const m = String(d.retryDelay).match(/([\d.]+)\s*s/i);
                if (m) retryDelaySeconds = parseFloat(m[1]);
            }
            if (type.includes('QuotaFailure') && Array.isArray(d?.violations)) {
                for (const v of d.violations) {
                    const id = String(v?.quotaId || v?.quotaMetric || '');
                    if (id && !quotaId) quotaId = id;
                    if (/perday/i.test(id)) isPerDay = true;
                    if (/perminute/i.test(id)) isPerMinute = true;
                }
            }
        }

        if (retryDelaySeconds === null && !isPerDay && !isPerMinute) return null;
        return { retryDelaySeconds, isPerDay, isPerMinute, quotaId };
    } catch {
        return null;
    }
}

/**
 * Next daily-quota reset boundary Google actually uses for Gemini API
 * free-tier per-day limits: midnight Pacific Time. Used only as the
 * cooldown target when Google flags a per-day quota violation but doesn't
 * hand back an explicit retryDelay for it.
 */
function getNextPacificMidnightMs() {
    try {
        const now = new Date();
        const fmt = new Intl.DateTimeFormat('en-US', {
            timeZone: 'America/Los_Angeles',
            hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false
        });
        const parts = fmt.formatToParts(now).reduce((acc, p) => { acc[p.type] = p.value; return acc; }, {});
        const secondsIntoDay = ((parseInt(parts.hour, 10) || 0) % 24) * 3600 +
            (parseInt(parts.minute, 10) || 0) * 60 + (parseInt(parts.second, 10) || 0);
        const secondsUntilMidnight = (24 * 3600) - secondsIntoDay;
        return now.getTime() + secondsUntilMidnight * 1000 + 5000; // small buffer past the boundary
    } catch {
        // Timezone data unavailable for some reason — 24h is a safe fallback,
        // not an invented business rule, just a last-resort default.
        return nowMs() + 24 * 60 * 60 * 1000;
    }
}

function getModelState(modelId) {
    if (!modelId) return {};
    if (!modelRuntimeState[modelId]) modelRuntimeState[modelId] = {};
    return modelRuntimeState[modelId];
}

function nowMs() {
    return Date.now();
}

async function ensureGeminiKeysLoaded(options = {}) {
    const forceRefresh = options?.forceRefresh === true;
    if (!window.auth?.currentUser) return [];
    if (!forceRefresh && cachedGeminiKeys.length > 0) return cachedGeminiKeys;
    if (!window.fetchGeminiApiKey) return cachedGeminiKeys;

    if (!forceRefresh && cachedGeminiKeysPromise) {
        return cachedGeminiKeysPromise;
    }

    cachedGeminiKeysPromise = (async () => {
        try {
            const keys = await window.fetchGeminiApiKey();
            const nextKeys = Array.isArray(keys) ? keys : (keys ? [keys] : null);
            if (nextKeys) {
                cachedGeminiKeys = nextKeys;
            }
            return cachedGeminiKeys;
        } finally {
            cachedGeminiKeysPromise = null;
        }
    })();

    return cachedGeminiKeysPromise;
}

async function refreshApiKeyStats(options = {}) {
    const force = options?.force === true;
    const background = options?.background === true;
    const now = nowMs();
    const hasCachedStats = !!(window.apiKeyStatsCache && Object.keys(window.apiKeyStatsCache).length > 0);
    if (!force && hasCachedStats && (now - lastStatsRefreshAt) <= 60000) {
        return window.apiKeyStatsCache;
    }
    if (!window.getApiKeyStatsFromServer) {
        return window.apiKeyStatsCache || {};
    }
    if (!force && apiKeyStatsRefreshPromise) {
        return background ? (window.apiKeyStatsCache || {}) : apiKeyStatsRefreshPromise;
    }

    apiKeyStatsRefreshPromise = (async () => {
        try {
            const response = await window.getApiKeyStatsFromServer();
            lastStatsRefreshAt = nowMs();
            return response?.data || window.apiKeyStatsCache || {};
        } catch (error) {
            return window.apiKeyStatsCache || {};
        } finally {
            apiKeyStatsRefreshPromise = null;
        }
    })();

    if (background) {
        apiKeyStatsRefreshPromise.catch(() => {});
        return window.apiKeyStatsCache || {};
    }
    return apiKeyStatsRefreshPromise;
}

async function warmupGeminiResources(options = {}) {
    if (!window.auth?.currentUser) return;
    try {
        await ensureGeminiKeysLoaded({ forceRefresh: options?.forceRefresh === true });
    } catch {}
    try {
        await refreshApiKeyStats({ force: options?.forceRefresh === true, background: false });
    } catch {}
}

function formatDayKeyUTC(date) {
    const y = date.getUTCFullYear();
    const m = String(date.getUTCMonth() + 1).padStart(2, '0');
    const d = String(date.getUTCDate()).padStart(2, '0');
    return `${y}${m}${d}`;
}

function getKeyLastNDaysStats(keyId, days = 3) {
    const keyStat = window.apiKeyStatsCache?.[keyId] || {};
    const daily = keyStat.d || {};
    let req = 0;
    let ok = 0;
    let err = 0;
    let tok = 0;
    let e429 = 0;
    let eAuth = 0;
    let e5xx = 0;
    let eTimeout = 0;

    const base = new Date();
    for (let i = 0; i < days; i++) {
        const dt = new Date(base);
        dt.setUTCDate(dt.getUTCDate() - i);
        const dk = formatDayKeyUTC(dt);
        const ds = daily[dk] || {};
        req += ds.req || 0;
        ok += ds.ok || 0;
        err += ds.err || 0;
        tok += ds.tok || 0;
        e429 += ds.e429 || 0;
        eAuth += ds.eAuth || 0;
        e5xx += ds.e5xx || 0;
        eTimeout += ds.eTimeout || 0;
    }

    return { req, ok, err, tok, e429, eAuth, e5xx, eTimeout };
}

function computeKeyScore(keyObj) {
    if (!keyObj || !keyObj.id) return -Infinity;

    const state = getKeyState(getKeyStateId(keyObj));
    const now = nowMs();

    if (state.disabledUntil && now < state.disabledUntil) return -Infinity;
    if (state.cooldownUntil && now < state.cooldownUntil) return -1000000 + (state.cooldownUntil - now);

    if (state.inFlight && state.inFlight > 0) {
        return -500000 - (state.inFlight * 10000);
    }

    const last = getKeyLastNDaysStats(keyObj.id, 3);
    const total = last.req;
    const successRate = total > 0 ? last.ok / total : 1;

    let score = 1000 * successRate;
    score -= Math.log10(total + 1) * 80;
    score -= (state.consecutiveFails || 0) * 120;
    score -= last.e429 * 250;
    score -= last.eAuth * 500;
    score -= last.e5xx * 80;
    score -= last.eTimeout * 60;

    const sinceLastUse = now - (state.lastUsedAt || 0);
    if (sinceLastUse < 800) score -= 200;
    else if (sinceLastUse < 2000) score -= 80;

    return score;
}

function getOrderedKeys(keys) {
    const scored = keys
        .map(k => ({ k, score: computeKeyScore(k) }))
        .filter(x => Number.isFinite(x.score))
        .sort((a, b) => {
            if (b.score !== a.score) return b.score - a.score;
            const aLast = getKeyState(getKeyStateId(a.k)).lastUsedAt || 0;
            const bLast = getKeyState(getKeyStateId(b.k)).lastUsedAt || 0;
            return aLast - bLast;
        });

    if (scored.length === 0) return [];

    const bestScore = scored[0].score;
    let topCount = 1;
    for (let i = 1; i < scored.length; i++) {
        if (scored[i].score === bestScore) topCount++;
        else break;
    }

    if (topCount > 1) {
        const start = Math.abs(keySelectorMeta.rr || 0) % topCount;
        const rotatedTop = scored.slice(0, topCount);
        const rotated = rotatedTop.slice(start).concat(rotatedTop.slice(0, start));
        const result = rotated.concat(scored.slice(topCount));
        return result.map(x => x.k);
    }

    return scored.map(x => x.k);
}

function classifyGeminiError(error) {
    const msg = (error?.message || '').toString();
    const status = typeof error?.status === 'number' ? error.status : undefined;

    const low = msg.toLowerCase();
    if (low.includes('api_key_invalid') || low.includes('api key not valid') || low.includes('invalid api key') || low.includes('permission_denied')) {
        return { type: 'auth', statusCode: status || 403 };
    }

    if (error?.name === 'AbortError') {
        return { type: 'abort' };
    }

    if (msg === 'RATE_LIMIT_429' || status === 429 || msg.includes('HTTP_429')) {
        return { type: 'rate_limit', statusCode: 429, quotaInfo: error?.quotaInfo || null };
    }
    if (msg === 'MODEL_NOT_FOUND' || status === 404) {
        return { type: 'model_not_found', statusCode: 404 };
    }
    if (msg === 'TIMEOUT' || error?.code === 'TIMEOUT') {
        return { type: 'timeout' };
    }
    if (status === 401 || status === 403 || msg.includes('HTTP_401') || msg.includes('HTTP_403')) {
        return { type: 'auth', statusCode: status || (msg.includes('HTTP_401') ? 401 : 403) };
    }
    if ((status && status >= 500) || msg.includes('HTTP_5')) {
        return { type: 'server', statusCode: status };
    }

    if (error?.name === 'TypeError' || msg.toLowerCase().includes('failed to fetch')) {
        return { type: 'network' };
    }

    if (msg.startsWith('HTTP_')) {
        const m = msg.match(/HTTP_(\d+)/);
        return { type: 'http', statusCode: m ? parseInt(m[1], 10) : undefined };
    }

    return { type: 'unknown' };
}

function acquireKeyLease(keyObj) {
    const stateId = getKeyStateId(keyObj);
    const state = getKeyState(stateId);
    state.lastUsedAt = nowMs();
    state.inFlight = (state.inFlight || 0) + 1;
    persistKeyRuntimeState();

    keySelectorMeta.rr = (keySelectorMeta.rr || 0) + 1;
    persistKeySelectorMeta();

    let released = false;
    return () => {
        if (released) return;
        released = true;

        const st = getKeyState(stateId);
        st.inFlight = Math.max(0, (st.inFlight || 0) - 1);
        persistKeyRuntimeState();
    };
}

function markKeySuccess(keyObj) {
    const state = getKeyState(getKeyStateId(keyObj));
    state.consecutiveFails = 0;
    state.consecutive429 = 0;
    try { delete state.lastError; } catch {}
    state.lastSuccessAt = nowMs();
    state.cooldownUntil = nowMs() + 500;
    delete state.dailyQuotaExceeded;

    persistKeyRuntimeState();
}

function markKeyFailure(keyObj, info) {
    const state = getKeyState(getKeyStateId(keyObj));
    state.lastFailureAt = nowMs();
    state.consecutiveFails = (state.consecutiveFails || 0) + 1;

    const isDailyQuota = !!(info?.type === 'rate_limit' && info?.quotaInfo?.isPerDay);

    try {
        state.lastError = {
            type: info?.type,
            statusCode: info?.statusCode,
            message: (info?.message || '').toString().slice(0, 300),
            at: nowMs(),
            dailyQuota: isDailyQuota
        };
    } catch {}

    if (info?.type === 'rate_limit') {
        state.consecutive429 = (state.consecutive429 || 0) + 1;
        const q = info.quotaInfo;

        if (q?.retryDelaySeconds != null && Number.isFinite(q.retryDelaySeconds)) {
            // Google told us exactly how long to wait (google.rpc.RetryInfo) —
            // trust that verbatim rather than guessing our own backoff.
            state.cooldownUntil = nowMs() + Math.ceil(q.retryDelaySeconds * 1000) + 500;
            state.dailyQuotaExceeded = isDailyQuota;
        } else if (isDailyQuota) {
            // Google flagged a per-day quota violation (QuotaFailure with a
            // "...PerDay..." quotaId) but gave no explicit retryDelay. The
            // real reset boundary for Gemini API free-tier daily quotas is
            // midnight Pacific Time, so wait for that instead of a guess.
            state.cooldownUntil = getNextPacificMidnightMs();
            state.dailyQuotaExceeded = true;
        } else {
            // Bare 429 with no structured details at all — Google gave us
            // nothing to go on, so fall back to a conservative exponential
            // backoff purely as a last resort (not a substitute for real info
            // when it's available).
            const base = 30000;
            const delay = Math.min(10 * 60 * 1000, base * Math.pow(2, Math.max(0, state.consecutive429 - 1)));
            state.cooldownUntil = nowMs() + delay;
            state.dailyQuotaExceeded = false;
        }
    } else if (info?.type === 'auth') {
        state.disabledUntil = nowMs() + (7 * 24 * 60 * 60 * 1000);
        state.cooldownUntil = nowMs() + (7 * 24 * 60 * 60 * 1000);
        // Force re-fetch keys on next call in case the key was rotated in Firebase
        cachedGeminiKeys = [];
        cachedGeminiKeysPromise = null;
    } else if (info?.type === 'server') {
        const base = 15000;
        const exp = Math.max(0, (state.consecutiveFails || 1) - 1);
        const delay = Math.min(10 * 60 * 1000, base * Math.pow(2, Math.min(6, exp)));
        state.cooldownUntil = nowMs() + delay;
    } else if (info?.type === 'timeout' || info?.type === 'network') {
        const base = 12000;
        const exp = Math.max(0, (state.consecutiveFails || 1) - 1);
        const delay = Math.min(5 * 60 * 1000, base * Math.pow(2, Math.min(6, exp)));
        state.cooldownUntil = nowMs() + delay;
    } else {
        const base = 2500;
        const exp = Math.max(0, (state.consecutiveFails || 1) - 1);
        const delay = Math.min(2 * 60 * 1000, base * Math.pow(2, Math.min(6, exp)));
        state.cooldownUntil = nowMs() + delay;
    }

    persistKeyRuntimeState();
}

// ═══════════════════════════════════════════════════════════════════
// UTILITY FUNCTIONS
// ═══════════════════════════════════════════════════════════════════

/**
 * Shuffle array using Fisher-Yates algorithm
 */
function shuffleArray(array) {
    const arr = [...array];
    for (let i = arr.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
}

/**
 * Safe JSON parse with fallback
 */
function safeJsonParse(str, fallback = []) {
    try {
        return JSON.parse(str);
    } catch {
        return fallback;
    }
}

/**
 * Extract text from Gemini response safely
 * gemini-2.5-flash با thinking فعال، parts[0] ممکنه "thought" باشه نه جواب اصلی.
 * از آخر به اول می‌گردیم تا آخرین part غیر-thought رو پیدا کنیم.
 */
function extractResponseText(result) {
    try {
        const parts = result?.candidates?.[0]?.content?.parts || [];
        for (let i = parts.length - 1; i >= 0; i--) {
            if (!parts[i].thought && parts[i].text) return parts[i].text;
        }
        // fallback: اگه همه thought بودن یا parts خالی بود
        return parts[0]?.text || null;
    } catch {
        return null;
    }
}

/**
 * Extract token usage from Gemini response
 */
function extractTokenUsage(result) {
    const meta = result?.usageMetadata || {};
    const promptTokens = meta.promptTokenCount || 0;
    const candidatesTokens = meta.candidatesTokenCount || 0;
    const totalTokens = meta.totalTokenCount || (promptTokens + candidatesTokens);
    
    return { promptTokens, candidatesTokens, totalTokens };
}

// ═══════════════════════════════════════════════════════════════════
// FETCH WITH RETRY
// ═══════════════════════════════════════════════════════════════════

async function fetchWithRetry(url, options = {}, config = RETRY_CONFIG) {
    let lastError;
    const externalSignal = options?.signal;
    
    for (let attempt = 0; attempt < config.maxRetries; attempt++) {
        try {
            const controller = new AbortController();
            const onExternalAbort = () => controller.abort();
            if (externalSignal) {
                if (externalSignal.aborted) {
                    controller.abort();
                } else {
                    externalSignal.addEventListener('abort', onExternalAbort, { once: true });
                }
            }
            const timeoutId = setTimeout(() => controller.abort(), config.timeout);
            let response;
            try {
                response = await fetch(url, { ...options, signal: controller.signal });
            } finally {
                clearTimeout(timeoutId);
                if (externalSignal) {
                    try { externalSignal.removeEventListener('abort', onExternalAbort); } catch {}
                }
            }
            
            // 404 = Model not found, don't retry
            if (response.status === 404) {
                const err = new Error("MODEL_NOT_FOUND");
                err.status = 404;
                throw err;
            }
            
            // 429 = Rate limit, throw immediately for key switching.
            // Read the body so we can pull Google's own retryDelay / quota
            // type (RetryInfo / QuotaFailure) instead of guessing our own
            // backoff — see extractGoogleQuotaInfo / markKeyFailure.
            if (response.status === 429) {
                let quotaInfo = null;
                try {
                    const bodyText = await response.text();
                    quotaInfo = extractGoogleQuotaInfo(JSON.parse(bodyText));
                } catch {}
                const err = new Error("RATE_LIMIT_429");
                err.status = 429;
                err.quotaInfo = quotaInfo;
                throw err;
            }

            if (!response.ok) {
                const errorBody = await response.text();
                const err = new Error(`HTTP_${response.status}: ${errorBody}`);
                err.status = response.status;
                err.body = errorBody;
                throw err;
            }
            
            return response;
        } catch (error) {
            // Don't retry for specific errors - let upper layer handle
            if (error?.name === 'AbortError') {
                if (externalSignal?.aborted) {
                    throw error;
                }
                const err = new Error('TIMEOUT');
                err.code = 'TIMEOUT';
                throw err;
            }

            if (error.message === "MODEL_NOT_FOUND" || error.message === "RATE_LIMIT_429") {
                throw error;
            }

            const httpMatch = (error?.message || '').toString().match(/^HTTP_(\d+)/);
            if (httpMatch) {
                const httpStatus = parseInt(httpMatch[1], 10);
                if (httpStatus >= 500) {
                    // 5xx: retry با exponential backoff
                    lastError = error;
                    if (attempt < config.maxRetries - 1) {
                        const delay = Math.min(config.maxDelay, config.initialDelay * Math.pow(2, attempt));
                        await new Promise(r => setTimeout(r, delay));
                    }
                    continue;
                }
                // 4xx غیر از 429 و 404: throw فوری (کلید اشتباه، بدی ریکوئست و...)
                throw error;
            }

            lastError = error;
            
            // Wait before retry (exponential backoff)
            if (attempt < config.maxRetries - 1) {
                await new Promise(r => setTimeout(r, config.initialDelay * (attempt + 1)));
            }
        }
    }
    
    throw lastError;
}

// ═══════════════════════════════════════════════════════════════════
// MAIN API FUNCTION
// ═══════════════════════════════════════════════════════════════════

async function callGeminiAPIWithRetry(generationConfig, history = [], customRetryConfig = {}) {
    // Validate user is logged in
    if (!window.auth?.currentUser) {
        throw new Error("لطفاً وارد شوید.");
    }

    // Load API keys if not cached
    await ensureGeminiKeysLoaded();
    
    if (cachedGeminiKeys.length === 0) {
        throw new Error("کلید API یافت نشد.");
    }

    // Get model selection settings
    const disabledRaw = localStorage.getItem('disabled_ai_models');
    let disabledModels = safeJsonParse(disabledRaw, []);
    if (!disabledRaw) {
        try {
            localStorage.setItem('disabled_ai_models', JSON.stringify(DEFAULT_DISABLED_MODELS));
        } catch {
        }
        disabledModels = [...DEFAULT_DISABLED_MODELS];
    } else {
        if (!Array.isArray(disabledModels)) disabledModels = [];
        if (disabledModels.length === 0 && disabledRaw.trim() !== '[]') {
            try {
                localStorage.setItem('disabled_ai_models', JSON.stringify(DEFAULT_DISABLED_MODELS));
            } catch {
            }
            disabledModels = [...DEFAULT_DISABLED_MODELS];
        }
    }
    disabledModels = disabledModels.filter(m => SUPPORTED_MODELS.has(m));
    let preferredModel = localStorage.getItem('preferred_model') || 'hybrid';
    const intent = customRetryConfig.intent || 'strong';
    const forcedModel = normalizeModelId(customRetryConfig.model);

    console.log('[AI settings]', {
        preferred_model: preferredModel,
        disabled_ai_models_raw: disabledRaw,
        disabled_ai_models: disabledModels,
        intent,
        forcedModel
    });

    const now = nowMs();
    if ((now - lastStatsRefreshAt) > 60000) {
        refreshApiKeyStats({ background: true }).catch(() => {});
    }
    
    // Determine which models to try
    let modelsToTry;
    
    if (forcedModel && forcedModel !== 'hybrid') {
        modelsToTry = [forcedModel];
    } else {
        preferredModel = normalizeModelId(preferredModel) || preferredModel;

        if (preferredModel !== 'hybrid') {
            // User selected specific model - use only that model
            if (!normalizeModelId(preferredModel)) {
                preferredModel = 'hybrid';
                try { localStorage.setItem('preferred_model', 'hybrid'); } catch {}
            }
            modelsToTry = preferredModel === 'hybrid' ? [] : [preferredModel];
            if (preferredModel !== 'hybrid') {
                const modelOrder = intent === 'quick' ? MODELS_WEAK_TO_STRONG : MODELS_STRONG_TO_WEAK;
                const otherModels = modelOrder.filter(m => m !== preferredModel && !disabledModels.includes(m));
                modelsToTry.push(...otherModels);
            }
        }

        if (!modelsToTry || modelsToTry.length === 0) {
            // Auto mode - filter by enabled models, order by intent
            const modelOrder = intent === 'quick' ? MODELS_WEAK_TO_STRONG : MODELS_STRONG_TO_WEAK;
            modelsToTry = modelOrder.filter(m => !disabledModels.includes(m));

            // Emergency fallback if all disabled
            if (modelsToTry.length === 0) {
                modelsToTry = ['gemini-3.6-flash'];
            }
        }
    }
    
    // Log selection (single line for cleaner output)
    console.log(`🤖 AI: ${intent} mode, models: [${modelsToTry.join(', ')}]`);

    try {
        const now = nowMs();
        const filtered = modelsToTry.filter(m => {
            const st = getModelState(m);
            return !(st.cooldownUntil && now < st.cooldownUntil);
        });
        if (filtered.length > 0) modelsToTry = filtered;
    } catch {}

    const keysToTryBase = getOrderedKeys(cachedGeminiKeys);
    
    let lastError = null;

    const triedModels = [];

    // Try each model
    for (const model of modelsToTry) {
        triedModels.push(model);
        let keysToTry = getOrderedKeys(keysToTryBase);

        let transientFailCountForModel = 0;
        let abortModelEarly = false;
        if (keysToTry.length === 0) {
            const all = cachedGeminiKeys || [];
            let minWait = Infinity;
            for (const k of all) {
                const st = getKeyState(getKeyStateId(k));
                const wait = (st.cooldownUntil || 0) - nowMs();
                if (wait > 0 && wait < minWait) minWait = wait;
            }
            if (Number.isFinite(minWait) && minWait > 0 && minWait <= 3000) {
                await new Promise(r => setTimeout(r, minWait));
                keysToTry = getOrderedKeys(cachedGeminiKeys);
            }
        }

        if (keysToTry.length === 0) {
            const all = cachedGeminiKeys || [];
            let minWait = Infinity;
            for (const k of all) {
                const st = getKeyState(getKeyStateId(k));
                const wait = (st.cooldownUntil || 0) - nowMs();
                if (wait > 0 && wait < minWait) minWait = wait;
            }
            if (Number.isFinite(minWait) && minWait > 0) {
                throw new Error(`همه کلیدها در حالت کول‌داون هستند. لطفاً حدود ${Math.ceil(minWait / 1000)} ثانیه صبر کنید.`);
            }
            throw new Error('هیچ کلید فعالی برای استفاده در دسترس نیست.');
        }

        // Try each key for this model
        for (const keyObj of keysToTry) {
            const st = getKeyState(getKeyStateId(keyObj));
            const nowTry = nowMs();
            if (st.disabledUntil && nowTry < st.disabledUntil) continue;
            if (st.cooldownUntil && nowTry < st.cooldownUntil) continue;

            const releaseLease = acquireKeyLease(keyObj);

            try {
                const apiVersion = model.includes('-exp') ? 'v1alpha' : 'v1beta';
                const endpoint = `https://generativelanguage.googleapis.com/${apiVersion}/models/${model}:generateContent?key=${keyObj.value}`;
                
                let finalGenerationConfig = { ...generationConfig };
                if (model.includes('thinking')) {
                    delete finalGenerationConfig.response_mime_type;
                    delete finalGenerationConfig.responseSchema;
                    delete finalGenerationConfig.systemInstruction;
                }

                const response = await fetchWithRetry(endpoint, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ contents: history, generationConfig: finalGenerationConfig }),
                    signal: customRetryConfig?.signal
                }, RETRY_CONFIG);
                
                const result = await response.json();
                const text = extractResponseText(result);
                
                if (text) {
                    // Log success and token usage
                    const usage = extractTokenUsage(result);
                    window.logApiKeyUsage?.(keyObj.id, true, usage, { statusCode: 200 });
                    markKeySuccess(keyObj);
                    try {
                        const ms = getModelState(model);
                        ms.failCount = 0;
                        delete ms.cooldownUntil;
                        persistModelRuntimeState();
                    } catch {}
                    releaseLease();
                    console.log(`✅ ${model} | Key: ${keyObj.id} | Tokens: ${usage.totalTokens}`);

                    const fallbackFrom = triedModels.length > 0 && triedModels[0] !== model ? triedModels[0] : null;
                    
                    const rawText = (text ?? '').toString();
                    const cleanedText = rawText.replace(/```json|```/g, '').trim();
                    const wantsJson = (generationConfig?.response_mime_type || '').toString().toLowerCase().includes('json');
                    const looksLikeJson = cleanedText.startsWith('{') || cleanedText.startsWith('[') || rawText.includes('```json');

                    if (wantsJson || looksLikeJson) {
                        let parsedJson = null;
                        const candidates = [];

                        if (cleanedText) {
                            candidates.push(cleanedText);

                            const firstBrace = cleanedText.indexOf('{');
                            const lastBrace = cleanedText.lastIndexOf('}');
                            if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
                                candidates.push(cleanedText.substring(firstBrace, lastBrace + 1));
                            }

                            const firstBracket = cleanedText.indexOf('[');
                            const lastBracket = cleanedText.lastIndexOf(']');
                            if (firstBracket !== -1 && lastBracket !== -1 && lastBracket > firstBracket) {
                                candidates.push(cleanedText.substring(firstBracket, lastBracket + 1));
                            }
                        }

                        for (const c of candidates) {
                            try {
                                parsedJson = JSON.parse(c);
                                break;
                            } catch (e) {}
                        }

                        if (parsedJson && typeof parsedJson === 'object') {
                            parsedJson.usedModel = model;
                            parsedJson.triedModels = triedModels;
                            if (fallbackFrom) parsedJson.fallbackFrom = fallbackFrom;
                            return parsedJson;
                        }
                    }

                    // Return as enhanced string
                    const strObj = new String(rawText);
                    strObj.usedModel = model;
                    strObj.triedModels = triedModels;
                    if (fallbackFrom) strObj.fallbackFrom = fallbackFrom;
                    return strObj;
                }

                releaseLease();
            } catch (error) {
                const info = classifyGeminiError(error);
                if (info.type === 'abort') {
                    releaseLease();
                    throw error;
                }
                if (info.type !== 'model_not_found') {
                    window.logApiKeyUsage?.(keyObj.id, false, { promptTokens: 0, candidatesTokens: 0, totalTokens: 0 }, { errorType: info.type, statusCode: info.statusCode });
                    markKeyFailure(keyObj, { ...info, message: (error?.message || '').toString() });
                }
                releaseLease();
                lastError = error;

                if (info.type === 'server' || info.type === 'timeout' || info.type === 'network') {
                    transientFailCountForModel++;
                    if (transientFailCountForModel >= 2) {
                        abortModelEarly = true;
                        break;
                    }
                }

                if (info.type === 'model_not_found') {
                    console.warn(`🚨 Model ${model} is disabled/not found. Failing this model immediately for this session.`);
                    modelRuntimeState[model] = modelRuntimeState[model] || {};
                    modelRuntimeState[model].isFailed = true;
                    persistModelRuntimeState();
                    if (localStorage.getItem('preferred_model') === model) {
                        try { localStorage.setItem('preferred_model', 'hybrid'); } catch {}
                    }
                    abortModelEarly = true;
                    break;
                }
            }
        }

        if (abortModelEarly) {
            console.warn(`⚠️ ${model}: transient failures detected, falling back early`);
            try {
                const ms = getModelState(model);
                ms.failCount = (ms.failCount || 0) + 1;
                const base = 60000;
                const exp = Math.max(0, (ms.failCount || 1) - 1);
                const delay = Math.min(30 * 60 * 1000, base * Math.pow(2, Math.min(4, exp)));
                ms.cooldownUntil = nowMs() + delay;
                persistModelRuntimeState();
            } catch {}
            continue;
        }
        
        // All keys failed for this model, try next
        console.warn(`⚠️ ${model}: all keys failed`);
    }

    // All models and keys failed
    console.error("❌ All models/keys failed:", lastError?.message);
    
    if (lastError?.message?.includes('429')) {
        throw new Error("ظرفیت استفاده تکمیل شده است. لطفاً کمی صبر کنید.");
    }
    
    // TEMPORARY DEBUG: Throw the exact error message so we can see what Google API is complaining about
    throw new Error(`خطای API گوگل: ${lastError?.message || 'نامشخص'}`);
}

// ═══════════════════════════════════════════════════════════════════
// ERROR DISPLAY
// ═══════════════════════════════════════════════════════════════════

function displayErrorWithRetry(error, retryCallback, containerElement, dismissCallback = null) {
    containerElement.innerHTML = `
        <div class="p-4 bg-red-50 dark:bg-red-900/30 text-red-800 dark:text-red-200 rounded border border-red-200 dark:border-red-800">
            <p class="font-bold text-sm">خطا</p>
            <p class="text-xs mt-1">${error.message}</p>
            <div class="flex gap-2 mt-2">
                <button class="retry-btn bg-red-600 text-white px-3 py-1 rounded text-xs hover:bg-red-700">تلاش مجدد</button>
                <button class="dismiss-btn bg-gray-300 dark:bg-gray-600 text-gray-800 dark:text-gray-200 px-3 py-1 rounded text-xs hover:bg-gray-400">بستن</button>
            </div>
        </div>`;
    
    containerElement.querySelector('.retry-btn')?.addEventListener('click', () => {
        cachedGeminiKeys = []; // Reset keys cache
        cachedGeminiKeysPromise = null;
        retryCallback();
    });
    
    containerElement.querySelector('.dismiss-btn')?.addEventListener('click', () => {
        if (typeof dismissCallback === 'function') {
            dismissCallback();
            return;
        }
        containerElement.innerHTML = '';
        containerElement.classList.add('hidden');
    });
}

// ═══════════════════════════════════════════════════════════════════
// OTHER API FUNCTIONS
// ═══════════════════════════════════════════════════════════════════

async function callGoogleTranslateAPI(term, targetLang, options = {}) {
    const sourceLang = String(options?.sourceLang || 'auto').trim() || 'auto';
    const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=${encodeURIComponent(sourceLang)}&tl=${encodeURIComponent(targetLang)}&dt=t&q=${encodeURIComponent(term)}`;
    const response = await fetch(url, { signal: options?.signal });
    
    if (!response.ok) {
        throw new Error('Google Translate connection failed');
    }
    
    return await response.json();
}

async function checkVersion() {
    try {
        const response = await fetch('/version.json?t=' + Date.now());
        if (!response.ok) return null;
        const data = await response.json();
        return data.version;
    } catch {
        return null;
    }
}

// ═══════════════════════════════════════════════════════════════════
// EXPORTS
// ═══════════════════════════════════════════════════════════════════

window.APIUtils = {
    fetchWithRetry,
    callGeminiAPIWithRetry,
    callGoogleTranslateAPI,
    checkVersion,
    displayErrorWithRetry,
    ensureGeminiKeysLoaded,
    refreshApiKeyStats,
    warmupGeminiResources,
    ERROR_TYPES,
    ERROR_MESSAGES,
    MODELS_STRONG_TO_WEAK,
    MODELS_WEAK_TO_STRONG
};

try {
    window.getApiKeyRuntimeState = (keyId, keyValue) => {
        if (!keyId) return null;
        if (keyValue) return getKeyState(getKeyStateId({ id: keyId, value: keyValue }));
        // Fallback (no value provided): try to find the current key by id from
        // the loaded cache so the fingerprinted state is still used correctly.
        const found = (cachedGeminiKeys || []).find(k => k && k.id === keyId);
        if (found) return getKeyState(getKeyStateId(found));
        return getKeyState(keyId);
    };
} catch {}
