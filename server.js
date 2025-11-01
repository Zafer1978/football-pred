// server.js — AI Picks v4
// Strategy:
// 1) Compute 1X2 probabilities from expected goals (Poisson).
// 2) If 1X2 edge is weak (best < 58%), prefer a goals market:
//    a) Pick Over/Under 2.5 if max(prob) >= 60%
//    b) Else pick BTTS (Yes/No) if max(prob) >= 58%
//    c) Else fall back to best 1X2
// Form source = last 5 *league* matches only (same competition as fixture).

import express from 'express';
import dotenv from 'dotenv';
import cron from 'node-cron';

dotenv.config();

const app = express();
const PORT = parseInt(process.env.PORT || '3000', 10);
const HOST = '0.0.0.0';
const TZ = process.env.TZ || 'Europe/Istanbul';
const API_KEY = process.env.FOOTBALL_DATA_KEY || '';
const START_HOUR = parseInt(process.env.START_HOUR || '11', 10);
const END_HOUR = 24;
const FALLBACK_DEMO = process.env.FALLBACK_DEMO === '1';

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.disable('x-powered-by');

// ---- Helpers: time
function fmtYMD(d, tz = TZ) {
  const f = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' });
  return f.format(d);
}
function todayYMD(tz = TZ) { return fmtYMD(new Date(), tz); }
function localParts(iso, tz = TZ) {
  const dt = new Date(iso);
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false
  }).formatToParts(dt);
  const o = Object.fromEntries(parts.map(p => [p.type, p.value]));
  return { y: +o.year, m: +o.month, d: +o.day, hh: +o.hour, mm: +o.minute };
}
function toLocalLabel(iso, tz = TZ) {
  const { y, m, d, hh, mm } = localParts(iso, tz);
  const pad = n => String(n).padStart(2, '0');
  return `${y}-${pad(m)}-${pad(d)} ${pad(hh)}:${pad(mm)}`;
}
function normTeam(s=''){ return s.toLowerCase().replace(/[^a-z0-9]+/g,' ').trim(); }

// ---- seed strengths (Elo-like). Unlisted default to 1500.
const SEED_ELO = {
  'real madrid':1850,'barcelona':1820,'manchester city':1880,'liverpool':1820,'arsenal':1800,
  'chelsea':1750,'manchester united':1760,'bayern munich':1900,'inter':1820,'juventus':1800,
  'milan':1780,'psg':1850,'atletico madrid':1800,'napoli':1780,'roma':1740,'tottenham':1760,
  'galatasaray':1700,'fenerbahce':1680,'besiktas':1650,'trabzonspor':1620
};

// ---- league baseline goals per match (heuristic)
function leagueBaseGpm(league=''){
  const k = (league||'').toLowerCase();
  if (k.includes('super lig') || k.includes('süper lig')) return 2.7;
  if (k.includes('premier')) return 2.9;
  if (k.includes('la liga')) return 2.6;
  if (k.includes('bundesliga')) return 3.1;
  if (k.includes('serie a')) return 2.5;
  if (k.includes('ligue 1')) return 2.7;
  if (k.includes('eredivisie')) return 3.0;
  if (k.includes('primeira')) return 2.5;
  return 2.65;
}

// ---- fetch helper
const H = { 'X-Auth-Token': API_KEY, 'accept': 'application/json' };
async function getJson(url){
  const res = await fetch(url, { headers: H });
  const txt = await res.text();
  try { return JSON.parse(txt); } catch { return { raw: txt }; }
}

// ---- standings cache (competitionId -> Map(teamId -> position))
const standingsCache = new Map();
async function getStandingsMap(compId){
  if (standingsCache.has(compId)) return standingsCache.get(compId);
  try {
    const j = await getJson(`https://api.football-data.org/v4/competitions/${compId}/standings`);
    const table = (j?.standings||[]).find(s => s.type === 'TOTAL')?.table || [];
    const map = new Map();
    for (const row of table) {
      if (row.team?.id) map.set(row.team.id, row.position || 0);
    }
    standingsCache.set(compId, map);
    return map;
  } catch { return new Map(); }
}

