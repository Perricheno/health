import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { handleApi } from '../src/worker.js';
import { parseServices, runChecks } from '../src/monitor.js';
import { FileBucket } from './storage.mjs';

const bucket = new FileBucket(process.env.DATA_DIR || './data');
const env = { ...process.env, HISTORY: bucket };
parseServices(env); // Fail fast on an invalid configuration.
const publicDir = fileURLToPath(new URL('../public/', import.meta.url));
const types = { '/index.html': 'text/html; charset=utf-8', '/styles.css': 'text/css; charset=utf-8', '/app.js': 'text/javascript; charset=utf-8', '/theme.js': 'text/javascript; charset=utf-8', '/favicon.svg': 'image/svg+xml', '/vendor/morphicons.js': 'text/javascript; charset=utf-8', '/fonts/InterVariable.woff2': 'font/woff2' };
let checking = false;
async function check() {
  if (checking) return;
  checking = true;
  try { await runChecks(env); await bucket.cleanup(); }
  catch (error) { console.error('Monitor failed:', error.message); }
  finally { checking = false; }
}
const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname.startsWith('/api/')) {
      const response = await handleApi(new Request(url, { method: req.method }), env);
      res.writeHead(response.status, Object.fromEntries(response.headers));
      res.end(await response.text());
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
const timer = setInterval(check, 60000);
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { clearInterval(timer);server.close(() => process.exit(0)); });
