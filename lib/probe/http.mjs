import https from 'node:https';

export const DEFAULT_MAX_BODY_BYTES = 5 * 1024 * 1024;

export function maxBodyBytes(env = process.env) {
  const raw = env.BUDGET_HTTP_MAX_BODY_BYTES;
  if (!raw) return DEFAULT_MAX_BODY_BYTES;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_MAX_BODY_BYTES;
}

export function readResponseBody(res, { maxBytes = DEFAULT_MAX_BODY_BYTES } = {}) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    let done = false;

    const finish = (fn, value) => {
      if (done) return;
      done = true;
      fn(value);
    };

    res.on('data', (chunk) => {
      if (done) return;
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      total += buf.length;
      if (total > maxBytes) {
        if (typeof res.destroy === 'function') {
          try { res.destroy(); } catch (_) {}
        }
        finish(reject, new Error(`response_too_large:${total}>${maxBytes}`));
        return;
      }
      chunks.push(buf);
    });
    res.on('end', () => finish(resolve, Buffer.concat(chunks).toString('utf8')));
    res.on('error', (e) => finish(reject, e));
  });
}

export function requestJson(url, { headers = {}, timeoutMs = 5000, maxBytes = maxBodyBytes() } = {}) {
  return new Promise((resolve) => {
    const req = https.request(url, {
      method: 'GET',
      headers,
      timeout: timeoutMs,
    }, async (res) => {
      let body = '';
      try {
        body = await readResponseBody(res, { maxBytes });
      } catch (e) {
        return resolve({ ok: false, status: res.statusCode || 0, error: e?.message || String(e) });
      }
      if (res.statusCode === 429) {
        const ra = Number.parseInt(res.headers['retry-after'] || '', 10);
        return resolve({ ok: false, status: 429, retryAfter: Number.isFinite(ra) ? ra : undefined, error: 'http_429' });
      }
      if (!res.statusCode || res.statusCode < 200 || res.statusCode >= 300) {
        return resolve({ ok: false, status: res.statusCode || 0, error: `http_${res.statusCode || 'na'}` });
      }
      try {
        return resolve({ ok: true, status: res.statusCode, raw: JSON.parse(body) });
      } catch (e) {
        return resolve({ ok: false, status: res.statusCode, error: `json_parse:${e.message}` });
      }
    });
    req.on('timeout', () => {
      try { req.destroy(); } catch (_) {}
      resolve({ ok: false, error: 'timeout' });
    });
    req.on('error', (e) => resolve({ ok: false, error: `net:${e.message}` }));
    req.end();
  });
}

