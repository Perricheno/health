import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { parseServices } from '../src/monitor.js';
import { MonitorEngine } from '../src/engine.js';
import { AdminApi } from '../src/admin.js';
import { monitorRequest } from '../src/coordinator.js';
import { FileState } from './state.mjs';
import { FileBucket } from './storage.mjs';

const bucket = new FileBucket(process.env.DATA_DIR || './data');
const env = { ...process.env, HISTORY: bucket };
parseServices(env); // Fail fast on an invalid configuration.
const state = new FileState(process.env.DATA_DIR || './data');
const engine = new MonitorEngine(state, env);
await engine.init();
const admin = new AdminApi(state, engine, env);
const publicDir = fileURLToPath(new URL('../public/', import.meta.url));
const types = { '/admin.js': 'text/javascript; charset=utf-8', '/index.html': 'text/html; charset=utf-8', '/styles.css': 'text/css; charset=utf-8', '/app.js': 'text/javascript; charset=utf-8', '/theme.js': 'text/javascript; charset=utf-8', '/favicon.svg': 'image/svg+xml', '/vendor/morphicons.js': 'text/javascript; charset=utf-8', '/fonts/InterVariable.woff2': 'font/woff2' };
let checking = false, stopping = false, timer, cleanupAt = 0;
async function check() {
  if (checking) return;
  checking = true;
  const started = Date.now();
  try {
    await engine.tick(started);
    if (started - cleanupAt > 3600000) { await bucket.cleanup(); cleanupAt = started; }
  }
  catch (error) { console.error('Monitor failed:', error.message); }
  finally { checking = false; if (!stopping) timer = setTimeout(check, Math.max(20, started + engine.state.intervalMs - Date.now())); }
}
const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname.startsWith('/api/')) {
      const origin = process.env.PUBLIC_ORIGIN || `http://${req.headers.host || 'localhost'}`;
      const headers = new Headers(req.headers);
      headers.set('CF-Connecting-IP', req.socket.remoteAddress || 'local');
      const requestUrl = new URL(req.url, origin);
      let body;
      if (!['GET', 'HEAD'].includes(req.method)) {
        const chunks = []; let size = 0;
        for await (const chunk of req) { size += chunk.length; if (size > 2048) { res.writeHead(413); res.end(); return; } chunks.push(chunk); }
        body = Buffer.concat(chunks);
      }
      const response = await monitorRequest(new Request(requestUrl, { method: req.method, headers, ...(body ? { body } : {}) }), engine, admin);
      res.writeHead(response.status, Object.fromEntries(response.headers));
      res.end(await response.text());
      if (req.method === 'PUT' && response.ok && !checking) { clearTimeout(timer); timer = setTimeout(check, 20); }
      return;
    }
    if (!['GET', 'HEAD'].includes(req.method)) { res.writeHead(405, { Allow: 'GET, HEAD' });res.end();return; }
    const pathname = url.pathname === '/' ? '/index.html' : url.pathname;
    if (!Object.hasOwn(types, pathname)) { res.writeHead(404);res.end('Not found');return; }
    const content = await readFile(`${publicDir}${pathname.slice(1)}`);
    res.writeHead(200, {
      'Content-Type': types[pathname], 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY', 'Referrer-Policy': 'strict-origin-when-cross-origin',
      'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
    });
    res.end(req.method === 'HEAD' ? undefined : content);
  } catch (error) { console.error('Request failed:', error.message);res.writeHead(500);res.end('Internal server error'); }
});
const port = Number(process.env.PORT || 8787);
server.listen(port, process.env.HOST || '0.0.0.0', () => console.log(`Health listening on http://localhost:${port}`));
await check();
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { stopping = true; clearTimeout(timer);server.close(() => process.exit(0)); });
