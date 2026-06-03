const crypto = require('crypto');

// ── Token cache (persists across warm lambda invocations) ────────────────────
let _cachedToken = null;
let _tokenExpiry  = 0;

const ALLOWED_ORIGINS = [
  'https://btrax-bd-suite.vercel.app',
  'https://manah921.github.io',
];

// ── CORS ─────────────────────────────────────────────────────────────────────
function setCORS(req, res) {
  const origin = req.headers.origin;
  if (ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  }
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Vary', 'Origin');
}

// ── JWT + token exchange ──────────────────────────────────────────────────────
function makeJWT(email, privateKey) {
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
  const now    = Math.floor(Date.now() / 1000);
  const payload = Buffer.from(JSON.stringify({
    iss:   email,
    scope: [
      'https://www.googleapis.com/auth/spreadsheets',
      'https://www.googleapis.com/auth/analytics.readonly',
      'https://www.googleapis.com/auth/webmasters.readonly',
    ].join(' '),
    aud: 'https://oauth2.googleapis.com/token',
    exp: now + 3600,
    iat: now,
  })).toString('base64url');

  const signingInput = `${header}.${payload}`;
  const sign = crypto.createSign('RSA-SHA256');
  sign.update(signingInput);
  return `${signingInput}.${sign.sign(privateKey, 'base64url')}`;
}

async function getToken() {
  if (_cachedToken && Date.now() < _tokenExpiry - 60_000) return _cachedToken;

  const email = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
  const raw   = process.env.GOOGLE_PRIVATE_KEY;
  if (!email || !raw) throw new Error('GOOGLE_SERVICE_ACCOUNT_EMAIL and GOOGLE_PRIVATE_KEY env vars required');

  const privateKey = raw.replace(/\\n/g, '\n');
  const jwt  = makeJWT(email, privateKey);
  const resp = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body:    `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${jwt}`,
  });
  const data = await resp.json();
  if (!resp.ok) throw new Error(data.error_description || data.error || `Token exchange failed HTTP ${resp.status}`);

  _cachedToken = data.access_token;
  _tokenExpiry = Date.now() + (data.expires_in || 3600) * 1000;
  return _cachedToken;
}

// ── Action handlers ───────────────────────────────────────────────────────────
async function handleSheets(token, { path, method = 'GET', body }) {
  const sheetId = process.env.GOOGLE_SHEET_ID;
  if (!sheetId) throw new Error('GOOGLE_SHEET_ID env var required');

  const url  = `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/${path}`;
  const opts = { method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } };
  if (body && method !== 'GET') opts.body = JSON.stringify(body);

  const resp = await fetch(url, opts);
  const data = await resp.json();
  if (!resp.ok) throw new Error(data.error?.message || `HTTP ${resp.status}`);
  return data;
}

// TODO: replace with live GA4/GSC data once
// service account permissions resolved
function handleGA4() {
  return {
    rows: [
      { dimensionValues: [{ value: 'google / organic' }],   metricValues: [{ value: '3842' }] },
      { dimensionValues: [{ value: 'direct / none' }],      metricValues: [{ value: '2105' }] },
      { dimensionValues: [{ value: 'linkedin / social' }],  metricValues: [{ value: '984' }] },
      { dimensionValues: [{ value: 'referral / btrax.com' }], metricValues: [{ value: '541' }] },
      { dimensionValues: [{ value: 'email / newsletter' }], metricValues: [{ value: '318' }] },
    ],
    totals: [{ metricValues: [{ value: '7790' }, { value: '5421' }] }],
    rowCount: 5,
    _mock: true,
  };
}

function handleGSC() {
  return {
    rows: [
      { keys: ['ux design agency japan'],         clicks: 142, impressions: 4820, ctr: 0.029, position: 3.2 },
      { keys: ['design thinking consulting'],     clicks: 98,  impressions: 3105, ctr: 0.032, position: 4.7 },
      { keys: ['btrax san francisco'],            clicks: 87,  impressions: 1240, ctr: 0.070, position: 2.1 },
      { keys: ['japan market entry strategy'],    clicks: 74,  impressions: 2890, ctr: 0.026, position: 5.3 },
      { keys: ['cross cultural design'],          clicks: 61,  impressions: 1680, ctr: 0.036, position: 6.8 },
      { keys: ['ui ux consulting firm'],          clicks: 53,  impressions: 2240, ctr: 0.024, position: 7.1 },
      { keys: ['innovation consulting tokyo'],    clicks: 47,  impressions: 1560, ctr: 0.030, position: 4.4 },
      { keys: ['service design agency'],          clicks: 39,  impressions: 1890, ctr: 0.021, position: 8.2 },
      { keys: ['bilingual design team'],          clicks: 31,  impressions: 920,  ctr: 0.034, position: 5.9 },
      { keys: ['japan us business consulting'],   clicks: 28,  impressions: 1340, ctr: 0.021, position: 9.4 },
    ],
    responseAggregationType: 'byPage',
    _mock: true,
  };
}

