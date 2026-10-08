import test from 'node:test';
import assert from 'node:assert/strict';
import { MINUTE, DAY, parseServices, probe, summarize, getStatus, runChecks } from '../src/monitor.js';
import { handleApi } from '../src/worker.js';

class MemoryBucket {
  objects = new Map();
  version = 0;
  async get(key) {
    const object = this.objects.get(key);
    return object ? { etag: object.etag, json: async () => JSON.parse(object.text) } : null;
  }
  async put(key, text, options = {}) {
    const current = this.objects.get(key);
    if (options.onlyIf?.etagMatches && current?.etag !== options.onlyIf.etagMatches) return null;
    if (options.onlyIf?.etagDoesNotMatch === '*' && current) return null;
    const object = { text, etag: String(++this.version) };
    this.objects.set(key, object);
    return object;
  }
}
const now = Date.UTC(2026, 9, 8, 12, 0, 0);
const point = (time, status = 'operational', latency = 100) => ({ time, status, latency, code: status === 'down' ? 503 : 200 });
const ok = async () => new Response('ok', { status: 200 });
const makeEnv = () => ({ HISTORY: new MemoryBucket() });

test('config rejects duplicate IDs, unsafe protocols and invalid thresholds', () => {
  const service = { id: 'api', name: 'API', url: 'https://example.com' };
  for (const entries of [[service, service], [{ ...service, id: '__proto__' }], [{ ...service, url: 'file:///etc/passwd' }], [{ ...service, timeoutMs: 99000 }], [{ ...service, headers: { X: 3 } }]]) {
    assert.throws(() => parseServices({ SERVICES_JSON: JSON.stringify(entries) }));
  }
  assert.equal(parseServices({})[0].url, 'https://api.perricheno.com/');
});

test('probes distinguish HTTP errors, custom expected status, network failures and timeouts', async () => {
  const service = parseServices({})[0];
  assert.equal((await probe(service, ok, now)).status, 'operational');
  assert.equal((await probe(service, async () => new Response(null, { status: 503 }), now)).status, 'down');
  assert.equal((await probe({ ...service, expectedStatus: 401 }, async () => new Response(null, { status: 401 }), now)).status, 'operational');
  assert.equal((await probe(service, async () => { throw new Error('secret network detail'); }, now)).reason, 'connection');
  const timeout = await probe({ ...service, timeoutMs: 10 }, (_url, options) => new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => reject(new Error('aborted')))), now);
  assert.equal(timeout.reason, 'timeout');
});

test('slow successful probes are degraded and redirects do not forward private headers', async () => {
  const service = { ...parseServices({})[0], degradedMs: 1, headers: { Authorization: 'secret' } };
  const result = await probe(service, async (_url, options) => {
    assert.equal(options.redirect, 'manual');
    await new Promise(resolve => setTimeout(resolve, 5));
    return new Response(null, { status: 302 });
  }, now);
  assert.equal(result.status, 'degraded');
});

test('empty history is unknown, not 100% uptime', () => {
  const result = summarize([], '24h', now);
  assert.equal(result.uptime, null);
  assert.equal(result.coverage, 0);
  assert.ok(result.bars.every(bar => bar.status === 'unknown'));
});

test('uptime uses actual observations, preserves outages and excludes future/out-of-window points', () => {
  const result = summarize([point(now - 5000), point(now - 4000, 'down'), point(now - 3000, 'degraded'), point(now - 2 * DAY, 'down'), point(now + 1000, 'down')], '24h', now);
  assert.equal(result.samples, 3);
  assert.equal(result.uptime, 2 / 3 * 100);
  assert.equal(result.bars.at(-1).status, 'down');
  assert.equal(result.bars.at(-1).samples, 3);
  assert.equal(result.bars.filter(bar => bar.status === 'unknown').length, 47);
});

test('cron deliveries within the same minute are deduplicated', async () => {
  const env = makeEnv();
  await runChecks(env, { now, fetcher: ok });
  await runChecks(env, { now: now + 1000, fetcher: ok });
  const status = await getStatus(env, '24h', now + 2000);
  assert.equal(status.services[0].samples, 1);
  assert.equal(status.overall, 'operational');
});

test('overlapping scheduled writes preserve both observations with compare-and-swap', async () => {
  const env = makeEnv();
  await Promise.all([runChecks(env, { now, fetcher: ok }), runChecks(env, { now: now + MINUTE, fetcher: ok })]);
  const status = await getStatus(env, '24h', now + MINUTE);
  assert.equal(status.services[0].samples, 2);
});

test('stale checks turn current status unknown without erasing measured uptime', async () => {
  const env = makeEnv();
  await runChecks(env, { now, fetcher: ok });
  const status = await getStatus(env, '24h', now + 4 * MINUTE);
  assert.equal(status.overall, 'unknown');
  assert.equal(status.services[0].uptime, 100);
});

test('history spans UTC midnight and 30-day ranges', async () => {
  const env = makeEnv();
  for (const time of [now - 29 * DAY, now - 12 * 3600000 - MINUTE, now]) await runChecks(env, { now: time, fetcher: ok });
  const long = await getStatus(env, '30d', now);
  assert.equal(long.services[0].samples, 3);
  assert.equal((await getStatus(env, '24h', now)).services[0].samples, 2);
});

test('public output never exposes monitoring URLs or authorization headers', async () => {
  const env = { ...makeEnv(), SERVICES_JSON: JSON.stringify([{ id: 'private', name: 'Public service name', url: 'https://secret.example/private?token=secret-token', headers: { Authorization: 'Bearer private-token' } }]) };
  await runChecks(env, { now, fetcher: ok });
  const text = JSON.stringify(await getStatus(env, '24h', now));
  assert.ok(text.includes('Public service name'));
  assert.ok(!/secret|private-token|Authorization|https:/.test(text));
});

test('API validates ranges/methods, handles storage errors and never triggers probes', async () => {
  const env = makeEnv();
  assert.equal((await handleApi(new Request('https://status.test/api/status?range=__proto__'), env)).status, 400);
  assert.equal((await handleApi(new Request('https://status.test/api/status', { method: 'POST' }), env)).status, 405);
  assert.equal((await handleApi(new Request('https://status.test/api/nope'), env)).status, 404);
  const response = await handleApi(new Request('https://status.test/api/status'), env);
  assert.equal(response.status, 200);
  assert.equal((await response.json()).overall, 'unknown');
  assert.equal(env.HISTORY.objects.size, 0);
  const broken = { HISTORY: { get: async () => { throw new Error('storage unreachable'); } } };
  assert.equal((await handleApi(new Request('https://status.test/api/status'), broken)).status, 503);
});

test('removing services hides their retained history and an empty configuration stays unknown', async () => {
  const env = makeEnv();
  await runChecks(env, { now, fetcher: ok });
  env.SERVICES_JSON = '[]';
  const result = await getStatus(env, '24h', now);
  assert.equal(result.services.length, 0);
  assert.equal(result.overall, 'unknown');
});
