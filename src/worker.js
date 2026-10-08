import { getStatus, runChecks, RANGES } from './monitor.js';
export { MonitorCoordinator } from './coordinator.js';

export async function handleApi(request, env) {
  const url = new URL(request.url);
  const headers = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };
  const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers });
  if (request.method !== 'GET') return new Response(null, { status: 405, headers: { ...headers, Allow: 'GET' } });
  if (url.pathname === '/api/health') return json({ ok: true });
  if (url.pathname !== '/api/status') return json({ error: 'Not found' }, 404);
  const range = url.searchParams.get('range') || '24h';
  if (!Object.hasOwn(RANGES, range)) return json({ error: 'Invalid time range' }, 400);
  try {
    const data = await getStatus(env, range);
    headers['Cache-Control'] = 'public, max-age=15, s-maxage=30';
    return json(data);
  } catch (error) {
    console.error('Status unavailable:', error.message);
    return json({ error: 'Monitoring data is temporarily unavailable' }, 503);
  }
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith('/api/')) return env.ASSETS.fetch(request);
    if (env.MONITOR) return env.MONITOR.get(env.MONITOR.idFromName('primary')).fetch(request);
    if (url.pathname !== '/api/status' || request.method !== 'GET') return handleApi(request, env);
    const range = url.searchParams.get('range') || '24h';
    if (!Object.hasOwn(RANGES, range)) return handleApi(request, env);
    // Normalize query strings so callers cannot create unlimited cache variants.
    const cacheKey = new Request(`${url.origin}/api/status?range=${range}`);
    const cache = caches.default;
    const hit = await cache.match(cacheKey);
    if (hit) return hit;
    const response = await handleApi(request, env);
    if (response.ok) ctx.waitUntil(cache.put(cacheKey, response.clone()));
    return response;
  },
  async scheduled(event, env) {
    if (env.MONITOR) {
      const response = await env.MONITOR.get(env.MONITOR.idFromName('primary')).fetch('https://monitor.internal/internal/wake');
      if (!response.ok) throw new Error('Unable to wake monitoring coordinator');
      return;
    }
    await runChecks(env, { now: event.scheduledTime });
  },
};
