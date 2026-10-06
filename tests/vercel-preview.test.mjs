import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { wf, between } from './helpers.mjs';

const script = between(wf('vercel-preview.yml'), 'vercel-preview');
const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;

async function serve(handler) {
  const srv = http.createServer(handler);
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${srv.address().port}`, close: () => srv.close() };
}

async function run(url, env = {}) {
  const log = { failed: null, errors: [], warnings: [], summary: '' };
  const core = {
    warning: (m) => log.warnings.push(m), error: (m) => log.errors.push(m), setFailed: (m) => { log.failed = m; },
    summary: { addRaw(s) { log.summary += s; return this; }, async write() {} },
  };
  Object.assign(process.env, { URL: url, PATHS: '/', STRICT: 'false', BYPASS: '', ...env });
  await new AsyncFunction('core', script)(core);
  return log;
}

const SECURE = {
  'strict-transport-security': 'max-age=63072000',
  'x-content-type-options': 'nosniff',
  'content-security-policy': "default-src 'self'; frame-ancestors 'none'",
  'referrer-policy': 'strict-origin-when-cross-origin',
  'permissions-policy': 'camera=()',
};

test('preview with all headers, SPA fallback returning 200 for /.env (HTML) → pass', async () => {
  const s = await serve((req, res) => { res.writeHead(200, { ...SECURE, 'content-type': 'text/html' }); res.end('<html>app</html>'); });
  try {
    const log = await run(s.url);
    assert.equal(log.failed, null, log.errors.join('\n'));
    assert.equal(log.warnings.length, 0);
  } finally { s.close(); }
});

test('missing required headers + exposed .env + X-Powered-By → fail', async () => {
  const s = await serve((req, res) => {
    if (req.url === '/.env') { res.writeHead(200, { 'content-type': 'text/plain' }); return res.end('SUPABASE_SERVICE_ROLE_KEY=eyJ...\n'); }
    res.writeHead(200, { 'x-powered-by': 'Next.js', 'content-type': 'text/html' }); res.end('ok');
  });
  try {
    const log = await run(s.url);
    assert.match(log.failed, /4 security issues/); // HSTS, nosniff, clickjacking, /.env
    assert.ok(log.errors.some((e) => /\/\.env is publicly accessible/.test(e)));
    assert.ok(log.warnings.some((w) => /X-Powered-By/.test(w)));
    assert.ok(log.warnings.some((w) => /Content-Security-Policy/.test(w)));
  } finally { s.close(); }
});

test('Deployment Protection: 401 without the bypass, sends the right header when the secret is set', async () => {
  const s = await serve((req, res) => {
    if (req.headers['x-vercel-protection-bypass'] !== 's3cret') { res.writeHead(401); return res.end(); }
    res.writeHead(200, SECURE); res.end('ok');
  });
  try {
    assert.ok((await run(s.url)).errors.some((e) => /VERCEL_AUTOMATION_BYPASS_SECRET/.test(e)));
    assert.equal((await run(s.url, { BYPASS: 's3cret' })).failed, null);
  } finally { s.close(); }
});
