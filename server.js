// server.js — Today (TRT) live fixtures + rate‑limited predictions + diagnostics
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

const PREDICTION_CONCURRENCY = parseInt(process.env.PREDICTION_CONCURRENCY || '1', 10);
const PREDICTION_DELAY_MS    = parseInt(process.env.PREDICTION_DELAY_MS || '1200', 10);
const PREDICTION_MAX         = parseInt(process.env.PREDICTION_MAX || '80', 10);
const RETRY_429_DELAY_MS     = parseInt(process.env.RETRY_429_DELAY_MS || '5000', 10);
const FALLBACK_SIMPLE        = process.env.FALLBACK_SIMPLE === '1';
const DEBUG                  = process.env.DEBUG === '1';

app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.disable('x-powered-by');

function todayYMD(tz = TZ) {
  const fmt = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' });
  return fmt.format(new Date());
}
function toLocalISO(utcISOString, tz = TZ) {
  try {
    const dt = new Date(utcISOString);
    const parts = new Intl.DateTimeFormat('en-GB', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).formatToParts(dt);
    const o = Object.fromEntries(parts.map(p => [p.type, p.value]));
    return o.year + '-' + o.month + '-' + o.day + ' ' + o.hour + ':' + o.minute;
  } catch { return utcISOString; }
}
function cacheFile(dateYMD) { return path.join(DATA_DIR, 'predictions-' + dateYMD + '.json'); }
function loadCache(dateYMD) {
  const f = cacheFile(dateYMD);
  if (fs.existsSync(f)) { try { return JSON.parse(fs.readFileSync(f, 'utf-8')); } catch {} }
  return null;
}
function saveCache(dateYMD, rows) {
  const f = cacheFile(dateYMD);
  fs.writeFileSync(f, JSON.stringify({ date: dateYMD, rows, savedAt: new Date().toISOString() }, null, 2));
}

async function fetchText(url, headers) {
  const res = await fetch(url, { headers });
  const text = await res.text();
  if (!res.ok) {
    if (DEBUG) console.warn('[api] HTTP', res.status, res.statusText, 'for', url, 'body head:', text.slice(0, 200));
    const err = new Error('HTTP ' + res.status);
    err.status = res.status;
    err.body = text;
    throw err;
  }
  return text;
}
async function fetchJson(url, headers) { return JSON.parse(await fetchText(url, headers)); }

