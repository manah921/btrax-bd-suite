const SHEET_ID = process.env.GOOGLE_SHEET_ID;
const SA_EMAIL = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
const SA_KEY   = process.env.GOOGLE_PRIVATE_KEY;

function base64url(input) {
  const buf = Buffer.isBuffer(input)
    ? input
    : Buffer.from(typeof input === 'string' ? input : JSON.stringify(input));
  return buf.toString('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
}

async function getAccessToken() {
  const crypto = require('crypto');
  const key = SA_KEY.replace(/\\n/g, '\n');
  const now = Math.floor(Date.now() / 1000);

  const header  = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const payload = base64url(JSON.stringify({
    iss:   SA_EMAIL,
    scope: 'https://www.googleapis.com/auth/spreadsheets',
    aud:   'https://oauth2.googleapis.com/token',
    exp:   now + 3600,
    iat:   now,
  }));

  const signingInput = `${header}.${payload}`;
  const sign = crypto.createSign('RSA-SHA256');
  sign.update(signingInput);
  const signature  = sign.sign(key);
  const encodedSig = base64url(signature);
  const jwt = `${signingInput}.${encodedSig}`;

  const response = await fetch('https://oauth2.googleapis.com/token', {
    method:  'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body:    `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=${jwt}`,
  });

  const data = await response.json();
  if (!data.access_token) throw new Error('Token failed: ' + JSON.stringify(data));
  return data.access_token;
}

async function readSheet(token, range) {
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values/${encodeURIComponent(range)}`;
  const res  = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  const data = await res.json();
  if (!data.values) return { headers: [], rows: [] };
  const headers = data.values[0];
  const rows = data.values.slice(1).map(row => {
    const obj = {};
    headers.forEach((h, i) => { obj[h.trim()] = row[i] || ''; });
    return obj;
  });
  return { headers, rows };
}

async function writeSheet(token, range, values) {
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values/${encodeURIComponent(range)}?valueInputOption=USER_ENTERED`;
  const res  = await fetch(url, {
    method:  'PUT',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body:    JSON.stringify({ range, values }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error?.message || `HTTP ${res.status}`);
  return data;
}

async function appendSheet(token, range, values) {
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values/${encodeURIComponent(range)}:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`;
  const res  = await fetch(url, {
    method:  'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body:    JSON.stringify({ values }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error?.message || `HTTP ${res.status}`);
  return data;
}

function getMockGA4() {
  return {
    sessions: 3842, users: 2917, avgSessionDuration: '2m 34s',
    totalSearchClicks: 660,
    topSources: [
      { source: 'google / organic', sessions: 1840 },
      { source: 'direct / none', sessions: 892 },
      { source: 'linkedin / referral', sessions: 341 },
      { source: 'google / cpc', sessions: 287 },
      { source: 'twitter / referral', sessions: 124 }
    ],
    topCountries: [
      { country: 'United States', sessions: 1923 },
      { country: 'Japan', sessions: 1124 },
      { country: 'United Kingdom', sessions: 187 },
      { country: 'Canada', sessions: 143 },
      { country: 'Australia', sessions: 98 }
    ],
    topCities: [
      { city: 'San Francisco', country: 'US', sessions: 687 },
      { city: 'Tokyo', country: 'JP', sessions: 542 },
      { city: 'New York', country: 'US', sessions: 312 },
      { city: 'Osaka', country: 'JP', sessions: 198 },
      { city: 'Los Angeles', country: 'US', sessions: 187 }
    ],
    topPages: [
      { page: '/', sessions: 1243 },
      { page: '/our-services', sessions: 487 },
      { page: '/our-work', sessions: 392 },
      { page: '/about-us', sessions: 287 },
      { page: '/blog', sessions: 241 }
    ],
    devices: { desktop: 61, mobile: 34, tablet: 5 }
  };
}

function getMockGSC() {
  return {
    totalClicks: 1610, totalImpressions: 17000, avgCTR: 9.4, avgPosition: 7.9,
    topQueries: [
      { query: 'btrax',                             clicks: 782, impressions: 1463, ctr: 53.4, position: 1.2 },
      { query: 'btrax japan',                       clicks:  57, impressions:   99, ctr: 57.6, position: 2.1 },
      { query: 'japan market entry design',         clicks:  24, impressions:  412, ctr:  5.8, position: 8.4 },
      { query: 'ux design agency japan',            clicks:  18, impressions:  334, ctr:  5.4, position: 9.2 },
      { query: 'cross cultural design agency',      clicks:  14, impressions:  287, ctr:  4.9, position: 11.3 },
      { query: 'japan localization agency',         clicks:  11, impressions:  198, ctr:  5.6, position: 7.8 },
      { query: 'design agency san francisco japan', clicks:   9, impressions:  167, ctr:  5.4, position: 8.9 },
      { query: 'japan ux research',                 clicks:   7, impressions:  143, ctr:  4.9, position: 12.1 }
    ],
    topCountries: [
      { country: 'USA', clicks: 892 },
      { country: 'Japan', clicks: 487 },
      { country: 'UK', clicks: 87 },
      { country: 'Canada', clicks: 54 },
      { country: 'Australia', clicks: 43 }
    ]
  };
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Methods', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  if (typeof req.body === 'string') {
    try { req.body = JSON.parse(req.body); } catch { req.body = {}; }
  }

  const action = req.query?.action || req.body?.action;
  if (action === 'test') return res.json({ ok: true });
  if (!action)           return res.status(400).json({ error: 'Missing action parameter' });

  try {
    const token = await getAccessToken();

    if (action === 'pipeline') {
      const { rows } = await readSheet(token, 'Pipeline!A1:AB1000');
      return res.json({ data: rows });
    }
    if (action === 'goals') {
      const { rows } = await readSheet(token, 'Goals!A1:P100');
      return res.json({ data: rows });
    }
    if (action === 'contacts') {
      const { rows } = await readSheet(token, 'Contacts!A1:H1000');
      return res.json({ data: rows });
    }
    if (action === 'write') {
      const result = await writeSheet(token, req.body.range, req.body.values);
      return res.json(result);
    }
    if (action === 'append') {
      const result = await appendSheet(token, req.body.range, req.body.values);
      return res.json(result);
    }
    if (action === 'ga4') return res.json({ data: getMockGA4() });
    if (action === 'gsc') return res.json({ data: getMockGSC() });

    return res.status(400).json({ error: 'Unknown action: ' + action });

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};
