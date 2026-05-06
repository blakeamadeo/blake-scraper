/* ============================================
   BLAKE AMADEO PORTFOLIO — SCRAPER
   Runs daily at 6am ET via GitHub Actions
   ----------------------------------------------
   What it does:
   1. Reads Blake's profile from Firebase
   2. Pulls casting calls + industry news from
      free RSS sources (no scraping of paid sites)
   3. Filters by profile criteria (height, age,
      ethnicity, markets, etc.)
   4. Writes filtered results to Firebase under:
        - castings/      (matched casting calls)
        - news/          (matched news items)
        - castingHealth/ (per-source health stats)
        - castingLog/    (errors + run history)
   5. Trims entries older than 30 days
   6. Auto-pauses any source that fails 3 times
      in a row
   ============================================ */

const Parser = require('rss-parser');
const admin = require('firebase-admin');

// ============================================
// FIREBASE INIT
// ============================================
// Service account JSON comes from a GitHub Secret
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);

admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    databaseURL: process.env.FIREBASE_DB_URL || 'https://blake-portfolio-af7ff-default-rtdb.firebaseio.com'
});

const db = admin.database();
const parser = new Parser({ timeout: 15000, headers: { 'User-Agent': 'Mozilla/5.0 (compatible; BlakePortfolioScraper/1.0)' } });

// ============================================
// SOURCE GROUPS
// All free, all toggleable individually from
// Blake's admin panel via database.ref('castingSources')
// ============================================
const DEFAULT_SOURCES = [
    // ---- REDDIT RSS (casting subs) ----
    { id: 'reddit-actor',          group: 'Reddit',  name: 'r/acting',                   type: 'reddit',   url: 'https://www.reddit.com/r/acting/.rss',                          enabled: true,  filter: 'casting' },
    { id: 'reddit-actorforhire',   group: 'Reddit',  name: 'r/ActorForHire',             type: 'reddit',   url: 'https://www.reddit.com/r/ActorForHire/.rss',                    enabled: true,  filter: 'casting' },
    { id: 'reddit-castingcall',    group: 'Reddit',  name: 'r/castingcall',              type: 'reddit',   url: 'https://www.reddit.com/r/castingcall/.rss',                     enabled: true,  filter: 'casting' },
    { id: 'reddit-filmmakers',     group: 'Reddit',  name: 'r/filmmakers (casting)',     type: 'reddit',   url: 'https://www.reddit.com/r/Filmmakers/search.rss?q=casting&restrict_sr=on&sort=new', enabled: true, filter: 'casting' },
    { id: 'reddit-nycauditions',   group: 'Reddit',  name: 'r/nycauditions',             type: 'reddit',   url: 'https://www.reddit.com/r/nycauditions/.rss',                    enabled: true,  filter: 'casting' },
    { id: 'reddit-laauditions',    group: 'Reddit',  name: 'r/LosAngelesActors',         type: 'reddit',   url: 'https://www.reddit.com/r/LosAngelesActors/.rss',                enabled: true,  filter: 'casting' },
    { id: 'reddit-indiefilm',      group: 'Reddit',  name: 'r/IndieFilm',                type: 'reddit',   url: 'https://www.reddit.com/r/IndieFilm/.rss',                       enabled: true,  filter: 'casting' },
    { id: 'reddit-actorlife',      group: 'Reddit',  name: 'r/actorlife',                type: 'reddit',   url: 'https://www.reddit.com/r/actorlife/.rss',                       enabled: true,  filter: 'casting' },

    // ---- INDUSTRY NEWS RSS ----
    { id: 'news-deadline',         group: 'News',    name: 'Deadline',                   type: 'news',     url: 'https://deadline.com/feed/',                                    enabled: true,  filter: 'news' },
    { id: 'news-variety',          group: 'News',    name: 'Variety',                    type: 'news',     url: 'https://variety.com/feed/',                                     enabled: true,  filter: 'news' },
    { id: 'news-thr',              group: 'News',    name: 'Hollywood Reporter',         type: 'news',     url: 'https://www.hollywoodreporter.com/feed/',                       enabled: true,  filter: 'news' },
    { id: 'news-indiewire',        group: 'News',    name: 'IndieWire',                  type: 'news',     url: 'https://www.indiewire.com/feed/',                               enabled: true,  filter: 'news' },
    { id: 'news-backstage',        group: 'News',    name: 'Backstage News',             type: 'news',     url: 'https://www.backstage.com/news/rss/',                           enabled: true,  filter: 'news' },
    { id: 'news-screencrush',      group: 'News',    name: 'ScreenCrush',                type: 'news',     url: 'https://screencrush.com/feed/',                                 enabled: true,  filter: 'news' },
    { id: 'news-collider',         group: 'News',    name: 'Collider',                   type: 'news',     url: 'https://collider.com/feed/',                                    enabled: true,  filter: 'news' },
    { id: 'news-slashfilm',        group: 'News',    name: 'SlashFilm',                  type: 'news',     url: 'https://www.slashfilm.com/feed/',                               enabled: true,  filter: 'news' },

    // ---- PUBLIC CASTING LISTING SITES (RSS where available) ----
    { id: 'public-castingcrane',   group: 'Public',  name: 'CastingCrane (free RSS)',    type: 'casting',  url: 'https://www.castingcrane.com/feed/',                            enabled: true,  filter: 'casting' },
    { id: 'public-projectcasting', group: 'Public',  name: 'Project Casting (blog)',     type: 'casting',  url: 'https://www.projectcasting.com/feed/',                          enabled: true,  filter: 'casting' },
    { id: 'public-castingfrontier',group: 'Public',  name: 'Casting Frontier blog',      type: 'casting',  url: 'https://blog.castingfrontier.com/feed',                         enabled: true,  filter: 'casting' },
    { id: 'public-nyfa',           group: 'Public',  name: 'NYFA Casting Calls',         type: 'casting',  url: 'https://www.nyfa.edu/student-resources/casting-calls/feed/',    enabled: true,  filter: 'casting' },
    { id: 'public-stagemilk',      group: 'Public',  name: 'StageMilk',                  type: 'casting',  url: 'https://www.stagemilk.com/feed/',                               enabled: true,  filter: 'casting' },

    // ---- INDEED RSS (jobs feed for "actor") ----
    { id: 'indeed-actor-ny',       group: 'Indeed',  name: 'Indeed: actor New York',     type: 'job',      url: 'https://www.indeed.com/rss?q=actor&l=New+York%2C+NY',          enabled: true,  filter: 'job' },
    { id: 'indeed-actor-la',       group: 'Indeed',  name: 'Indeed: actor Los Angeles',  type: 'job',      url: 'https://www.indeed.com/rss?q=actor&l=Los+Angeles%2C+CA',       enabled: true,  filter: 'job' },
    { id: 'indeed-model-ny',       group: 'Indeed',  name: 'Indeed: model New York',     type: 'job',      url: 'https://www.indeed.com/rss?q=model&l=New+York%2C+NY',          enabled: true,  filter: 'job' },
    { id: 'indeed-actor-fl',       group: 'Indeed',  name: 'Indeed: actor Florida',      type: 'job',      url: 'https://www.indeed.com/rss?q=actor&l=Florida',                 enabled: true,  filter: 'job' },
    { id: 'indeed-actor-utah',     group: 'Indeed',  name: 'Indeed: actor Utah',         type: 'job',      url: 'https://www.indeed.com/rss?q=actor&l=Utah',                    enabled: true,  filter: 'job' },
    { id: 'indeed-extra-ny',       group: 'Indeed',  name: 'Indeed: film extra NY',      type: 'job',      url: 'https://www.indeed.com/rss?q=film+extra&l=New+York%2C+NY',     enabled: true,  filter: 'job' },
    { id: 'indeed-commercial',     group: 'Indeed',  name: 'Indeed: commercial actor',   type: 'job',      url: 'https://www.indeed.com/rss?q=commercial+actor',                 enabled: true,  filter: 'job' }
];