async function sourceApiFootballToday(dateYMD) {
  const apiKey = process.env.API_FOOTBALL_KEY;
  if (!apiKey) return { rows: [], reason: 'no_api_key' };

  const base = 'https://v3.football.api-sports.io';
  const headersList = [
    { 'x-apisports-key': apiKey },
    { 'x-rapidapi-key': apiKey, 'x-rapidapi-host': 'v3.football.api-sports.io' }
  ];

  let lastStatus = null;

  for (const headers of headersList) {
    try {
      const fxUrl = base + '/fixtures?date=' + dateYMD + '&timezone=' + encodeURIComponent(TZ);
      if (DEBUG) console.log('[api] fixtures url:', fxUrl);
      const fxJson = await fetchJson(fxUrl, headers);
      const fixtures = (fxJson && fxJson.response) ? fxJson.response : [];
      if (DEBUG) console.log('[api] fixtures count:', fixtures.length);
      if (!fixtures.length) continue;

      const rows = fixtures.map(f => ({
        fixtureId: f.fixture && f.fixture.id,
        league: ((f.league && (f.league.country || '')) + ' ' + (f.league && (f.league.name || ''))).trim(),
        kickoff: toLocalISO(f.fixture && f.fixture.date),
        home: (f.teams && f.teams.home && f.teams.home.name) || 'Home',
        away: (f.teams && f.teams.away && f.teams.away.name) || 'Away',
        prediction: '—',
        confidence: ''
      }));

      let done = 0, inFlight = 0, idx = 0, used = 0;
      const total = rows.length;
      const next = () => rows[idx++];

      async function runOne(r) {
        if (!r || !r.fixtureId) return;
        if (used >= PREDICTION_MAX) return;
        used += 1;

        const pUrl = base + '/predictions?fixture=' + r.fixtureId;
        try {
          const pRes = await fetch(pUrl, { headers });
          lastStatus = pRes.status;
          const pText = await pRes.text();
          if (pRes.ok) {
            const pJson = JSON.parse(pText);
            const pred = pJson && pJson.response && pJson.response[0];
            if (pred && pred.predictions && pred.predictions.winner && pred.predictions.winner.name) {
              const w = pred.predictions.winner.name;
              if (/home/i.test(w)) r.prediction = '1';
              else if (/away/i.test(w)) r.prediction = '2';
              else if (/draw/i.test(w)) r.prediction = 'X';
              else r.prediction = w;
            }
            if (pred && pred.predictions && pred.predictions.percent) {
              const ph = pred.predictions.percent.home;
              const pd = pred.predictions.percent.draw;
              const pa = pred.predictions.percent.away;
              const nums = [ph, pd, pa].map(x => parseFloat(String(x).replace('%','')) || 0);
              const max = Math.max.apply(null, nums);
              r.confidence = String(max) + '%';
            }
          } else if (pRes.status === 429) {
            if (DEBUG) console.warn('[api] 429 rate-limited; backoff', RETRY_429_DELAY_MS, 'ms');
            await new Promise(rz => setTimeout(rz, RETRY_429_DELAY_MS));
            try {
              const pRes2 = await fetch(pUrl, { headers });
              lastStatus = pRes2.status;
              if (pRes2.ok) {
                const pJson2 = JSON.parse(await pRes2.text());
                const pred2 = pJson2 && pJson2.response && pJson2.response[0];
                if (pred2 && pred2.predictions && pred2.predictions.winner && pred2.predictions.winner.name) {
                  const w2 = pred2.predictions.winner.name;
                  if (/home/i.test(w2)) r.prediction = '1';
                  else if (/away/i.test(w2)) r.prediction = '2';
                  else if (/draw/i.test(w2)) r.prediction = 'X';
                  else r.prediction = w2;
                }
                if (pred2 && pred2.predictions && pred2.predictions.percent) {
                  const ph2 = pred2.predictions.percent.home;
                  const pd2 = pred2.predictions.percent.draw;
                  const pa2 = pred2.predictions.percent.away;
                  const nums2 = [ph2, pd2, pa2].map(x => parseFloat(String(x).replace('%','')) || 0);
                  const max2 = Math.max.apply(null, nums2);
                  r.confidence = String(max2) + '%';
                }
              }
            } catch {}
          } else {
            if (DEBUG) console.warn('[api] predictions HTTP', pRes.status, 'skipping fixture', r.fixtureId);
          }
        } catch (e) {
          if (DEBUG) console.warn('[api] predictions error for', r.fixtureId, e.message);
        } finally {
          done += 1;
        }
      }

      async function scheduler() {
        return new Promise(resolve => {
          const tick = async () => {
            while (inFlight < PREDICTION_CONCURRENCY) {
              const r = next();
              if (!r) break;
              inFlight += 1;
              runOne(r).finally(() => { inFlight -= 1; });
              await new Promise(rz => setTimeout(rz, PREDICTION_DELAY_MS));
            }
            if (done >= Math.min(total, PREDICTION_MAX)) return resolve();
            setTimeout(tick, 250);
          };
          tick();
        });
      }

      await scheduler();

      if (FALLBACK_SIMPLE) {
        let filled = 0;
        for (const r of rows) {
          if ((r.prediction === '—' || !r.prediction) && r.home && r.away) {
            r.prediction = '1';
            r.confidence = '52%';
            filled++;
          }
        }
        if (DEBUG) console.log('[api] fallback filled rows:', filled);
      }

      return { rows: rows.map(({fixtureId, ...rest}) => rest), reason: 'ok', lastStatus };
    } catch (e) {
      if (DEBUG) console.warn('[api] header mode failed, trying next:', e.message);
    }
  }
  return { rows: [], reason: 'api_error_or_no_plan', lastStatus };
}

