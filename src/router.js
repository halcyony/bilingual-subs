import querystring from 'node:querystring';
import express from 'express';

// The Stremio add-on protocol over HTTP, in place of stremio-addon-sdk's
// router (whose dependencies carried the npm audit findings). Same routes and
// answers:
//   GET /manifest.json
//   GET /<resource>/<type>/<id>.json
//   GET /<resource>/<type>/<id>/<extra>.json   extra = "filename=...&videoSize=..."
// Every answer allows any origin (players fetch from web pages too), and a
// handler's cacheMaxAge becomes "Cache-Control: max-age=N, public".
const RESOURCE = /^\/([^/]+)\/([^/]+)\/([^/]+?)(?:\/([^/]+))?\.json$/;

export function addonRouter(addon) {
  const router = express.Router();
  router.use((req, res, next) => {
    res.set('Access-Control-Allow-Origin', '*');
    if (req.method !== 'OPTIONS') return next();
    res.set('Access-Control-Allow-Methods', 'GET,HEAD,OPTIONS');
    const asked = req.get('access-control-request-headers');
    if (asked) res.set('Access-Control-Allow-Headers', asked);
    res.status(204).end();
  });
  const manifest = JSON.stringify(addon.manifest);
  router.get('/manifest.json', (req, res) => res.type('application/json; charset=utf-8').send(manifest));
  router.get(RESOURCE, async (req, res, next) => {
    // req.path is still %-encoded; the id is decoded, and extra is read as a
    // query string so an encoded "&" inside a file name stays in the name.
    let resource, type, id;
    try {
      [resource, type, id] = req.path.match(RESOURCE).slice(1, 4).map(decodeURIComponent);
    } catch {
      return res.status(400).end();
    }
    const rawExtra = req.path.match(RESOURCE)[4];
    const extra = rawExtra ? { ...querystring.parse(rawExtra) } : {};
    let resp;
    try {
      resp = await addon.get(resource, type, id, extra);
    } catch (e) {
      if (e.noHandler) return next();
      console.error(e);
      return res.status(500).json({ err: 'handler error' });
    }
    const cache = [
      ['cacheMaxAge', 'max-age'],
      ['staleRevalidate', 'stale-while-revalidate'],
      ['staleError', 'stale-if-error'],
    ]
      .filter(([k]) => Number.isInteger(resp[k]))
      .map(([k, name]) => `${name}=${resp[k]}`);
    if (cache.length) res.set('Cache-Control', `${cache.join(', ')}, public`);
    res.type('application/json; charset=utf-8').send(JSON.stringify(resp));
  });
  return router;
}
