import { MonitorEngine } from './engine.js';
import { AdminApi } from './admin.js';
import { RANGES } from './monitor.js';
import { DeploymentStore } from './deployments.js';

// Chunk JSON to stay below Durable Object KV's per-value limit with many services.
export class ChunkStorage {
  constructor(storage) { this.storage = storage; }
  async get(key) {
    const count = await this.storage.get(`${key}:length`);
    if (!count) return undefined;
    const keys = Array.from({ length: count }, (_, i) => `${key}:${i}`);
    const chunks = new Map();
    for (let i = 0; i < keys.length; i += 64) for (const [k, value] of await this.storage.get(keys.slice(i, i + 64))) chunks.set(k, value);
    return JSON.parse(keys.map(k => chunks.get(k)).join(''));
  }
  async put(key, value) {
    const text = JSON.stringify(value);
    const count = Math.ceil(text.length / 30000);
    const entries = { [`${key}:length`]: count };
    for (let i = 0; i < count; i++) entries[`${key}:${i}`] = text.slice(i * 30000, (i + 1) * 30000);
    // SQL-backed KV persists all chunks and the manifest in one transaction.
    await this.storage.transaction(async txn => {
      const previous = await txn.get(`${key}:length`) || 0;
      const values = Object.entries(entries);
      for (let i = 0; i < values.length; i += 64) await txn.put(Object.fromEntries(values.slice(i, i + 64)));
      for (let i = count; i < previous; i++) await txn.delete(`${key}:${i}`);
    });
  }
}

export async function monitorRequest(request, engine, admin, deployments) {
  const url = new URL(request.url);
  if (url.pathname.startsWith('/api/admin/')) return admin.handle(request);
  if (url.pathname === '/api/deployments/ingest' && deployments) return deployments.ingest(request);
  const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });
  if (request.method !== 'GET') return new Response(null, { status: 405, headers: { Allow: 'GET' } });
  if (url.pathname === '/api/health') return json({ ok: true });
  if (url.pathname === '/api/deployments' && deployments) return json(deployments.snapshot());
  if (url.pathname === '/api/deployments/stream' && deployments) return deployments.stream();
  if (url.pathname === '/api/live') return json(engine.live());
  if (url.pathname !== '/api/status') return json({ error: 'Not found' }, 404);
  const range = url.searchParams.get('range') || '24h';
  if (!Object.hasOwn(RANGES, range)) return json({ error: 'Invalid time range' }, 400);
  try { return json(await engine.status(range)); }
  catch (error) { console.error('Status unavailable:', error.message); return json({ error: 'Monitoring data is temporarily unavailable' }, 503); }
}

export class MonitorCoordinator {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
    const storage = new ChunkStorage(ctx.storage);
    this.engine = new MonitorEngine(storage, env);
    this.deployments = new DeploymentStore(storage, env);
    this.admin = new AdminApi(storage, this.engine, env, this.deployments);
    this.ready = ctx.blockConcurrencyWhile(() => Promise.all([this.engine.init(), this.deployments.init()]));
    this.running = false;
  }
  async wake() {
    if (this.running) return;
    const alarm = await this.ctx.storage.getAlarm();
    if (alarm === null || alarm < Date.now() - 90000) await this.ctx.storage.setAlarm(Date.now() + 10);
  }
  async fetch(request) {
    await this.ready;
    await this.wake();
    if (new URL(request.url).pathname === '/internal/wake') return new Response('OK');
    const response = await monitorRequest(request, this.engine, this.admin, this.deployments);
    if (request.method === 'PUT' && response.ok && !this.running) await this.ctx.storage.setAlarm(Date.now() + 10);
    return response;
  }
  async alarm() {
    await this.ready;
    if (this.running) return;
    this.running = true;
    const started = Date.now();
    try { await this.engine.tick(started); }
    finally {
      this.running = false;
      await this.ctx.storage.setAlarm(Math.max(Date.now() + 20, started + this.engine.state.intervalMs));
    }
  }
}
