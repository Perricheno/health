export const MINUTE = 60_000;
export const DAY = 86_400_000;
export const RANGES = { '1m': MINUTE, '5m': 5 * MINUTE, '24h': DAY, '7d': 7 * DAY, '30d': 30 * DAY };
const DEFAULT_SERVICES = '[{"id":"api","name":"API (api.perricheno.com)","url":"https://api.perricheno.com"}]';

export function parseServices(env) {
  const values = JSON.parse(env.SERVICES_JSON || DEFAULT_SERVICES);
  if (!Array.isArray(values) || values.length > 20) throw new Error('SERVICES_JSON must be an array of up to 20 services');
  const ids = new Set();
  return values.map(value => {
    const { id, name, url, headers = {}, method = 'GET', expectedStatus, timeoutMs = 10000, degradedMs = 1500 } = value;
    if (!/^[a-z0-9_-]{1,64}$/.test(id) || ['__proto__', 'constructor', 'prototype'].includes(id) || ids.has(id)) throw new Error('Service IDs must be unique and URL-safe');
    ids.add(id);
    const target = new URL(url);
    if (!['https:', 'http:'].includes(target.protocol) || target.username || target.password) throw new Error(`Invalid URL for ${id}`);
    if (typeof name !== 'string' || !name.trim() || name.length > 120) throw new Error(`Invalid name for ${id}`);
    if (!['GET', 'HEAD'].includes(method)) throw new Error(`Invalid method for ${id}`);
    if (!Number.isFinite(timeoutMs) || timeoutMs < 100 || timeoutMs > 15000) throw new Error(`Invalid timeout for ${id}`);
    if (!Number.isFinite(degradedMs) || degradedMs < 1 || degradedMs > timeoutMs) throw new Error(`Invalid degraded threshold for ${id}`);
    if (expectedStatus !== undefined && (!Number.isInteger(expectedStatus) || expectedStatus < 100 || expectedStatus > 599)) throw new Error(`Invalid expected status for ${id}`);
    if (!headers || typeof headers !== 'object' || Array.isArray(headers) || Object.values(headers).some(v => typeof v !== 'string')) throw new Error(`Invalid headers for ${id}`);
    new Headers(headers);
    return { id, name: name.trim(), url: target.href, headers, method, expectedStatus, timeoutMs, degradedMs };
  });
}

export async function probe(service, fetcher = fetch, now = Date.now()) {
  const start = performance.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), service.timeoutMs);
  try {
    const response = await fetcher(service.url, {
      method: service.method, headers: { 'User-Agent': 'Perricheno-Health/1.0', ...service.headers },
      signal: controller.signal, redirect: 'manual', cache: 'no-store',
    });
    const latency = Math.round(performance.now() - start);
    if (response.body) await response.body.cancel();
    const ok = service.expectedStatus === undefined ? response.status >= 200 && response.status < 400 : response.status === service.expectedStatus;
    return { time: now, status: ok ? (latency >= service.degradedMs ? 'degraded' : 'operational') : 'down', latency, code: response.status };
  } catch {
    return { time: now, status: 'down', latency: Math.round(performance.now() - start), code: null, reason: controller.signal.aborted ? 'timeout' : 'connection' };
  } finally { clearTimeout(timer); }
}

const dayKey = time => `history/${new Date(time).toISOString().slice(0, 10)}.json`;

// Compare-and-swap avoids losing observations if scheduled invocations overlap.
export async function runChecks(env, { now = Date.now(), fetcher = fetch } = {}) {
  const services = parseServices(env);
  const checks = [];
  for (let i = 0; i < services.length; i += 5) {
    checks.push(...await Promise.all(services.slice(i, i + 5).map(async service => [service.id, await probe(service, fetcher, now)])));
  }
  const key = dayKey(now);
  for (let attempt = 0; attempt < 5; attempt++) {
    const object = await env.HISTORY.get(key);
    const day = object ? await object.json() : {};
    for (const [id, check] of checks) {
      const points = day[id] || [];
      // A duplicate delivery for one cron minute is one observation.
      const slot = Math.floor(check.time / MINUTE);
      day[id] = [...points.filter(p => Math.floor(p.time / MINUTE) !== slot), check].sort((a, b) => a.time - b.time);
    }
    const written = await env.HISTORY.put(key, JSON.stringify(day), {
      httpMetadata: { contentType: 'application/json' },
      onlyIf: object ? { etagMatches: object.etag } : { etagDoesNotMatch: '*' },
    });
    if (written) return checks;
  }
  throw new Error('History write conflicted repeatedly');
}

