// Checks for the parts that talk to the network, the disk and the OS:
// timeouts, retries, the download cache, housekeeping and the server itself.
// Uses a local HTTP server and temp folders only. Run: node test/robustness.js
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readdirSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DATA = mkdtempSync(path.join(tmpdir(), 'bisubs-data-'));
process.env.DATA_DIR = DATA;
process.env.CACHE_DIR = path.join(DATA, 'cache');
process.env.RESULTS_DIR = path.join(DATA, 'results');
process.env.LOGS_DIR = path.join(DATA, 'logs');
process.env.LOG_MAX_BYTES = '100';

const { getBuffer, getJson } = await import('../src/http.js');
const { runProcess } = await import('../src/align.js');
const { cached } = await import('../src/cache.js');
const { housekeeping } = await import('../src/housekeeping.js');

let passed = 0;
const test = async (name, fn) => {
  await fn();
  passed++;
  console.log(`ok - ${name}`);
};
const DAY = 24 * 3600 * 1000;
const age = (file, days) => {
  const t = new Date(Date.now() - days * DAY);
  utimesSync(file, t, t);
};

// A local server whose behaviour each test sets.
let handler = (req, res) => res.end('ok');
const hits = [];
const srv = http.createServer((req, res) => {
  hits.push(`${req.method} ${req.url}`);
  handler(req, res);
});
await new Promise((r) => srv.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${srv.address().port}`;

await test('a download that stalls after the headers times out', async () => {
  handler = (req, res) => {
    res.writeHead(200, { 'content-type': 'application/octet-stream' });
    res.write('abc'); // never finished
  };
  const started = Date.now();
  await assert.rejects(getBuffer(`${base}/stall`, { timeoutMs: 400 }), /timed out/);
  assert.ok(Date.now() - started < 3000, `took ${Date.now() - started} ms`);
});

await test('a GET is retried once after a 5xx; a POST is not', async () => {
  let n = 0;
  handler = (req, res) => {
    n++;
    if (n === 1) {
      res.writeHead(502);
      res.end('bad gateway');
    } else {
      res.setHeader('content-type', 'application/json');
      res.end('{"ok":true}');
    }
  };
  assert.deepEqual(await getJson(`${base}/flaky`), { ok: true });
  assert.equal(n, 2);
  n = 0;
  handler = (req, res) => {
    n++;
    res.writeHead(502);
    res.end('bad gateway');
  };
  await assert.rejects(getJson(`${base}/post`, { method: 'POST', body: '{}' }), /HTTP 502/);
  assert.equal(n, 1);
});

await test('a hung aligner process is killed', async () => {
  const started = Date.now();
  await assert.rejects(runProcess(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], 500), /timed out/);
  assert.ok(Date.now() - started < 5000);
});

await test('two jobs wanting the same download share one fetch', async () => {
  let fetches = 0;
  const fetchFiles = async () => {
    fetches++;
    await new Promise((r) => setTimeout(r, 100));
    return [{ name: 'a.srt', data: Buffer.from('1\n00:00:01,000 --> 00:00:02,000\nHi\n') }];
  };
  const [a, b] = await Promise.all([cached('test:pack', fetchFiles), cached('test:pack', fetchFiles)]);
  assert.equal(fetches, 1);
  assert.equal(a.files[0].name, 'a.srt');
  assert.equal(b.files[0].data.toString(), a.files[0].data.toString());
  const again = await cached('test:pack', fetchFiles);
  assert.equal(again.hit, true);
  assert.equal(fetches, 1);
  const [dir] = readdirSync(process.env.CACHE_DIR);
  assert.deepEqual(readdirSync(path.join(process.env.CACHE_DIR, dir)).sort(), ['0.bin', 'index.json']);
});

await test('housekeeping removes old downloads, old results and rotates the log', async () => {
  const oldDir = path.join(process.env.CACHE_DIR, 'old-entry');
  mkdirSync(oldDir, { recursive: true });
  writeFileSync(path.join(oldDir, 'index.json'), '{}');
  age(path.join(oldDir, 'index.json'), 40);
  const list = path.join(process.env.CACHE_DIR, 'anime-list-full.json');
  writeFileSync(list, '[]');
  age(list, 40);
  mkdirSync(process.env.RESULTS_DIR, { recursive: true });
  const r = (name, days) => {
    const f = path.join(process.env.RESULTS_DIR, name);
    writeFileSync(f, 'x');
    age(f, days);
    return f;
  };
  const oldSrt = r('aaaa.srt', 70);
  const newSrt = r('bbbb.srt', 5);
  const oldFail = r('cccc.fail.json', 2);
  mkdirSync(process.env.LOGS_DIR, { recursive: true });
  const logFile = path.join(process.env.LOGS_DIR, 'addon.log');
  writeFileSync(logFile, 'x'.repeat(500));

  const done = await housekeeping();
  assert.deepEqual(done, { cache: 1, results: 2, rotated: true });
  assert.equal(existsSync(oldDir), false);
  assert.equal(existsSync(list), true, 'the anime id list is not a cached download');
  assert.equal(readdirSync(process.env.CACHE_DIR).length, 2, 'the fresh download stays');
  assert.equal(existsSync(oldSrt), false);
  assert.equal(existsSync(newSrt), true);
  assert.equal(existsSync(oldFail), false);
  assert.equal(existsSync(`${logFile}.1`), true);
  assert.equal(existsSync(logFile), false);
});

srv.closeAllConnections?.();
srv.close();

await test('a URL with a broken %-sequence does not take the server down', async () => {
  const port = await new Promise((resolve) => {
    const s = net.createServer().listen(0, '127.0.0.1', () => {
      const p = s.address().port;
      s.close(() => resolve(p));
    });
  });
  const serverJs = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'server.js');
  // The fresh anime id list written above keeps the server from downloading one.
  const child = spawn(process.execPath, [serverJs], {
    env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', ADDON_TOKEN: 't0k', PUBLIC_URL: '' },
    stdio: 'ignore',
  });
  try {
    const url = `http://127.0.0.1:${port}`;
    let up = false;
    for (let i = 0; i < 50 && !up; i++) {
      up = await fetch(`${url}/health`).then((x) => x.ok, () => false);
      if (!up) await new Promise((r) => setTimeout(r, 200));
    }
    assert.ok(up, 'server did not start');
    const bad = await fetch(`${url}/t0k/%E0%A4%A`);
    assert.ok(bad.status >= 400 && bad.status < 500, `status ${bad.status}`);
    await new Promise((r) => setTimeout(r, 500));
    assert.equal((await fetch(`${url}/health`)).status, 200, 'server died after the malformed URL');
    assert.equal((await fetch(`${url}/t0k/manifest.json`)).status, 200);
    assert.equal((await fetch(`${url}/manifest.json`)).status, 404, 'no access without the token');
  } finally {
    child.kill();
  }
});

console.log(`\n${passed} passed`);
process.exit(0);