// ---- last 5 *league* matches (filter by same competition id)
const formCache = new Map(); // key `${teamId}:${compId}`
async function getLastLeagueMatches(teamId, compId){
  const key = `${teamId}:${compId}`;
  if (formCache.has(key)) return formCache.get(key);
  const end = new Date();
  const start = new Date(end.getTime() - 60*24*3600*1000);
  const dateFrom = start.toISOString().slice(0,10);
  const dateTo = end.toISOString().slice(0,10);
  const url = `https://api.football-data.org/v4/teams/${teamId}/matches?status=FINISHED&dateFrom=${dateFrom}&dateTo=${dateTo}`;
  const j = await getJson(url);
  let arr = Array.isArray(j?.matches) ? j.matches : [];
  // Only same competition to avoid cups skewing
  arr = arr.filter(m => m.competition?.id === compId);
  arr.sort((a,b)=> (b.utcDate||'').localeCompare(a.utcDate||''));
  const last5 = arr.slice(0,5);
  formCache.set(key, last5);
  return last5;
}

// ---- form stats
function formStats(teamId, matches, standingsMap){
  let pts=0, gf=0, ga=0, homeGF=0, homeGA=0, awayGF=0, awayGA=0, oppPosSum=0, oppCount=0;
  for (const m of matches){
    const isHome = m.homeTeam?.id === teamId;
    const ts = m.score?.fullTime || m.score?.regularTime || {};
    const h = ts.home ?? 0, a = ts.away ?? 0;
    const forGoals = isHome ? h : a;
    const agGoals = isHome ? a : h;
    gf += forGoals; ga += agGoals;
    if (isHome) { homeGF += h; homeGA += a; } else { awayGF += a; awayGA += h; }
    if (forGoals > agGoals) pts += 3; else if (forGoals === agGoals) pts += 1;
    const oppId = isHome ? m.awayTeam?.id : m.homeTeam?.id;
    if (oppId && standingsMap?.has(oppId)) { oppPosSum += standingsMap.get(oppId); oppCount += 1; }
  }
  const gPlayed = matches.length || 1;
  const ppm = pts / gPlayed;
  const gfpm = gf / gPlayed, gapm = ga / gPlayed;
  const homeGP = matches.filter(m => m.homeTeam?.id === teamId).length || 1;
  const awayGP = gPlayed - homeGP || 1;
  const homeGFpm = homeGF / homeGP, homeGApm = homeGA / homeGP;
  const awayGFpm = awayGF / awayGP, awayGApm = awayGA / awayGP;
  const oppAvgPos = oppCount ? (oppPosSum / oppCount) : 10;
  return { ppm, gfpm, gapm, homeGFpm, homeGApm, awayGFpm, awayGApm, oppAvgPos, gPlayed };
}

// ---- Poisson helpers
function fac(n){ let r=1; for(let i=2;i<=n;i++) r*=i; return r; }
function poisPmf(lam, k){ return Math.exp(-lam) * Math.pow(lam, k) / fac(k); }
function poisCdf(lam, k){ let s=0; for(let i=0;i<=k;i++) s += poisPmf(lam,i); return s; }
function probs1X2(lh, la, cap=12){
  let pH=0, pD=0, pA=0;
  for(let i=0;i<=cap;i++){
    const ph = poisPmf(lh, i);
    for(let j=0;j<=cap;j++){
      const pa = poisPmf(la, j);
      if (i>j) pH += ph*pa; else if (i===j) pD += ph*pa; else pA += ph*pa;
    }
  }
  const s = pH+pD+pA || 1; return { pH: pH/s, pD: pD/s, pA: pA/s };
}

