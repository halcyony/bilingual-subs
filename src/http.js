import { config } from './config.js';

export class HttpError extends Error {
  constructor(status, url, body) {
    super(`HTTP ${status} for ${redact(url)}${body ? `: ${body.slice(0, 200)}` : ''}`);
    this.status = status;
  }
}

// Keep API keys/tokens out of logs.
export function redact(url) {
  return String(url).replace(/((?:api_key|token)=)[^&]+/gi, '$1***');
}

async function request(url, opts = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), config.httpTimeoutMs);
  try {
    const res = await fetch(url, {
      ...opts,
      headers: { 'User-Agent': config.userAgent, ...(opts.headers || {}) },
      signal: ctrl.signal,
    });
    if (!res.ok) throw new HttpError(res.status, url, await res.text().catch(() => ''));
    return res;
  } catch (e) {
    if (e instanceof HttpError) throw e;
    // undici's "fetch failed" hides the real reason in `cause`.
    const why = e.name === 'AbortError' ? 'timed out' : e.cause?.code || e.cause?.message || e.message;
    throw new Error(`${new URL(url).host}: ${why}`);
  } finally {
    clearTimeout(timer);
  }
}

export async function getJson(url, opts) {
  const res = await request(url, opts);
  return res.json();
}

export async function getBuffer(url, opts) {
  const res = await request(url, opts);
  return Buffer.from(await res.arrayBuffer());
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
