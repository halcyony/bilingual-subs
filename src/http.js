import { config } from './config.js';

export class HttpError extends Error {
  constructor(status, url, body) {
    super(`HTTP ${status} for ${redact(url)}${body ? `: ${body.slice(0, 200)}` : ''}`);
    this.status = status;
    this.body = body || '';
  }
}

// Keep API keys/tokens out of logs.
export function redact(url) {
  return String(url).replace(/((?:api_key|token)=)[^&]+/gi, '$1***');
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// One attempt. `read` consumes the body while the timer is still running, so a
// server that sends headers and then stalls times out too.
async function attempt(url, opts, read) {
  const { timeoutMs = config.httpTimeoutMs, ...fetchOpts } = opts;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      ...fetchOpts,
      headers: { 'User-Agent': config.userAgent, ...(fetchOpts.headers || {}) },
      signal: ctrl.signal,
    });
    if (!res.ok) throw new HttpError(res.status, url, await res.text().catch(() => ''));
    return await read(res);
  } catch (e) {
    if (e instanceof HttpError) throw e;
    // undici's "fetch failed" hides the real reason in `cause`.
    const timedOut = e.name === 'AbortError' || ctrl.signal.aborted;
    const why = timedOut ? 'timed out' : e.cause?.code || e.cause?.message || e.message;
    const err = new Error(`${new URL(url).host}: ${why}`);
    err.timedOut = timedOut;
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

// GETs are retried once on a 5xx or a dropped connection. Timeouts are not
// (the wait would double), and neither are POSTs (a download request costs quota).
const RETRY_DELAY_MS = 500;

async function request(url, opts = {}, read) {
  try {
    return await attempt(url, opts, read);
  } catch (e) {
    const isGet = !opts.method || opts.method === 'GET';
    const retry = isGet && (e instanceof HttpError ? e.status >= 500 : !e.timedOut);
    if (!retry) throw e;
    await sleep(RETRY_DELAY_MS);
    return attempt(url, opts, read);
  }
}

export const getJson = (url, opts) => request(url, opts, (res) => res.json());

// Reads a body up to `max` bytes, then gives up. A refusal is an HttpError
// (413), so it is not retried: a second try would download the same thing.
async function readLimited(res, url, max) {
  const tooBig = () => new HttpError(413, url, `larger than ${max} bytes`);
  if (Number(res.headers.get('content-length')) > max) throw tooBig();
  const chunks = [];
  let size = 0;
  for await (const chunk of res.body ?? []) {
    size += chunk.length;
    if (size > max) throw tooBig();
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

export const getBuffer = (url, opts = {}) => {
  const { maxBytes = config.maxDownloadBytes, ...rest } = opts;
  return request(url, rest, (res) => readLimited(res, url, maxBytes));
};
