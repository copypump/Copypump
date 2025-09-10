// Netlify Function: Launch Copycat
// POST /.netlify/functions/launch
// Body JSON: { name, symbol, uri, devBuy, slippage, priorityFee, pool }

const IPFS_ENDPOINT = process.env.PUMP_IPFS_ENDPOINT || 'https://pump.fun/api/ipfs';
const TRADE_ENDPOINT_BASE = process.env.PUMP_TRADE_ENDPOINT || 'https://pumpportal.fun/api/trade';
const API_KEY = process.env.PUMPPORTAL_API_KEY || '';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

exports.handler = async (event) => {
  try {
    if (event.httpMethod === 'OPTIONS') {
      return { statusCode: 204, headers: CORS };
    }
    if (event.httpMethod !== 'POST') {
      return json(405, { error: 'Method not allowed' });
    }

    const body = JSON.parse(event.body || '{}');
    const {
      name = '',
      symbol = '',
      uri = '',
      devBuy = 1,
      slippage = 10,
      priorityFee = 0.0005,
      pool = 'pump',
    } = body;

    if (!name || !symbol || !uri) {
      return json(400, { error: 'name, symbol, uri are required' });
    }

    // 1) Récupérer la metadata d’origine
    const meta = await fetchJson(resolveIpfs(uri));
    const description = (meta && (meta.description || meta.desc)) || '';
    const twitter = meta?.twitter || meta?.extensions?.twitter || '';
    const telegram = meta?.telegram || meta?.extensions?.telegram || '';
    const website = meta?.website || meta?.extensions?.website || '';

    // 2) Télécharger l’image (si dispo)
    let imageUrl = '';
    if (meta?.image) imageUrl = resolveIpfs(meta.image);
    if (!imageUrl && body.image) imageUrl = resolveIpfs(body.image);

    let fileBlob = null;
    let filename = 'image.png';
    if (imageUrl) {
      const r = await fetch(imageUrl);
      if (r.ok) {
        const ct = r.headers.get('content-type') || 'image/png';
        const buf = await r.arrayBuffer();
        fileBlob = new Blob([buf], { type: ct });
        const urlName = tryGetFilenameFromUrl(imageUrl);
        if (urlName) filename = urlName;
      }
    }

    // 3) Upload à l’IPFS pump.fun
    const fd = new FormData();
    if (fileBlob) fd.append('file', fileBlob, filename);
    fd.append('name', name);
    fd.append('symbol', symbol);
    fd.append('description', description);
    fd.append('twitter', twitter);
    fd.append('telegram', telegram);
    fd.append('website', website);
    fd.append('showName', 'true');

    const upRes = await fetch(IPFS_ENDPOINT, { method: 'POST', body: fd });
    if (!upRes.ok) {
      const errText = await upRes.text().catch(() => '');
      return json(502, { error: 'IPFS upload failed', details: errText });
    }
    const up = await upRes.json();
    const metadataUri = up?.metadataUri;
    if (!metadataUri) {
      return json(502, { error: 'Missing metadataUri from IPFS upload', raw: up });
    }

    // 4) Appeler /trade (Lightning)
    const tradeUrl = API_KEY ? `${TRADE_ENDPOINT_BASE}?api-key=${encodeURIComponent(API_KEY)}` : TRADE_ENDPOINT_BASE;
    const tradeBody = {
      action: 'create',
      tokenMetadata: { name, symbol, uri: metadataUri },
      denominatedInSol: 'true',
      amount: Number(devBuy) || 0,
      slippage: Number(slippage) || 10,
      priorityFee: Number(priorityFee) || 0.0005,
      pool: pool || 'pump',
    };

    const tRes = await fetch(tradeUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(tradeBody),
    });

    const tJson = await safeJson(tRes);
    if (!tRes.ok) {
      return json(tRes.status, { error: 'Trade failed', response: tJson });
    }

    return json(200, {
      ok: true,
      signature: tJson?.signature || null,
      tradeResponse: tJson,
      metadataUri,
    });

  } catch (e) {
    return json(500, { error: 'Unhandled error', message: String(e?.message || e) });
  }
};

function json(code, data) {
  return { statusCode: code, headers: CORS, body: JSON.stringify(data) };
}

function resolveIpfs(u) {
  if (!u) return '';
  return u.startsWith('ipfs://') ? 'https://ipfs.io/ipfs/' + u.replace('ipfs://', '') : u;
}

function tryGetFilenameFromUrl(u) {
  try {
    const p = new URL(u);
    const last = p.pathname.split('/').filter(Boolean).pop();
    return last || null;
  } catch { return null; }
}

async function fetchJson(url) {
  if (!url) return null;
  try {
    const r = await fetch(url, { cache: 'no-store' });
    if (!r.ok) return null;
    return await r.json();
  } catch { return null; }
}

async function safeJson(r) {
  try { return await r.json(); } catch { return null; }
}