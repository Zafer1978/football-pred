// server.js — Today (TRT) with rate‑limited predictions & robust retries
// - Fetches TODAY's fixtures with timezone=Europe/Istanbul
// - Calls /predictions per fixture with a gentle rate limit to avoid quota/minute caps
// - If predictions are unavailable / rate-limited, shows fixtures with prediction="—"
// - Caches the full day; warms at 00:01 (Istanbul)
// - Subscribe + AdSense placeholders kept
//
// Tuning via env:
//   API_FOOTBALL_KEY=... (required for live data)
//   TZ=Europe/Istanbul
//   PREDICTION_CONCURRENCY=1         (how many prediction requests in parallel)
//   PREDICTION_DELAY_MS=1200         (delay between prediction requests)
//   PREDICTION_MAX=80                (hard cap to protect daily quota)
//   RETRY_429_DELAY_MS=5000          (backoff on 429)
//   DATA_DIR=/data                   (if using a Render disk)

import express from 'express';
import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';
import cron from 'node-cron';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;
const TZ = process.env.TZ || 'Europe/Istanbul';
const DATA_DIR = process.env.DATA_DIR || path.join(process.cwd(), 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

// rate limit knobs
const PREDICTION_CONCURRENCY = parseInt(process.env.PREDICTION_CONCURRENCY || '1', 10);
const PREDICTION_DELAY_MS    = parseInt(process.env.PREDICTION_DELAY_MS || '1200', 10);
const PREDICTION_MAX         = parseInt(process.env.PREDICTION_MAX || '80', 10);
const RETRY_429_DELAY_MS     = parseInt(process.env.RETRY_429_DELAY_MS || '5000', 10);

app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// ---- Helpers ----
function todayYMD(tz = TZ) {
  const fmt = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' });
  return fmt.format(new Date()); // YYYY-MM-DD
}
function toLocalISO(utcISOString, tz = TZ) {
  try {
    const dt = new Date(utcISOString);
    const parts = new Intl.DateTimeFormat('en-GB', {
      timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit'
    }).formatToParts(dt);
    const o = Object.fromEntries(parts.map(p => [p.type, p.value]));
    const [d,m,y] = [o.day,o.month,o.year];
    return `${y}-${m}-${d} ${o.hour}:${o.minute}`;
  } catch { return utcISOString; }
}
function cacheFile(dateYMD) { return path.join(DATA_DIR, `predictions-${dateYMD}.json`); }
function loadCache(dateYMD) {
  const f = cacheFile(dateYMD);
  if (fs.existsSync(f)) try { return JSON.parse(fs.readFileSync(f, 'utf-8')); } catch {}
  return null;
}
function saveCache(dateYMD, rows) {
  const f = cacheFile(dateYMD);
  fs.writeFileSync(f, JSON.stringify({ date: dateYMD, rows, savedAt: new Date().toISOString() }, null, 2));
}

// ---- HTTP helper with friendly logging/retry ----
async function fetchText(url, headers) {
  const res = await fetch(url, { headers });
  const text = await res.text();
  if (!res.ok) {
    console.warn('[api] HTTP', res.status, res.statusText, 'for', url, 'body head:', text.slice(0, 200));
    const err = new Error(`HTTP ${res.status}`);
    err.status = res.status;
    err.body = text;
    throw err;
  }
  return text;
}
async function fetchJson(url, headers) {
  const t = await fetchText(url, headers);
  try { return JSON.parse(t); }
  catch (e) {
    console.error('[api] JSON parse err for', url, 'body head:', t.slice(0, 200));
    throw e;
  }
}

// ---- API-Football source (fixtures + rate‑limited predictions) ----
async function sourceApiFootballToday(dateYMD) {
  const apiKey = process.env.API_FOOTBALL_KEY;
  if (!apiKey) return { rows: [], reason: 'no_api_key' };

  const base = 'https://v3.football.api-sports.io';
  const headersList = [
    { 'x-apisports-key': apiKey },
    { 'x-rapidapi-key': apiKey, 'x-rapidapi-host': 'v3.football.api-sports.io' }
  ];

  console.log('[api] date:', dateYMD, 'tz:', TZ);

  for (const headers of headersList) {
    try {
      const fxUrl = `${base}/fixtures?date=${dateYMD}&timezone=${encodeURIComponent(TZ)}`;
      console.log('[api] fixtures url:', fxUrl);
      const fxJson = await fetchJson(fxUrl, headers);
      const fixtures = fxJson?.response || [];
      console.log('[api] fixtures count:', fixtures.length);
      if (!fixtures.length) continue;

      // Build base rows first (no predictions yet)
      const rows = fixtures.map(f => ({
        fixtureId: f.fixture?.id,
        league: `${f.league?.country || ''} ${f.league?.name || ''}`.trim(),
        kickoff: toLocalISO(f.fixture?.date),
        home: f.teams?.home?.name || 'Home',
        away: f.teams?.away?.name || 'Away',
        prediction: '—',
        confidence: ''
      }));

      // Prepare a prediction queue with rate limiting
      let done = 0, inFlight = 0, idx = 0, used = 0;
      const total = rows.length;
      const next = () => rows[idx++];

      async function runOne(r) {
        if (!r || !r.fixtureId) return;
        if (used >= PREDICTION_MAX) return; // protect quota
        used += 1;

        const pUrl = `${base}/predictions?fixture=${r.fixtureId}`;
        try {
          const pJson = await fetchJson(pUrl, headers);
          const pred = pJson?.response?.[0];
          if (pred?.predictions?.winner?.name) {
            const w = pred.predictions.winner.name;
            if (/home/i.test(w)) r.prediction = '1';
            else if (/away/i.test(w)) r.prediction = '2';
            else if (/draw/i.test(w)) r.prediction = 'X';
            else r.prediction = w;
          }
          if (pred?.predictions?.percent) {
            const { home: ph, draw: pd, away: pa } = pred.predictions.percent;
            const nums = [ph, pd, pa].map(x => parseFloat(String(x).replace('%','')) || 0);
            const max = Math.max(...nums);
            r.confidence = `${max}%`;
          }
        } catch (e) {
          if (e.status === 429) {
            console.warn('[api] 429 rate-limited; backing off', RETRY_429_DELAY_MS, 'ms');
            await new Promise(r => setTimeout(r, RETRY_429_DELAY_MS));
            // try once more
            try {
              const pJson = await fetchJson(pUrl, headers);
              const pred = pJson?.response?.[0];
              if (pred?.predictions?.winner?.name) {
                const w = pred.predictions.winner.name;
                if (/home/i.test(w)) r.prediction = '1';
                else if (/away/i.test(w)) r.prediction = '2';
                else if (/draw/i.test(w)) r.prediction = 'X';
                else r.prediction = w;
              }
              if (pred?.predictions?.percent) {
                const { home: ph, draw: pd, away: pa } = pred.predictions.percent;
                const nums = [ph, pd, pa].map(x => parseFloat(String(x).replace('%','')) || 0);
                const max = Math.max(...nums);
                r.confidence = `${max}%`;
              }
            } catch (e2) {
              console.warn('[api] predictions still unavailable after backoff:', e2.message);
            }
          } else {
            console.warn('[api] predictions skipped for fixture', r.fixtureId, '-', e.message);
          }
        } finally {
          done += 1;
        }
      }

      async function scheduler() {
        return new Promise(resolve => {
          const tick = async () => {
            // launch up to concurrency
            while (inFlight < PREDICTION_CONCURRENCY) {
              const r = next();
              if (!r) break;
              inFlight += 1;
              runOne(r).finally(() => { inFlight -= 1; });
              await new Promise(r => setTimeout(r, PREDICTION_DELAY_MS));
            }
            if (done >= Math.min(total, PREDICTION_MAX)) return resolve();
            setTimeout(tick, 250);
          };
          tick();
        });
      }

      await scheduler();
      console.log('[api] predictions attempted:', Math.min(total, PREDICTION_MAX));

      // Return without fixtureId in final payload
      return { rows: rows.map(({fixtureId, ...rest}) => rest), reason: 'ok' };
    } catch (e) {
      console.warn('[api] header mode failed - trying next:', e.message);
    }
  }
  return { rows: [], reason: 'api_error_or_no_plan' };
}

// ---- Collect + cache ----
async function collectToday(dateYMD) {
  const api = await sourceApiFootballToday(dateYMD);
  let rows = api.rows;
  rows.sort((x,y) => (x.kickoff||'').localeCompare(y.kickoff||'') || (x.league||'').localeCompare(y.league||'') || (x.home||'').localeCompare(y.home||''));
  return rows;
}

async function warm(dateYMD) {
  const rows = await collectToday(dateYMD);
  saveCache(dateYMD, rows);
  console.log(`[warm] cached ${rows.length} rows for ${dateYMD}`);
  return rows;
}

(async () => {
  const d = todayYMD();
  await warm(d);
})();

cron.schedule('1 0 * * *', async () => {
  const d = todayYMD();
  await warm(d);
}, { timezone: TZ });

// ---- Routes ----
app.get('/healthz', (_req, res) => res.json({ ok: true }));

app.get('/api/today', async (_req, res) => {
  const d = todayYMD();
  const cached = loadCache(d);
  if (cached) return res.json(cached);
  const rows = await warm(d);
  res.json({ date: d, rows, savedAt: new Date().toISOString() });
});

// ---- Frontend ----
const INDEX_HTML = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Today’s Football Predictions</title>
  <meta name="description" content="Broadcast of daily football match predictions." />
  <script src="https://cdn.tailwindcss.com"></script>
  <!-- AdSense placeholder (paste your real code when approved) -->
  <!--
  <script async src="https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=YOUR-ADSENSE-CLIENT" crossorigin="anonymous"></script>
  -->
  <style> thead.sticky th{ position: sticky; top:0; z-index: 10; box-shadow: 0 1px 0 rgba(0,0,0,.05); } </style>
</head>
<body class="bg-slate-50 text-slate-900">
  <div class="max-w-7xl mx-auto p-4">
    <header class="mb-6 flex items-center justify-between">
      <div>
        <h1 class="text-3xl font-extrabold tracking-tight">Predictions for <span id="dateLabel">—</span></h1>
        <p class="text-sm text-slate-600">Auto-updates daily at 00:01 (Istanbul time). Informational only.</p>
      </div>
      <a href="#subscribe" class="rounded-xl px-3 py-2 text-sm border hover:bg-slate-100">Subscribe</a>
    </header>

    <div class="overflow-x-auto bg-white rounded-2xl shadow">
      <table class="min-w-full text-sm" id="tbl">
        <thead class="bg-slate-100 sticky"><tr>
          <th class="text-left p-3">Kickoff</th>
          <th class="text-left p-3">League</th>
          <th class="text-left p-3">Home</th>
          <th class="text-left p-3">Away</th>
          <th class="text-left p-3">Pick (1/X/2)</th>
          <th class="text-left p-3">Confidence</th>
        </tr></thead>
        <tbody id="rows"></tbody>
      </table>
    </div>

    <section id="subscribe" class="mt-6 bg-sky-600 text-white rounded-2xl shadow p-6">
      <h2 class="text-xl font-semibold mb-2">Get daily predictions by email</h2>
      <form id="subForm" class="flex flex-col sm:flex-row gap-3" method="post" action="/subscribe">
        <input type="email" name="email" required placeholder="you@example.com" class="flex-1 rounded-xl px-4 py-2 text-slate-900" />
        <input type="text" name="company" class="hidden" tabindex="-1" autocomplete="off" />
        <button class="rounded-xl px-4 py-2 bg-white text-blue-700 font-semibold hover:bg-slate-100" type="submit">Subscribe</button>
      </form>
      <p id="subMsg" class="mt-2 text-sm"></p>
    </section>

    <footer class="mt-8 text-xs text-slate-500 text-center"><p>Respect providers’ terms.</p></footer>
  </div>

  <script>
    const rowsEl = document.getElementById('rows');
    const subForm = document.getElementById('subForm');
    const subMsg = document.getElementById('subMsg');
    const dateLabel = document.getElementById('dateLabel');

    async function load() {
      const res = await fetch('/api/today');
      const data = await res.json();
      const rows = data.rows || [];
      if (dateLabel && data.date) dateLabel.textContent = data.date;

      rowsEl.innerHTML = rows.map(r => \`
        <tr class="border-b last:border-0">
          <td class="p-3 whitespace-nowrap">\${r.kickoff||''}</td>
          <td class="p-3">\${r.league||''}</td>
          <td class="p-3 font-medium">\${r.home||''}</td>
          <td class="p-3">\${r.away||''}</td>
          <td class="p-3">\${r.prediction||''}</td>
          <td class="p-3">\${r.confidence||''}</td>
        </tr>\`
      ).join('');
    }
    load();
    setInterval(load, 10 * 60 * 1000);

    subForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const fd = new FormData(subForm);
      const resp = await fetch('/subscribe', { method: 'POST', body: fd });
      try { const r = await resp.json(); subMsg.textContent = r.message || 'Subscribed!'; }
      catch { subMsg.textContent = 'Subscribed!'; }
    });
  </script>
</body>
</html>`);

// ---- Routes ----
app.get('/', (_req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(INDEX_HTML);
});

app.post('/subscribe', (req, res) => {
  if (req.body && req.body.company) return res.json({ ok: true, message: 'Thanks!' }); // honeypot
  const email = (req.body?.email || '').toString().trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ ok:false, message:'Invalid email' });
  try {
    const file = path.join(DATA_DIR, 'subscribers.csv');
    if (!fs.existsSync(file)) fs.writeFileSync(file, 'email,ts\n');
    fs.appendFileSync(file, `${email},${new Date().toISOString()}\n`);
  } catch (e) {
    return res.status(500).json({ ok:false, message:'Could not save subscription' });
  }
  res.json({ ok:true, message:'Check your inbox to confirm (simulated).' });
});

app.listen(PORT, () => {
  console.log(`✅ Server listening on ${PORT}`);
});
