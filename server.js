// server.js — AI Picks v5.2.2 (Strongest-Market Selection) — FIXED H duplicate
// One HTTP header helper (H) + one getJson().
// Compares 1X2 vs O/U 2.5 vs BTTS and outputs the market with largest EDGE.

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

// Calibration & selection
const SHARPEN_TAU_1X2 = parseFloat(process.env.SHARPEN_TAU_1X2 || '1.25'); // sharpen 1X2
const STRONG_DIFF_TILT = parseFloat(process.env.STRONG_DIFF_TILT || '220'); // Elo mismatch
const EDGE_MIN = parseFloat(process.env.EDGE_MIN || '0.08'); // 8% min edge to accept strongest

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.disable('x-powered-by');

// ---------- Time helpers
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

// ---------- Aliases
const ALIAS = new Map([
  ['paris saint germain','psg'], ['paris saint germain fc','psg'],
  ['manchester city fc','manchester city'], ['manchester united fc','manchester united'],
  ['fc barcelona','barcelona'], ['fc bayern munich','bayern munich'],
  ['fc internazionale milano','inter'], ['fc internazionale','inter'],
  ['juventus fc','juventus'], ['ac milan','milan'],
  ['atletico de madrid','atletico madrid'], ['ssc napoli','napoli'],
  ['as roma','roma'], ['tottenham hotspur','tottenham'],
  ['fenerbahce istanbul','fenerbahce'], ['galatasaray sk','galatasaray'], ['besiktas jk','besiktas'],
]);
function canonicalKey(name){
  const n = normTeam(name);
  if (ALIAS.has(n)) return ALIAS.get(n);
  return n;
}

// ---------- Seeds (Elo-like)
const SEED_ELO = {
  'psg':1850,'paris saint germain':1850,
  'real madrid':1850,'barcelona':1820,'manchester city':1880,'liverpool':1820,'arsenal':1800,
  'chelsea':1750,'manchester united':1760,'bayern munich':1900,'inter':1820,'juventus':1800,
  'milan':1780,'atletico madrid':1800,'napoli':1780,'roma':1740,'tottenham':1760,
  'galatasaray':1700,'fenerbahce':1680,'besiktas':1650,'trabzonspor':1620,'nantes':1600
};
function seedOf(name){
  const key = canonicalKey(name);
  return SEED_ELO[key] ?? SEED_ELO[normTeam(name)] ?? 1500;
}

// ---------- League baseline GPM
function leagueBaseGpm(league=''){
  const k = (league||'').toLowerCase();
  if (k.includes('super lig') || k.includes('süper lig')) return 2.7;
  if (k.includes('premier')) return 2.9;
  if (k.includes('la liga')) return 2.6;
  if (k.includes('bundesliga')) return 3.1;
  if (k.includes('serie a')) return 2.5;
  if (k.includes('ligue 1')) return 2.75;
  if (k.includes('eredivisie')) return 3.0;
  if (k.includes('primeira')) return 2.5;
  return 2.65;
}

// ---------- HTTP helper (single)
const H = { 'X-Auth-Token': API_KEY, 'accept': 'application/json' };
async function getJson(url){
  const res = await fetch(url, { headers: H });
  const txt = await res.text();
  try { return JSON.parse(txt); } catch { return { raw: txt }; }
}

// ---------- Standings & form
const standingsCache = new Map();
async function getStandings(compId){
  if (standingsCache.has(compId)) return standingsCache.get(compId);
  try {
    const j = await getJson(`https://api.football-data.org/v4/competitions/${compId}/standings`);
    const total = (j?.standings||[]).find(s => s.type === 'TOTAL');
    const table = total?.table || [];
    const map = new Map();
    for (const row of table) if (row.team?.id) map.set(row.team.id, row.position || 0);
    const pack = { table, map, size: table.length || 20 };
    standingsCache.set(compId, pack);
    return pack;
  } catch { return { table: [], map: new Map(), size: 20 }; }
}

const formCache = new Map();
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
  arr = arr.filter(m => m.competition?.id === compId);
  arr.sort((a,b)=> (b.utcDate||'').localeCompare(a.utcDate||''));
  const last5 = arr.slice(0,5);
  formCache.set(key, last5);
  return last5;
}

function matchPoints(forGoals, agGoals){ if (forGoals>agGoals) return 3; if (forGoals===agGoals) return 1; return 0; }

