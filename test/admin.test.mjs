import test from 'node:test';
import assert from 'node:assert/strict';
import { AdminApi } from '../src/admin.js';
import { MonitorEngine } from '../src/engine.js';
import { ChunkStorage } from '../src/coordinator.js';
import { DAY, MINUTE, getStatus } from '../src/monitor.js';

class State {
  values = new Map();
  async get(key) {
    if (Array.isArray(key)) return new Map(key.filter(k => this.values.has(k)).map(k => [k, structuredClone(this.values.get(k))]));
    return structuredClone(this.values.get(key));
  }
  async put(key, value) {
    if (typeof key === 'object') { for (const [k, v] of Object.entries(key)) await this.put(k, v); return; }
    this.values.set(key, structuredClone(value));
  }
  async delete(key) { this.values.delete(key); }
  async transaction(fn) { return fn(this); }
}
class Bucket {
  values = new Map();
  writes = 0;
  broken = false;
  async get(key) { const value = this.values.get(key); return value ? { etag: value.etag, json: async () => JSON.parse(value.text) } : null; }
  async put(key, text) { if (this.broken) throw new Error('R2 unavailable'); const value = { text, etag: String(++this.writes) }; this.values.set(key, value); return value; }
}
async function setup(env = {}) {
  const storage = new State();
  const fullEnv = { HISTORY: new Bucket(), ...env };
  const engine = new MonitorEngine(storage, fullEnv);
  await engine.init();
  const admin = new AdminApi(storage, engine, fullEnv);
  return { storage, env: fullEnv, engine, admin };
}
const req = (path, method = 'GET', body, cookie = '', origin = 'https://status.test', ip = '127.0.0.1') => new Request(`https://status.test/api/admin/${path}`, {
  method, headers: { Origin: origin, Cookie: cookie, 'CF-Connecting-IP': ip, 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}),
});
const ok = async () => new Response('OK');
const now = Date.UTC(2026, 9, 9, 12);

test('0000 logs in with an opaque HttpOnly session; settings require authentication and same origin', async () => {
  const { admin, engine } = await setup();
  assert.equal((await admin.handle(req('session'))).status, 401);
  assert.equal((await admin.handle(req('settings', 'PUT', { intervalSeconds: 5 }))).status, 401);
  assert.equal((await admin.handle(req('login', 'POST', { pin: '0000' }, '', 'https://evil.test'))).status, 403);
  const login = await admin.handle(req('login', 'POST', { pin: '0000' }));
  assert.equal(login.status, 200);
  const cookie = login.headers.get('Set-Cookie');
  assert.match(cookie, /HttpOnly/); assert.match(cookie, /SameSite=Strict/); assert.match(cookie, /Secure/);
  assert.equal((await admin.handle(req('session', 'GET', null, cookie.split(';')[0]))).status, 200);
  assert.equal((await admin.handle(req('settings', 'PUT', { intervalSeconds: 5 }, cookie.split(';')[0]))).status, 200);
  assert.equal(engine.state.intervalMs, 5000);
  assert.equal((await admin.handle(req('settings', 'PUT', { intervalSeconds: 0 }, cookie.split(';')[0]))).status, 400);
  await admin.handle(req('logout', 'POST', {}, cookie.split(';')[0]));
  assert.equal((await admin.handle(req('session', 'GET', null, cookie.split(';')[0]))).status, 401);
});

test('wrong PIN is rate limited and the limit survives object recreation', async () => {
  const { admin, storage, engine, env } = await setup();
  for (let i = 0; i < 5; i++) assert.equal((await admin.handle(req('login', 'POST', { pin: '9999' }))).status, 401);
  const recreated = new AdminApi(storage, engine, env);
  const locked = await recreated.handle(req('login', 'POST', { pin: '0000' }));
  assert.equal(locked.status, 429); assert.ok(Number(locked.headers.get('Retry-After')) > 0);
  assert.equal((await recreated.handle(req('login', 'POST', { pin: '0000' }, '', 'https://status.test', 'another-ip'))).status, 200);
});