// ============================================
// PROFILE FILTERING
// Reads Blake's profile from Firebase so admin
// changes take effect on the next scrape run
// ============================================
async function loadProfile() {
    const snap = await db.ref('scraperProfile').once('value');
    const stored = snap.val() || {};
    return Object.assign({
        // Defaults — match Blake's profile
        age: 24,
        ageRange: { min: 18, max: 35 },
        heightMinInches: 68,           // 5'8" → 68"
        ethnicities: ['white', 'caucasian', 'italian', 'mediterranean', 'any', 'open ethnicity'],
        hairColors: ['brown', 'dark brown', 'black', 'brown/black', 'any'],
        eyeColors: ['blue', 'any'],
        genders: ['male', 'man', 'guys', 'any', 'open'],
        unionStatus: 'non-union',      // toggleable; if 'any', skip union filter
        markets: ['NY', 'New York', 'NYC', 'Utah', 'UT', 'LA', 'Los Angeles', 'FL', 'Florida'],
        localHire: true,
        excludeKeywords: ['nudity', 'nude', 'sex scene', 'sexual content', 'explicit'],
        maxAgeDays: 30                 // entries older than this get pruned
    }, stored);
}

// ============================================
// FILTERS — match incoming items against profile
// ============================================
function inchesFromHeight(str) {
    // Parse '5'8"', "5ft 8in", '68"', '173cm', etc. → inches
    if (!str) return null;
    const s = String(str).toLowerCase();
    let m = s.match(/(\d+)\s*['']\s*(\d+)/); // 5'8"
    if (m) return parseInt(m[1]) * 12 + parseInt(m[2]);
    m = s.match(/(\d+)\s*ft\s*(\d+)/);
    if (m) return parseInt(m[1]) * 12 + parseInt(m[2]);
    m = s.match(/(\d+)\s*"\s*$/);          // 68"
    if (m) return parseInt(m[1]);
    m = s.match(/(\d+)\s*cm/);
    if (m) return Math.round(parseInt(m[1]) / 2.54);
    return null;
}

function passesProfileFilter(item, profile) {
    const text = ((item.title || '') + ' ' + (item.contentSnippet || '') + ' ' + (item.content || '')).toLowerCase();
    if (!text.trim()) return { pass: false, reason: 'empty' };

    // Hard exclusions
    for (const kw of profile.excludeKeywords) {
        if (text.includes(kw.toLowerCase())) return { pass: false, reason: `excluded: ${kw}` };
    }

    // Age — find any "X to Y" or "Xs" age mentions
    const ageMatches = text.match(/age(?:d)?\s*:?\s*(\d+)\s*(?:[-–to]+)\s*(\d+)/i)
                    || text.match(/(\d+)\s*[-–to]+\s*(\d+)\s*(?:years?|yo|y\/o)/i)
                    || text.match(/(\d{2})s\s+(?:male|man|guy)/i);
    if (ageMatches) {
        const min = parseInt(ageMatches[1]);
        const max = parseInt(ageMatches[2] || ageMatches[1]) + (ageMatches[0].includes('s ') ? 9 : 0);
        if (profile.age < min || profile.age > max) {
            return { pass: false, reason: `age mismatch: ${min}-${max}` };
        }
    }

    // Height — only filter if a minimum is mentioned and it's above Blake's
    const heightMatch = text.match(/(?:height|tall|min(?:imum)?\s*height)[:\s]*(\d+\s*['']\s*\d+|\d+\s*ft\s*\d+|\d+\s*cm)/i);
    if (heightMatch) {
        const minRequired = inchesFromHeight(heightMatch[1]);
        if (minRequired && minRequired > profile.heightMinInches) {
            return { pass: false, reason: `height required ${heightMatch[1]}` };
        }
    }

    // Gender
    const wantsFemale = /\b(female|woman|women|girl|she\/her|f\/)\b/.test(text)
                     && !/\b(male|man|guys?|he\/him|m\/)\b/.test(text);
    if (wantsFemale) return { pass: false, reason: 'female only' };

    // Union — skip if profile says non-union and the item demands union
    if (profile.unionStatus === 'non-union') {
        if (/\b(sag-aftra required|union only|sag eligible required|must be sag)\b/.test(text)) {
            return { pass: false, reason: 'union required' };
        }
    }

    // Market match — pass if any market keyword appears OR if no location specified at all
    const hasLocationMention = /\b(new york|nyc|brooklyn|manhattan|los angeles|\bla\b|hollywood|atlanta|utah|salt lake|park city|miami|orlando|tampa|florida|remote|self-tape|virtual)\b/i.test(text);
    if (hasLocationMention) {
        const matchesMarket = profile.markets.some(m => text.includes(m.toLowerCase())) || /\b(remote|self-tape|virtual)\b/i.test(text);
        if (!matchesMarket) return { pass: false, reason: 'market mismatch' };
    }

    return { pass: true };
}

// ============================================
// FETCH + PROCESS ONE SOURCE
// ============================================
async function processSource(source, profile, healthMap) {
    const health = healthMap[source.id] || { fails: 0, lastSuccess: null, lastError: null, paused: false, totalRuns: 0, totalItems: 0 };

    if (health.paused) {
        return { source: source.id, skipped: true, reason: 'auto-paused after 3 fails' };
    }

    health.totalRuns = (health.totalRuns || 0) + 1;

    let feed;
    try {
        feed = await parser.parseURL(source.url);
    } catch (err) {
        health.fails = (health.fails || 0) + 1;
        health.lastError = err.message;
        if (health.fails >= 3) {
            health.paused = true;
            console.log(`[scraper] ⚠ Auto-paused ${source.name} after ${health.fails} consecutive failures`);
        }
        healthMap[source.id] = health;
        await db.ref('castingLog').push({
            timestamp: Date.now(),
            source: source.id,
            level: 'error',
            message: err.message
        });
        return { source: source.id, error: err.message };
    }

    // Reset fail counter on success
    health.fails = 0;
    health.lastSuccess = Date.now();
    health.lastError = null;

    let added = 0, filtered = 0;
    for (const item of (feed.items || []).slice(0, 50)) {
        const filterResult = passesProfileFilter(item, profile);
        if (!filterResult.pass) {
            filtered++;
            continue;
        }

        const entry = {
            title:       (item.title || '').slice(0, 200),
            link:        item.link || '',
            body:        ((item.contentSnippet || item.content || '') + '').slice(0, 2000),
            source:      source.name,
            sourceId:    source.id,
            sourceType:  source.type,
            timestamp:   item.isoDate ? new Date(item.isoDate).getTime() : Date.now(),
            scrapedAt:   Date.now(),
            seen:        false
        };

        // Dedupe by link hash
        const id = sanitizeKey(item.link || (item.title + item.isoDate));
        if (!id) continue;

        // Write to the appropriate Firebase path
        const path = source.type === 'news' ? 'news' : 'castings';
        const existing = await db.ref(`${path}/${id}`).once('value');
        if (!existing.exists()) {
            await db.ref(`${path}/${id}`).set(entry);
            added++;
        }
    }

    health.totalItems = (health.totalItems || 0) + added;
    healthMap[source.id] = health;

    return { source: source.id, added, filtered, total: feed.items?.length || 0 };
}

function sanitizeKey(str) {
    if (!str) return '';
    return String(str).replace(/[.#$\[\]\/]/g, '_').slice(0, 200);
}

// ============================================
// PRUNE OLD ENTRIES
// ============================================
async function pruneOld(profile) {
    const cutoff = Date.now() - profile.maxAgeDays * 86400000;
    let pruned = 0;
    for (const path of ['castings', 'news']) {
        const snap = await db.ref(path).once('value');
        const data = snap.val() || {};
        for (const [id, entry] of Object.entries(data)) {
            if ((entry.scrapedAt || 0) < cutoff) {
                await db.ref(`${path}/${id}`).remove();
                pruned++;
            }
        }
    }
    return pruned;
}

// ============================================
// LOAD SOURCES (DB overrides defaults)
// ============================================
async function loadSources() {
    const snap = await db.ref('castingSources').once('value');
    const stored = snap.val();
    if (!stored) {
        // First run — seed defaults to Firebase so admin panel can show them
        const seed = {};
        DEFAULT_SOURCES.forEach(s => seed[s.id] = s);
        await db.ref('castingSources').set(seed);
        return DEFAULT_SOURCES;
    }
    // Merge defaults with stored toggles
    return DEFAULT_SOURCES.map(d => Object.assign({}, d, stored[d.id] || {}));
}

// ============================================
// MAIN
// ============================================
async function run() {
    const startedAt = Date.now();
    console.log('[scraper] starting run at', new Date().toISOString());

    const [profile, sources] = await Promise.all([loadProfile(), loadSources()]);
    const healthSnap = await db.ref('castingHealth').once('value');
    const healthMap = healthSnap.val() || {};

    const enabled = sources.filter(s => s.enabled !== false);
    console.log(`[scraper] ${enabled.length} of ${sources.length} sources enabled`);

    const results = [];
    // Run in parallel batches of 5 to be polite
    for (let i = 0; i < enabled.length; i += 5) {
        const batch = enabled.slice(i, i + 5);
        const batchResults = await Promise.all(batch.map(s => processSource(s, profile, healthMap)));
        results.push(...batchResults);
    }

    // Save updated health
    await db.ref('castingHealth').set(healthMap);

    // Prune
    const prunedCount = await pruneOld(profile);

    const totalAdded = results.reduce((s, r) => s + (r.added || 0), 0);
    const totalErrors = results.filter(r => r.error).length;

    // Write run summary
    await db.ref('castingLog').push({
        timestamp: Date.now(),
        level: 'info',
        message: `Run complete: ${totalAdded} new, ${prunedCount} pruned, ${totalErrors} errors`,
        durationMs: Date.now() - startedAt
    });

    // Trim castingLog to last 100 entries
    const logSnap = await db.ref('castingLog').orderByChild('timestamp').once('value');
    const logEntries = [];
    logSnap.forEach(c => logEntries.push({ key: c.key, ts: c.val().timestamp || 0 }));
    logEntries.sort((a, b) => b.ts - a.ts);
    for (const old of logEntries.slice(100)) {
        await db.ref('castingLog/' + old.key).remove();
    }

    console.log('[scraper] done.', {
        added: totalAdded,
        errors: totalErrors,
        pruned: prunedCount,
        durationSec: ((Date.now() - startedAt) / 1000).toFixed(1)
    });

    process.exit(totalErrors > sources.length / 2 ? 1 : 0);
}

run().catch(err => {
    console.error('[scraper] fatal error:', err);
    db.ref('castingLog').push({
        timestamp: Date.now(),
        level: 'fatal',
        message: err.message,
        stack: err.stack
    }).finally(() => process.exit(1));
});