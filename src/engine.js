import { MINUTE, parseServices, probe, rollup, archivePoints, getStatus } from './monitor.js';

export const INTERVALS = [1, 5, 10, 30, 60];
export class MonitorEngine {
  constructor(storage, env) { this.storage = storage; this.env = env; this.queue = Promise.resolve(); this.cache = new Map(); }
  async init() {
    this.state = await this.storage.get('monitor') || { intervalMs: 1000, startedAt: Date.now(), recent: {}, pending: {}, latest: {} };
  }
  serial(callback) {
    const result = this.queue.then(callback);
    this.queue = result.catch(() => {});
    return result;
  }
  async setInterval(seconds) {
    if (!INTERVALS.includes(seconds)) throw new Error('Invalid interval');
    return this.serial(async () => {
      this.state.intervalMs = seconds * 1000;
      await this.storage.put('monitor', this.state);
      this.cache.clear();
    });
  }
  tick(now = Date.now(), fetcher = fetch) {
    return this.serial(async () => {
      const services = parseServices(this.env);
      const intervalMs = this.state.intervalMs;
      const checks = [];
      for (let i = 0; i < services.length; i += 5) {
        checks.push(...await Promise.all(services.slice(i, i + 5).map(async service => [service.id, { ...await probe(service, fetcher, now), intervalMs }])));
      }
      for (const [id, point] of checks) {
        if (this.state.latest[id]?.time >= point.time) continue;
        this.state.latest[id] = point;
        this.state.recent[id] = [...(this.state.recent[id] || []), point].filter(p => p.time >= Math.floor((now - 6 * MINUTE) / MINUTE) * MINUTE);
        this.state.pending[id] = rollup([point], this.state.pending[id] || {});
      }
      // Persist recent second-resolution data before attempting the R2 archive.
      await this.storage.put('monitor', this.state);
      this.cache.delete('1m'); this.cache.delete('5m');
      const minute = Math.floor(now / MINUTE);
      if (this.lastArchiveAttempt === minute) return;
      this.lastArchiveAttempt = minute;
      const completed = {};
      for (const [id, entries] of Object.entries(this.state.pending)) {
        const points = Object.entries(entries).filter(([slot]) => Number(slot) < minute).map(([, point]) => point);
        if (points.length) completed[id] = points;
      }
      if (!Object.keys(completed).length) return;
      try {
        await archivePoints(this.env, completed);
        for (const [id, points] of Object.entries(completed)) for (const p of points) delete this.state.pending[id][Math.floor(p.time / MINUTE)];
        await this.storage.put('monitor', this.state);
        this.cache.clear();
      } catch (error) { console.error('History archive delayed:', error.message); }
    });
  }
  async status(range, now = Date.now()) {
    const cached = this.cache.get(range);
    if (cached && now - cached.time < (['1m', '5m'].includes(range) ? 900 : 30000)) return cached.data;
    const snapshot = structuredClone(this.state);
    const data = await getStatus(this.env, range, now, snapshot);
    this.cache.set(range, { time: now, data });
    return data;
  }
  live(now = Date.now()) {
    const stale = Math.max(15000, this.state.intervalMs * 3);
    const services = parseServices(this.env).map(({ id }) => {
      const last = this.state.latest[id];
      return { id, status: last && now - last.time <= stale ? last.status : 'unknown', checkedAt: last?.time || null, latency: last?.latency ?? null };
    });
    const overall = services.some(s => s.status === 'down') ? 'down' : services.some(s => s.status === 'degraded') ? 'degraded' : !services.length || services.some(s => s.status === 'unknown') ? 'unknown' : 'operational';
    return { now, interval: this.state.intervalMs, overall, updatedAt: Math.max(0, ...services.map(s => s.checkedAt || 0)) || null, services };
  }
}