test('changing ADMIN_PIN invalidates existing sessions; old PIN fails', async () => {
  const { admin, env } = await setup();
  const login = await admin.handle(req('login', 'POST', { pin: '0000' }));
  const cookie = login.headers.get('Set-Cookie').split(';')[0];
  env.ADMIN_PIN = '1234';
  assert.equal((await admin.handle(req('session', 'GET', null, cookie))).status, 401);
  assert.equal((await admin.handle(req('login', 'POST', { pin: '0000' }))).status, 401);
  assert.equal((await admin.handle(req('login', 'POST', { pin: '1234' }))).status, 200);
});

test('PIN input type, malformed JSON, methods, body size and session expiry are validated', async () => {
  const { admin, storage } = await setup();
  assert.equal((await admin.handle(req('login', 'GET'))).status, 405);
  assert.equal((await admin.handle(req('login', 'POST', { pin: 0 }))).status, 401);
  assert.equal((await admin.handle(req('login', 'POST', { pin: '0'.repeat(3000) }))).status, 413);
  assert.equal((await admin.handle(req('login', 'POST', []))).status, 401);
  const login = await admin.handle(req('login', 'POST', { pin: '0000' }));
  const auth = await storage.get('auth');
  for (const session of Object.values(auth.sessions)) session.expires = 0;
  await storage.put('auth', auth);
  assert.equal((await admin.handle(req('session', 'GET', null, login.headers.get('Set-Cookie').split(';')[0]))).status, 401);
});

test('second-level observations are preserved, then archived as accurate minute aggregates', async () => {
  const { engine, env, storage } = await setup();
  engine.state.startedAt = now;
  for (let i = 0; i < 60; i++) await engine.tick(now + i * 1000, i === 15 ? async () => new Response(null, { status: 503 }) : ok);
  assert.equal(env.HISTORY.writes, 0);
  const short = await engine.status('1m', now + 59000);
  assert.equal(short.services[0].samples, 60);
  assert.equal(short.services[0].uptime, 59 / 60 * 100);
  assert.equal(short.interval, 1000);
  await engine.tick(now + MINUTE, ok);
  assert.equal(env.HISTORY.writes, 1);
  const long = await engine.status('24h', now + MINUTE);
  assert.equal(long.services[0].samples, 61, 'hot and archived samples must not double count');
  const archived = await getStatus(env, '24h', now + MINUTE);
  assert.equal(archived.services[0].samples, 60);
  assert.equal(archived.services[0].uptime, 59 / 60 * 100);
  const restarted = new MonitorEngine(storage, env); await restarted.init();
  assert.equal((await restarted.status('1m', now + MINUTE)).services[0].samples, 60);
});

test('interval changes persist and coverage accounts for each observation interval', async () => {
  const { engine, storage, env } = await setup();
  engine.state.startedAt = now;
  await engine.tick(now, ok);
  await engine.setInterval(5);
  await engine.tick(now + 5000, ok);
  const status = await engine.status('1m', now + 5000);
  assert.equal(status.services[0].coverage, 10);
  const restarted = new MonitorEngine(storage, env); await restarted.init();
  assert.equal(restarted.state.intervalMs, 5000);
  await assert.rejects(() => engine.setInterval(2));
});

test('R2 failure retains pending archives and later recovers without losing samples', async () => {
  const { engine, env } = await setup();
  await engine.tick(now, ok);
  env.HISTORY.broken = true;
  await engine.tick(now + MINUTE, ok);
  assert.equal(Object.keys(engine.state.pending.api).length, 2);
  env.HISTORY.broken = false;
  await engine.tick(now + 2 * MINUTE, ok);
  assert.equal(Object.keys(engine.state.pending.api).length, 1);
  assert.equal((await getStatus(env, '24h', now + 2 * MINUTE)).services[0].samples, 2);
});

test('second-level and old minute-level records coexist across UTC days', async () => {
  const { engine, env } = await setup();
  await engine.tick(now - DAY, ok);
  await engine.tick(now, ok);
  assert.equal((await engine.status('30d', now)).services[0].samples, 2);
});

test('chunked storage round-trips large state at exact chunk boundaries and removes leftovers', async () => {
  const raw = new State(); const storage = new ChunkStorage(raw);
  for (const length of [100, 30000 * 64 - 2, 30000 * 65, 100]) {
    const value = 'x'.repeat(length);
    await storage.put('monitor', value);
    assert.equal(await storage.get('monitor'), value);
    assert.ok([...raw.values.values()].every(v => typeof v !== 'string' || v.length <= 30000));
  }
  assert.equal(raw.values.size, 2);
});
