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

async function handleGA4(token, { body }) {
  const propertyId = process.env.GA4_PROPERTY_ID || '260384621';
  const resp = await fetch(
    `https://analyticsdata.googleapis.com/v1beta/properties/${propertyId}:runReport`,
    { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
  );
  const data = await resp.json();
  if (!resp.ok) throw new Error(data.error?.message || `HTTP ${resp.status}`);
  return data;
}

async function handleGSC(token, { body }) {
  const siteUrl = process.env.GSC_SITE_URL || 'https://btrax.com/';
  const resp = await fetch(
    `https://searchconsole.googleapis.com/webmasters/v3/sites/${encodeURIComponent(siteUrl)}/searchAnalytics/query`,
    { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
  );
  const data = await resp.json();
  if (!resp.ok) throw new Error(data.error?.message || `HTTP ${resp.status}`);
  return data;
}

async function handleTest(token) {
  const sheetId    = process.env.GOOGLE_SHEET_ID;
  const propertyId = process.env.GA4_PROPERTY_ID || '260384621';
  const siteUrl    = process.env.GSC_SITE_URL    || 'https://btrax.com/';

  const end   = new Date(); end.setDate(end.getDate() - 3);
  const start = new Date(end); start.setDate(start.getDate() - 7);
  const fmt   = d => d.toISOString().slice(0, 10);

  const authHdr = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

  const [sheets, ga4, gsc] = await Promise.allSettled([
    fetch(`https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/A1`, { headers: authHdr })
      .then(r => r.ok ? { ok: true } : r.json().then(e => { throw new Error(e.error?.message || `HTTP ${r.status}`); })),

    fetch(`https://analyticsdata.googleapis.com/v1beta/properties/${propertyId}:runReport`, {
      method: 'POST', headers: authHdr,
      body: JSON.stringify({ dateRanges: [{ startDate: '7daysAgo', endDate: 'today' }], metrics: [{ name: 'sessions' }] }),
    }).then(r => r.ok ? { ok: true } : r.json().then(e => { throw new Error(e.error?.message || `HTTP ${r.status}`); })),

    fetch(`https://searchconsole.googleapis.com/webmasters/v3/sites/${encodeURIComponent(siteUrl)}/searchAnalytics/query`, {
      method: 'POST', headers: authHdr,
      body: JSON.stringify({ startDate: fmt(start), endDate: fmt(end), dimensions: ['query'], rowLimit: 3 }),
    }).then(r => r.ok ? { ok: true } : r.json().then(e => { throw new Error(e.error?.message || `HTTP ${r.status}`); })),
  ]);

  return {
    sheets: sheets.status === 'fulfilled' ? { ok: true }  : { ok: false, error: sheets.reason?.message },
    ga4:    ga4.status    === 'fulfilled' ? { ok: true }  : { ok: false, error: ga4.reason?.message },
    gsc:    gsc.status    === 'fulfilled' ? { ok: true }  : { ok: false, error: gsc.reason?.message },
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
    else if (action === 'ga4')    result = await handleGA4(token, params);
    else if (action === 'gsc')    result = await handleGSC(token, params);
    else if (action === 'test')   result = await handleTest(token);
    else return res.status(400).json({ error: `Unknown action: ${action}` });

    return res.status(200).json(result);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};