function accumulator(range, now) {
  const start = now - RANGES[range];
  const bars = Array.from({ length: 48 }, (_, index) => ({
    from: start + RANGES[range] * index / 48, to: start + RANGES[range] * (index + 1) / 48,
    status: 'unknown', samples: 0, uptime: null, latency: null, code: null,
  }));
  const totals = bars.map(() => ({ good: 0, latency: 0, last: -1 }));
  let count = 0, good = 0, latency = 0, latest = null;
  return {
    add(point) {
      if (point.time > now) return;
      if (!latest || point.time > latest.time) latest = point;
      if (point.time <= start) return;
      const index = Math.min(47, Math.floor((point.time - start) / RANGES[range] * 48));
      const bar = bars[index], total = totals[index];
      count++; bar.samples++; latency += point.latency; total.latency += point.latency;
      if (point.status !== 'down') { good++; total.good++; }
      if (bar.status === 'unknown' || point.status === 'down' || point.status === 'degraded' && bar.status !== 'down') bar.status = point.status;
      if (point.time >= total.last) { bar.code = point.code; bar.reason = point.reason; total.last = point.time; }
    },
    finish() {
      bars.forEach((bar, index) => {
        if (bar.samples) { bar.uptime = totals[index].good / bar.samples * 100; bar.latency = Math.round(totals[index].latency / bar.samples); }
      });
      return { latest, summary: { uptime: count ? good / count * 100 : null, samples: count,
        latency: count ? Math.round(latency / count) : null, coverage: Math.min(100, count / (RANGES[range] / MINUTE) * 100), bars } };
    },
  };
}

export function summarize(points, range, now) {
  const acc = accumulator(range, now);
  points.forEach(point => acc.add(point));
  return acc.finish().summary;
}

export async function getStatus(env, range = '24h', now = Date.now()) {
  const services = parseServices(env);
  if (!Object.hasOwn(RANGES, range)) throw new Error('Invalid range');
  const start = Math.floor((now - Math.max(RANGES[range], DAY)) / DAY) * DAY;
  const keys = [];
  for (let t = start; t <= now; t += DAY) keys.push(dayKey(t));
  // At most four daily objects in memory at once, even for 30-day requests.
  const accum = Object.fromEntries(services.map(s => [s.id, accumulator(range, now)]));
  for (let i = 0; i < keys.length; i += 4) {
    const days = await Promise.all(keys.slice(i, i + 4).map(async key => {
      const object = await env.HISTORY.get(key);
      return object ? object.json() : {};
    }));
    for (const day of days) for (const service of services) for (const point of day[service.id] || []) accum[service.id].add(point);
  }
  const result = services.map(({ id, name }) => {
    const { latest: last, summary } = accum[id].finish();
    return { id, name, status: last && now - last.time <= 3 * MINUTE ? last.status : 'unknown',
      checkedAt: last?.time ?? null, ...summary };
  });
  const overall = result.some(s => s.status === 'down') ? 'down' : result.some(s => s.status === 'degraded') ? 'degraded' : !result.length || result.some(s => s.status === 'unknown') ? 'unknown' : 'operational';
  return { siteName: String(env.SITE_NAME || 'perricheno').slice(0, 80), range, now, interval: MINUTE, overall,
    updatedAt: Math.max(0, ...result.map(s => s.checkedAt || 0)) || null, services: result };
}