function formStatsAdvanced(teamId, matches, standingsPack){
  const size = standingsPack.size || 20;
  const posMap = standingsPack.map || new Map();
  const REC = [1.00, 0.92, 0.85, 0.78, 0.72];
  let pts=0, gf=0, ga=0, oppAvg=0, oppCnt=0, adjScore=0;
  matches.forEach((m, idx) => {
    const isHome = m.homeTeam?.id === teamId;
    const ts = m.score?.fullTime || m.score?.regularTime || {};
    const h = ts.home ?? 0, a = ts.away ?? 0;
    const forGoals = isHome ? h : a;
    const agGoals = isHome ? a : h;
    const ptsThis = matchPoints(forGoals, agGoals);
    const oppId = isHome ? m.awayTeam?.id : m.homeTeam?.id;
    const oppPos = oppId ? (posMap.get(oppId) || Math.ceil(size/2)) : Math.ceil(size/2);
    const norm = (size - oppPos) / size - 0.5;
    const OPP_K = 0.8;
    const oppFactor = 1 + norm * OPP_K;
    const venueFactor = isHome ? 1.00 : 1.15;
    const w = REC[idx] ?? 0.7;
    const score = ptsThis * oppFactor * venueFactor * w;
    adjScore += score;
    pts += ptsThis; gf += forGoals; ga += agGoals; oppAvg += oppPos; oppCnt += 1;
  });
  const gPlayed = matches.length || 1;
  const ppm = pts / gPlayed;
  const gfpm = gf / gPlayed;
  const gapm = ga / gPlayed;
  const oppAvgPos = oppCnt ? (oppAvg/oppCnt) : Math.ceil(size/2);
  const formStrength = (adjScore / 12.0);
  return { ppm, gfpm, gapm, oppAvgPos, formStrength };
}

// ---------- Poisson & helpers
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
function sharpen3(pH, pD, pA, tau){
  const a = Math.pow(pH, tau), b = Math.pow(pD, tau), c = Math.pow(pA, tau);
  const Z = (a+b+c) || 1;
  return { pH: a/Z, pD: b/Z, pA: c/Z };
}

function expectedGoalsAdvanced(homeName, awayName, leagueName, homeForm, awayForm){
  const baseG = leagueBaseGpm(leagueName);
  const HOME_ELO = 65;
  const rh = seedOf(homeName);
  const ra = seedOf(awayName);
  const seedDiff = (rh + HOME_ELO) - ra;
  const fToFactor = f => Math.max(0.85, Math.min(1.15, 0.98 + 0.10 * f));
  const homeFormFac = fToFactor(homeForm.formStrength);
  const awayFormFac = fToFactor(awayForm.formStrength);
  let split = 0.5 + 0.12*Math.tanh(seedDiff/650);
  const relForm = (homeFormFac)/(awayFormFac+1e-9);
  split = Math.max(0.36, Math.min(0.64, split * Math.pow(relForm, 0.25)));
  let lh = baseG * split * (1 + seedDiff/2200) * homeFormFac;
  let la = baseG * (1 - split) * (1 - seedDiff/2200) * awayFormFac;
  if (seedOf(homeName) - seedOf(awayName) >= STRONG_DIFF_TILT) { lh *= 1.10; la *= 0.90; }
  lh = Math.max(0.15, Math.min(3.2, lh));
  la = Math.max(0.15, Math.min(3.2, la));
  return { lh, la, seedDiff, homeFormFac:+homeFormFac.toFixed(3), awayFormFac:+awayFormFac.toFixed(3) };
}

// ---------- Select strongest market by EDGE over neutral baseline
function chooseStrongest(lh, la){
  let { pH, pD, pA } = probs1X2(lh, la);
  ({ pH, pD, pA } = sharpen3(pH, pD, pA, SHARPEN_TAU_1X2));

  const best1 = [{label:'1',p:pH},{label:'X',p:pD},{label:'2',p:pA}].sort((a,b)=>b.p-a.p)[0];
  const edge1 = best1.p - 1/3;

  const totLam = lh + la;
  const pU25 = poisCdf(totLam, 2);
  const pO25 = 1 - pU25;
  const bestTot = pO25 >= pU25 ? { market:'Over/Under 2.5', label:'Over 2.5', p:pO25 } : { market:'Over/Under 2.5', label:'Under 2.5', p:pU25 };
  const edgeTot = bestTot.p - 0.5;

  const pBTTS = 1 - (Math.exp(-lh) + Math.exp(-la) - Math.exp(-lh-la));
  const bestBTTS = pBTTS >= 0.5 ? { market:'BTTS', label:'Yes', p:pBTTS } : { market:'BTTS', label:'No', p:1-pBTTS };
  const edgeBTTS = bestBTTS.p - 0.5;

  const candidates = [
    { market:'1X2', label:best1.label, prob:best1.p, edge:edge1, base:0.33 },
    { market:bestTot.market, label:bestTot.label, prob:bestTot.p, edge:edgeTot, base:0.50 },
    { market:bestBTTS.market, label:bestBTTS.label, prob:bestBTTS.p, edge:edgeBTTS, base:0.50 },
  ].sort((a,b)=> b.edge - a.edge);

  const top = candidates[0];
  if (top.edge >= EDGE_MIN) return top;
  return { market:'1X2', label:best1.label, prob:best1.p, edge:edge1, base:0.33, note:'low-edge-fallback' };
}