async function collectToday(dateYMD) {
  const api = await sourceApiFootballToday(dateYMD);
  let rows = api.rows;
  rows.sort((x,y) => (x.kickoff||'').localeCompare(y.kickoff||'') || (x.league||'').localeCompare(y.league||'') || (x.home||'').localeCompare(y.home||''));
  return rows;
}
async function warm(dateYMD) {
  const rows = await collectToday(dateYMD);
  saveCache(dateYMD, rows);
  if (DEBUG) console.log('[warm] cached', rows.length, 'rows for', dateYMD);
  return rows;
}

(async () => { await warm(todayYMD()); })();
cron.schedule('1 0 * * *', async () => { await warm(todayYMD()); }, { timezone: TZ });

app.get('/api/today', async (_req, res) => {
  const d = todayYMD();
  const cached = loadCache(d);
  if (cached) return res.json(cached);
  const rows = await warm(d);
  res.json({ date: d, rows, savedAt: new Date().toISOString() });
});

app.get('/diag', async (_req, res) => {
  const apiKeySet = !!process.env.API_FOOTBALL_KEY;
  const date = todayYMD();
  const tz = TZ;
  const base = 'https://v3.football.api-sports.io';
  const headers = { 'x-apisports-key': process.env.API_FOOTBALL_KEY || '' };
  let fixturesCount = -1, firstFixtureId = null, predStatus = null, predBody = null, err = null;
  try {
    const fx = await fetch(base + '/fixtures?date=' + date + '&timezone=' + encodeURIComponent(tz), { headers });
    const fxText = await fx.text();
    const fxJson = JSON.parse(fxText);
    fixturesCount = (fxJson && fxJson.response) ? fxJson.response.length : 0;
    if (fixturesCount > 0) firstFixtureId = fxJson.response[0]?.fixture?.id || null;
    if (firstFixtureId) {
      const p = await fetch(base + '/predictions?fixture=' + firstFixtureId, { headers });
      predStatus = p.status;
      predBody = (await p.text()).slice(0, 400);
    }
  } catch (e) { err = String(e.message || e); }
  res.json({ apiKeySet, date, tz, fixturesCount, firstFixtureId, predStatus, predBodyHead: predBody, err });
});