// ---- expected goals: league base + seeds + form + small home edge
function expectedGoalsAdvanced(homeName, awayName, leagueName, homeForm, awayForm){
  const baseG = leagueBaseGpm(leagueName);
  const HOME_ELO = 55;
  const rh = SEED_ELO[normTeam(homeName)] ?? 1500;
  const ra = SEED_ELO[normTeam(awayName)] ?? 1500;
  const seedDiff = (rh + HOME_ELO) - ra;

  const posFactor = pos => Math.max(0.8, Math.min(1.2, 1 + (10 - pos)*0.02));
  const homeOpp = posFactor(homeForm.oppAvgPos);
  const awayOpp = posFactor(awayForm.oppAvgPos);

  const homeAtk = 0.6*homeForm.homeGFpm + 0.4*homeForm.gfpm;
  const awayAtk = 0.6*awayForm.awayGFpm + 0.4*awayForm.gfpm;
  const homeDef = 0.6*homeForm.homeGApm + 0.4*homeForm.gapm;
  const awayDef = 0.6*awayForm.awayGApm + 0.4*awayForm.gapm;

  let split = 0.5 + 0.12*Math.tanh(seedDiff/650);
  const atkBias = (homeAtk/(homeDef+0.1)) / ((awayAtk/(awayDef+0.1))+0.01);
  split = Math.max(0.36, Math.min(0.64, split * Math.pow(atkBias, 0.12)));

  let lh = baseG * split * (1 + seedDiff/2200) * homeOpp * (homeAtk+0.8)/(awayDef+0.8);
  let la = baseG * (1 - split) * (1 - seedDiff/2200) * awayOpp * (awayAtk+0.8)/(homeDef+0.8);
  lh = Math.max(0.15, Math.min(3.0, lh));
  la = Math.max(0.15, Math.min(3.0, la));
  return { lh, la };
}

// ---- decision: prioritize totals if 1X2 risky
function decidePick(lh, la){
  const { pH, pD, pA } = probs1X2(lh, la);
  const best1x2 = [{label:'1',p:pH},{label:'X',p:pD},{label:'2',p:pA}].sort((a,b)=>b.p-a.p)[0];

  const totLam = lh + la;
  const pU25 = poisCdf(totLam, 2);
  const pO25 = 1 - pU25;

  const pBTTS = 1 - (Math.exp(-lh) + Math.exp(-la) - Math.exp(-lh-la));
  const bestBTTS = pBTTS >= 0.5 ? { market:'BTTS', label:'Yes', prob:pBTTS } : { market:'BTTS', label:'No', prob:1-pBTTS };

  // thresholds
  const oneX2Risky = best1x2.p < 0.58;
  if (oneX2Risky) {
    const bestTotals = pO25 >= pU25
      ? { market:'Over/Under 2.5', label:'Over 2.5', prob:pO25 }
      : { market:'Over/Under 2.5', label:'Under 2.5', prob:pU25 };
    if (bestTotals.prob >= 0.60) return bestTotals;
    if (bestBTTS.prob >= 0.58) return bestBTTS;
  }
  return { market:'1X2', label:best1x2.label, prob:best1x2.p };
}

// ---- fixtures → enrich → predict
async function fetchFixturesToday(){
  const date = todayYMD();
  if (!API_KEY) return { date, rows: [], reason: 'missing_api_key' };

  const now = new Date();
  const startUtc = now.toISOString().split('T')[0];
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));
  const endUtc = end.toISOString().split('T')[0];
  const url = `https://api.football-data.org/v4/matches?dateFrom=${startUtc}&dateTo=${endUtc}&status=SCHEDULED,IN_PLAY,PAUSED,FINISHED`;
  const j = await getJson(url);
  const arr = Array.isArray(j?.matches) ? j.matches : [];

  const rows = [];
  for (const f of arr){
    const league = `${f.competition?.area?.name || ''} ${f.competition?.name || ''}`.trim();
    const compId = f.competition?.id;
    const kickoffIso = f.utcDate;
    const hourLocal = localParts(kickoffIso).hh;
    if (!(hourLocal >= START_HOUR && hourLocal < END_HOUR)) continue;

    const homeName = f.homeTeam?.name || '';
    const awayName = f.awayTeam?.name || '';
    const homeId = f.homeTeam?.id;
    const awayId = f.awayTeam?.id;

    let pred = { market:'1X2', label:'1', prob:0.4 };
    try {
      const standings = compId ? await getStandingsMap(compId) : new Map();
      const homeMatches = homeId ? await getLastLeagueMatches(homeId, compId) : [];
      const awayMatches = awayId ? await getLastLeagueMatches(awayId, compId) : [];

      const homeForm = formStats(homeId, homeMatches, standings);
      const awayForm = formStats(awayId, awayMatches, standings);
      const { lh, la } = expectedGoalsAdvanced(homeName, awayName, league, homeForm, awayForm);
      pred = decidePick(lh, la);
    } catch (e) {
      // keep default pred
    }

    rows.push({
      league, kickoffIso, kickoff: toLocalLabel(kickoffIso),
      hourLocal, home: homeName, away: awayName,
      prediction: `${pred.market}: ${pred.label} (${Math.round(pred.prob*100)}%)`
    });
  }

  rows.sort((a,b)=> (a.kickoff||'').localeCompare(b.kickoff||''));
  if (!rows.length && FALLBACK_DEMO) {
    rows.push({
      league: 'Demo League', kickoff: `${date} 19:00`,
      hourLocal: 19, home: 'Alpha FC', away: 'Beta United',
      prediction: 'Over/Under 2.5: Over 2.5 (62%)'
    });
  }
  return { date, rows, totalFromApi: arr.length, apiUrl: url };
}