// ---------- Fetch fixtures and build rows
async function fetchFixturesToday(withExplain=false){
  const date = todayYMD();
  if (!API_KEY) return { date, rows: [], reason: 'missing_api_key' };
  const now = new Date();
  const startUtc = now.toISOString().split('T')[0];
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));
  const endUtc = end.toISOString().split(0,10);
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

    let out = null;
    let dbg = null;
    try {
      const standingsPack = compId ? await getStandings(compId) : { map:new Map(), size:20 };
      const homeMatches = homeId ? await getLastLeagueMatches(homeId, compId) : [];
      const awayMatches = awayId ? await getLastLeagueMatches(awayId, compId) : [];
      const homeForm = formStatsAdvanced(homeId, homeMatches, standingsPack);
      const awayForm = formStatsAdvanced(awayId, awayMatches, standingsPack);
      const eg = expectedGoalsAdvanced(homeName, awayName, league, homeForm, awayForm);
      out = chooseStrongest(eg.lh, eg.la);
      if (withExplain) {
        let { pH, pD, pA } = probs1X2(eg.lh, eg.la);
        const raw = { pH, pD, pA };
        const sharp = sharpen3(pH, pD, pA, SHARPEN_TAU_1X2);
        const totLam = eg.lh + eg.la;
        const pU25 = poisCdf(totLam, 2);
        const pO25 = 1 - pU25;
        const pBTTS = 1 - (Math.exp(-eg.lh) + Math.exp(-eg.la) - Math.exp(-eg.lh-eg.la));
        dbg = { seeds:{home:seedOf(homeName),away:seedOf(awayName)}, form:{home:homeForm, away:awayForm}, eg, p1x2_raw:raw, p1x2_sharp:sharp, pO25, pU25, pBTTS, selection:out };
      }
    } catch (e) {}

    const pct = Math.round((out?.prob || 0) * 100);
    const edgePct = Math.round(Math.max(0, (out?.edge || 0) * 100));
    const row = {
      league, kickoffIso, kickoff: toLocalLabel(kickoffIso),
      hourLocal, home: homeName, away: awayName,
      prediction: out ? `${out.market}: ${out.label} (${pct}%, +${edgePct} edge)` : 'N/A'
    };
    if (withExplain) row._explain = dbg;
    rows.push(row);
  }

  rows.sort((a,b)=> (a.kickoff||'').localeCompare(b.kickoff||''));
  if (!rows.length && FALLBACK_DEMO) {
    rows.push({
      league: 'Demo League', kickoff: `${date} 19:00`, hourLocal: 19, home: 'Alpha FC', away: 'Beta United',
      prediction: '1X2: 1 (64%, +31 edge)'
    });
  }
  return { date, rows, totalFromApi: arr.length, apiUrl: url };
}

// ---------- Cache & schedule
let CACHE = { date: null, rows: [], savedAt: null };
async function warmCache() {
  try { CACHE = { ...(await fetchFixturesToday()), savedAt: new Date().toISOString() }; }
  catch (e) { CACHE = { date: todayYMD(), rows: [], savedAt: new Date().toISOString(), error: String(e.message || e) }; }
}
cron.schedule('1 0 * * *', async () => { await warmCache(); }, { timezone: TZ });

// ---------- Routes
app.get('/api/today', async (_req, res) => {
  const nowDate = todayYMD();
  if (CACHE.date !== nowDate) await warmCache();
  res.json(CACHE);
});
app.get('/diag', async (_req, res) => {
  const fresh = await fetchFixturesToday(false);
  res.json({ tz: TZ, startHour: START_HOUR, url: fresh.apiUrl, totalFromApi: fresh.totalFromApi, cacheRows: CACHE.rows?.length || 0, cacheDate: CACHE.date, savedAt: CACHE.savedAt });
});
app.get('/explain', async (_req, res) => {
  const fresh = await fetchFixturesToday(true);
  res.json(fresh);
});

// ---------- UI
const INDEX_HTML = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Today's Matches — AI Picks v5.2.2</title>
  <script src="https://cdn.tailwindcss.com"></script>
  <style>thead.sticky th{position:sticky;top:0;z-index:10} th,td{vertical-align:middle}</style>
</head>
<body class="bg-slate-50 text-slate-900">
  <div class="max-w-6xl mx-auto p-4 space-y-3">
    <header class="flex items-center justify-between">
      <h1 class="text-2xl font-bold">Matches Today (11:00–24:00 TRT) — AI Picks v5.2.2</h1>
      <div class="space-x-3 text-xs">
        <a href="/diag" class="underline opacity-70 hover:opacity-100">Diag</a>
        <a href="/explain" class="underline opacity-70 hover:opacity-100">Explain</a>
      </div>
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
    <p class="text-[12px] text-slate-500">Chooses the single strongest market by edge over neutral.</p>
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