const INDEX_HTML =
  '<!doctype html>\n' +
  '<html lang="en">\n' +
  '<head>\n' +
  '  <meta charset="utf-8" />\n' +
  '  <meta name="viewport" content="width=device-width, initial-scale=1" />\n' +
  '  <title>Today\' + 's Football Predictions</title>\n' +
  '  <meta name="description" content="Broadcast of daily football match predictions." />\n' +
  '  <script src="https://cdn.tailwindcss.com"></script>\n' +
  '  <!-- Paste your AdSense script here after approval -->\n' +
  '</head>\n' +
  '<body class="bg-slate-50 text-slate-900">\n' +
  '  <div class="max-w-7xl mx-auto p-4">\n' +
  '    <header class="mb-6 flex items-center justify-between">\n' +
  '      <div>\n' +
  '        <h1 class="text-3xl font-extrabold tracking-tight">Predictions for <span id="dateLabel">—</span></h1>\n' +
  '        <p class="text-sm text-slate-600">Auto-updates daily at 00:01 (Istanbul time). Informational only.</p>\n' +
  '      </div>\n' +
  '      <a href="#subscribe" class="rounded-xl px-3 py-2 text-sm border hover:bg-slate-100">Subscribe</a>\n' +
  '    </header>\n' +
  '    <div class="overflow-x-auto bg-white rounded-2xl shadow">\n' +
  '      <table class="min-w-full text-sm" id="tbl">\n' +
  '        <thead class="bg-slate-100 sticky"><tr>\n' +
  '          <th class="text-left p-3">Kickoff</th>\n' +
  '          <th class="text-left p-3">League</th>\n' +
  '          <th class="text-left p-3">Home</th>\n' +
  '          <th class="text-left p-3">Away</th>\n' +
  '          <th class="text-left p-3">Pick (1/X/2)</th>\n' +
  '          <th class="text-left p-3">Confidence</th>\n' +
  '        </tr></thead>\n' +
  '        <tbody id="rows"></tbody>\n' +
  '      </table>\n' +
  '    </div>\n' +
  '    <section id="subscribe" class="mt-6 bg-sky-600 text-white rounded-2xl shadow p-6">\n' +
  '      <h2 class="text-xl font-semibold mb-2">Get daily predictions by email</h2>\n' +
  '      <form id="subForm" class="flex flex-col sm:flex-row gap-3" method="post" action="/subscribe">\n' +
  '        <input type="email" name="email" required placeholder="you@example.com" class="flex-1 rounded-xl px-4 py-2 text-slate-900" />\n' +
  '        <input type="text" name="company" class="hidden" tabindex="-1" autocomplete="off" />\n' +
  '        <button class="rounded-xl px-4 py-2 bg-white text-blue-700 font-semibold hover:bg-slate-100" type="submit">Subscribe</button>\n' +
  '      </form>\n' +
  '      <p id="subMsg" class="mt-2 text-sm"></p>\n' +
  '    </section>\n' +
  '    <footer class="mt-8 text-xs text-slate-500 text-center"><p>Respect providers’ terms.</p></footer>\n' +
  '  </div>\n' +
  '  <script>\n' +
  '    const rowsEl = document.getElementById("rows");\n' +
  '    const subForm = document.getElementById("subForm");\n' +
  '    const subMsg = document.getElementById("subMsg");\n' +
  '    const dateLabel = document.getElementById("dateLabel");\n' +
  '    async function load() {\n' +
  '      const res = await fetch("/api/today");\n' +
  '      const data = await res.json();\n' +
  '      const rows = data.rows || [];\n' +
  '      if (dateLabel && data.date) dateLabel.textContent = data.date;\n' +
  '      rowsEl.innerHTML = rows.map(function(r){\n' +
  '        return "<tr class=\\\"border-b last:border-0\\\">" +\n' +
  '               "<td class=\\\"p-3 whitespace-nowrap\\\">" + (r.kickoff||"") + "</td>" +\n' +
  '               "<td class=\\\"p-3\\\">" + (r.league||"") + "</td>" +\n' +
  '               "<td class=\\\"p-3 font-medium\\\">" + (r.home||"") + "</td>" +\n' +
  '               "<td class=\\\"p-3\\\">" + (r.away||"") + "</td>" +\n' +
  '               "<td class=\\\"p-3\\\">" + (r.prediction||"") + "</td>" +\n' +
  '               "<td class=\\\"p-3\\\">" + (r.confidence||"") + "</td>" +\n' +
  '               "</tr>";\n' +
  '      }).join("");\n' +
  '    }\n' +
  '    load();\n' +
  '    setInterval(load, 10 * 60 * 1000);\n' +
  '    subForm.addEventListener("submit", async function(e){\n' +
  '      e.preventDefault();\n' +
  '      const fd = new FormData(subForm);\n' +
  '      const resp = await fetch("/subscribe", { method: "POST", body: fd });\n' +
  '      try { const r = await resp.json(); subMsg.textContent = r.message || "Subscribed!"; }\n' +
  '      catch { subMsg.textContent = "Subscribed!"; }\n' +
  '    });\n' +
  '  </script>\n' +
  '</body>\n' +
  '</html>';

app.get('/', (_req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(INDEX_HTML);
});

app.post('/subscribe', (req, res) => {
  if (req.body && req.body.company) return res.json({ ok: true, message: 'Thanks!' });
  const email = (req.body?.email || '').toString().trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ ok:false, message:'Invalid email' });
  try {
    const file = path.join(DATA_DIR, 'subscribers.csv');
    if (!fs.existsSync(file)) fs.writeFileSync(file, 'email,ts\n');
    fs.appendFileSync(file, email + ',' + new Date().toISOString() + '\n');
  } catch (e) { return res.status(500).json({ ok:false, message:'Could not save subscription' }); }
  res.json({ ok:true, message:'Check your inbox to confirm (simulated).' });
});

async function boot() {
  const d = todayYMD();
  await warm(d);
  app.listen(PORT, () => { console.log('✅ Server listening on', PORT); });
}
boot();