async function handleGoals(token, { year }) {
  const sheetId    = process.env.GOOGLE_SHEET_ID;
  if (!sheetId) throw new Error('GOOGLE_SHEET_ID env var required');

  const targetYear = parseInt(year) || new Date().getFullYear();
  const parseNum   = s => parseFloat(String(s || '').replace(/[$,\s]/g, '')) || 0;
  const MONTHS     = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

  // Fetch Goals tab
  const resp = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/Goals!A:P`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  const data = await resp.json();
  if (!resp.ok) throw new Error(data.error?.message || `HTTP ${resp.status}`);

  const rows = data.values || [];
  if (!rows.length) return { totalGoal: 0, monthlyTargets: new Array(12).fill(0), serviceGoals: {} };

  // Headers: "Fiscal Year | Service Offering | Annual Goal | Jan | Feb | ... | Dec"
  const headers = rows[0].map(h => String(h || '').trim());

  const yearCI   = headers.findIndex(h => /year|fiscal/i.test(h));
  const svcCI    = headers.findIndex(h => /service/i.test(h));
  const goalCI   = headers.findIndex(h => /annual|goal/i.test(h));
  const monthCIs = MONTHS.map(m => headers.findIndex(h => h.toLowerCase() === m.toLowerCase()));

  let totalGoal = 0;
  const monthlyTargets = new Array(12).fill(0);
  const serviceGoals   = {};

  rows.slice(1).forEach(row => {
    if (!row.some(c => c)) return;
    // Normalize year: compare as trimmed strings
    const rowYearStr = String(row[yearCI] || '').trim();
    if (yearCI >= 0 && rowYearStr && rowYearStr !== String(targetYear).trim()) return;

    const goal = goalCI >= 0 ? parseNum(row[goalCI]) : 0;
    // Normalize service key to lowercase for case-insensitive matching
    const svc  = svcCI  >= 0 ? String(row[svcCI] || '').trim().toLowerCase() : '';

    if (goal) totalGoal += goal;
    if (svc && goal) serviceGoals[svc] = (serviceGoals[svc] || 0) + goal;

    monthCIs.forEach((ci, mi) => {
      if (ci >= 0 && row[ci]) monthlyTargets[mi] += parseNum(row[ci]);
    });
  });

  // If monthly targets all zero, distribute annual goal evenly
  if (totalGoal > 0 && monthlyTargets.every(t => t === 0)) {
    const each = totalGoal / 12;
    for (let i = 0; i < 12; i++) monthlyTargets[i] = each;
  }

  return { totalGoal, monthlyTargets, serviceGoals };
}

async function handleTest(token) {
  const sheetId = process.env.GOOGLE_SHEET_ID;
  const authHdr = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

  const sheetsResult = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/A1`,
    { headers: authHdr }
  ).then(r => r.ok ? { ok: true } : r.json().then(e => { throw new Error(e.error?.message || `HTTP ${r.status}`); }))
   .catch(e => ({ ok: false, error: e.message }));

  return {
    sheets: sheetsResult,
    ga4:    { ok: true, mock: true },
    gsc:    { ok: true, mock: true },
  };
}

// ── Main handler ──────────────────────────────────────────────────────────────
module.exports = async function handler(req, res) {
  setCORS(req, res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST')   return res.status(405).json({ error: 'Method not allowed' });

  const { action, ...params } = req.body || {};

  try {
    const token = await getToken();

    let result;
    if      (action === 'sheets') result = await handleSheets(token, params);
    else if (action === 'goals')  result = await handleGoals(token, params);
    else if (action === 'ga4')    result = handleGA4();
    else if (action === 'gsc')    result = handleGSC();
    else if (action === 'test')   result = await handleTest(token);
    else return res.status(400).json({ error: `Unknown action: ${action}` });

    return res.status(200).json(result);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};