// ---- cache & schedule
let CACHE = { date: null, rows: [], savedAt: null };
async function warmCache() {
  try {
    const res = await fetchFixturesToday();
    CACHE = { ...res, savedAt: new Date().toISOString() };
  } catch (e) {
    CACHE = { date: todayYMD(), rows: [], savedAt: new Date().toISOString(), error: String(e.message || e) };
  }
}
cron.schedule('1 0 * * *', async () => { await warmCache(); }, { timezone: TZ });

// ---- routes
app.get('/api/today', async (_req, res) => {
  const nowDate = todayYMD();
  if (CACHE.date !== nowDate) await warmCache();
  res.json(CACHE);
});

app.get('/diag', async (_req, res) => {
  const fresh = await fetchFixturesToday();
  res.json({
    tz: TZ, startHour: START_HOUR, url: fresh.apiUrl,
    totalFromApi: fresh.totalFromApi, cacheRows: CACHE.rows?.length || 0,
    cacheDate: CACHE.date, savedAt: CACHE.savedAt
  });
});

const INDEX_HTML = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Today's Matches — AI Picks v4</title>
  <script src="https://cdn.tailwindcss.com"></script>
  <style>thead.sticky th{position:sticky;top:0;z-index:10} th,td{vertical-align:middle}</style>
</head>
<body class="bg-slate-50 text-slate-900">
  <div class="max-w-6xl mx-auto p-4 space-y-3">
    <header class="flex items-center justify-between">
      <h1 class="text-2xl font-bold">Matches Today (11:00–24:00 TRT) — AI Picks v4</h1>
      <a href="/diag" class="text-xs underline opacity-70 hover:opacity-100">Diagnostics</a>
    </header>
    <div class="overflow-x-auto bg-white rounded-2xl shadow">
      <table class="min-w-full text-sm" id="tbl">
        <thead class="bg-slate-100 sticky"><tr>
          <th class="text-left p-3">Kickoff</th>
          <th class="text-left p-3">League</th>
          <th class="text-left p-3">Home</th>
          <th class="text-left p-3">Away</th>
          <th class="text-left p-3">Prediction</th>
        </tr></thead>
        <tbody id="rows"></tbody>
      </table>
    </div>
    <p class="text-[12px] text-slate-500">Picks: prefer O/U 2.5 if 1X2 is risky; else try BTTS; fallback to 1X2. Heuristic only.</p>
  </div>
  <script>
    async function load(){
      const res = await fetch("/api/today");
      const data = await res.json();
      const rows = data.rows || [];
      document.getElementById("rows").innerHTML = rows.map(r => (
        "<tr class='border-b last:border-0'>" +
          "<td class='p-3 whitespace-nowrap'>" + (r.kickoff||"") + "</td>" +
          "<td class='p-3'>" + (r.league||"") + "</td>" +
          "<td class='p-3 font-medium'>" + (r.home||"") + "</td>" +
          "<td class='p-3'>" + (r.away||"") + "</td>" +
          "<td class='p-3'>" + (r.prediction||"") + "</td>" +
        "</tr>"
      )).join("");
    }
    load();
    setInterval(load, 5*60*1000);
  </script>
</body>
</html>`;

app.get('/', (_req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(INDEX_HTML);
});

app.listen(PORT, HOST, () => {
  console.log(`✅ Server listening on ${HOST}:${PORT}`);
  warmCache();
});
