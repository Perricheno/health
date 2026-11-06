import { INTERVALS } from './engine.js';
const SESSION_MS = 12 * 60 * 60 * 1000;
const WINDOW_MS = 15 * 60 * 1000;
const digest = async text => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)))].map(n => n.toString(16).padStart(2, '0')).join('');
const response = (data, status = 200, headers = {}) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...headers } });

export class AdminApi {
  constructor(storage, engine, env, deployments) { this.storage = storage; this.engine = engine; this.env = env; this.deployments = deployments; this.queue = Promise.resolve(); }
  handle(request) {
    const result = this.queue.then(() => this.process(request));
    this.queue = result.catch(() => {});
    return result;
  }
  async process(request) {
    const url = new URL(request.url);
    const method = request.method;
    const path = url.pathname;
    if (!['/api/admin/session', '/api/admin/login', '/api/admin/logout', '/api/admin/settings', '/api/admin/deploy-token', '/api/admin/penall-approve'].includes(path)) return response({ error: 'Not found' }, 404);
    const allowed = path === '/api/admin/session' ? 'GET' : path === '/api/admin/settings' ? 'PUT' : 'POST';
    if (method !== allowed) return response({ error: 'Method not allowed' }, 405, { Allow: allowed });
    if (method !== 'GET' && (request.headers.get('Origin') !== url.origin || request.headers.get('Sec-Fetch-Site') === 'cross-site')) return response({ error: 'Invalid origin' }, 403);
    const now = Date.now();
    const pin = this.env.ADMIN_PIN || '0000';
    if (!/^\d{4}$/.test(pin)) return response({ error: 'Admin PIN is not configured correctly' }, 503);
    const fingerprint = await digest(pin);
    const auth = await this.storage.get('auth') || { sessions: {}, failures: {}, global: [] };
    for (const [token, session] of Object.entries(auth.sessions)) if (session.expires <= now || session.pin !== fingerprint) delete auth.sessions[token];
    for (const [ip, failures] of Object.entries(auth.failures)) {
      auth.failures[ip] = failures.filter(t => t > now - WINDOW_MS);
      if (!auth.failures[ip].length) delete auth.failures[ip];
    }
    auth.global = auth.global.filter(t => t > now - 60000);
    const sessionToken = request.headers.get('Cookie')?.match(/(?:^|;\s*)health_admin=([a-f0-9]{64})(?:;|$)/)?.[1];
    const sessionKey = sessionToken ? await digest(sessionToken) : '';
    const valid = Boolean(auth.sessions[sessionKey]);
    const cookie = value => `health_admin=${value}; Path=/api/admin; HttpOnly; SameSite=Strict; Max-Age=${value ? SESSION_MS / 1000 : 0}${url.protocol === 'https:' ? '; Secure' : ''}`;
    const settings = () => ({ authenticated: true, intervalSeconds: this.engine.state.intervalMs / 1000, intervals: INTERVALS });
    if (path === '/api/admin/session') return valid ? response(settings()) : response({ authenticated: false }, 401);
    if (path === '/api/admin/logout') {
      delete auth.sessions[sessionKey];
      await this.storage.put('auth', auth);
      return response({ ok: true }, 200, { 'Set-Cookie': cookie('') });
    }
    if (['/api/admin/settings', '/api/admin/deploy-token', '/api/admin/penall-approve'].includes(path) && !valid) return response({ error: 'Please sign in' }, 401);
    let body;
    try {
      if (Number(request.headers.get('Content-Length') || 0) > 2048) return response({ error: 'Request too large' }, 413);
      const reader = request.body?.getReader();
      let text = '', bytes = 0;
      if (reader) {
        const decoder = new TextDecoder();
        while (true) {
          const { done, value } = await reader.read(); if (done) break;
          bytes += value.length;
          if (bytes > 2048) { await reader.cancel(); return response({ error: 'Request too large' }, 413); }
          text += decoder.decode(value, { stream: true });
        }
      }
      body = JSON.parse(text);
      if (!body || typeof body !== 'object') throw new Error();
    } catch { return response({ error: 'Invalid request' }, 400); }
    // The monitoring PIN is intentionally separate from release authority.
    // Even a valid monitoring session must supply the high-entropy release
    // credential; a leaked or default four-digit PIN cannot approve releases.
    if (path === '/api/admin/penall-approve' || (path === '/api/admin/deploy-token' && body.project === 'penall')) {
      const expected = this.env.PENALL_APPROVAL_HASH || '';
      if (!/^[a-f0-9]{64}$/.test(expected)) return response({error:'Penall release authorization is not configured'},503);
      const ip = await digest(request.headers.get('CF-Connecting-IP') || 'local');
      const attempts = await this.storage.get('penall-auth') || { failures:{}, global:[] };
      for (const [key, values] of Object.entries(attempts.failures)) {
        attempts.failures[key] = values.filter(t => t > now - WINDOW_MS);
        if (!attempts.failures[key].length) delete attempts.failures[key];
      }
      attempts.global = attempts.global.filter(t => t > now - WINDOW_MS);
      if ((attempts.failures[ip] || []).length >= 5 || attempts.global.length >= 30) return response({error:'Too many attempts. Try again later.'},429);
      const supplied = typeof body.releaseSecret === 'string' && body.releaseSecret.length <= 256 ? body.releaseSecret : '';
      const actual = await digest(supplied);
      let mismatch = 0;
      for (let i = 0; i < expected.length; i++) mismatch |= expected.charCodeAt(i) ^ actual.charCodeAt(i);
      if (mismatch) {
        attempts.failures[ip] = [...(attempts.failures[ip] || []), now];
        attempts.global.push(now);
        await this.storage.put('penall-auth', attempts);
        return response({error:'Incorrect release credential'},401);
      }
      delete attempts.failures[ip];
      await this.storage.put('penall-auth', attempts);
    }
    if (path === '/api/admin/deploy-token') {
      if (!this.deployments) return response({ error: 'Deployments unavailable' }, 503);
      try { return response({ token: await this.deployments.issueToken(body.project), project: body.project }); }
      catch (error) { return response({ error: error.message }, 400); }
    }
    if (path === '/api/admin/penall-approve') {
      if (!this.deployments) return response({error:'Deployments unavailable'},503);
      if (!body || Object.keys(body).length !== 2 || typeof body.runId !== 'string' || typeof body.releaseSecret !== 'string') return response({error:'Invalid request'},400);
      try { return response({approval:await this.deployments.approvePenall(body.runId)}); }
      catch (error) { return response({error:error.message},409); }
    }
    if (path === '/api/admin/settings') {
      if (!INTERVALS.includes(body.intervalSeconds)) return response({ error: 'Choose 1, 5, 10, 30 or 60 seconds' }, 400);
      await this.engine.setInterval(body.intervalSeconds);
      return response(settings());
    }
    const ip = await digest(request.headers.get('CF-Connecting-IP') || 'local');
    const failures = auth.failures[ip] || [];
    if (failures.length >= 5 || auth.global.length >= 30) {
      const retryAfter = Math.ceil((failures.length >= 5 ? failures[0] + WINDOW_MS - now : auth.global[0] + 60000 - now) / 1000);
      return response({ error: 'Too many attempts. Try again later.', retryAfter }, 429, { 'Retry-After': String(retryAfter) });
    }
    auth.global.push(now);
    const actual = await digest(typeof body.pin === 'string' ? body.pin : '');
    let mismatch = 0;
    for (let i = 0; i < fingerprint.length; i++) mismatch |= fingerprint.charCodeAt(i) ^ actual.charCodeAt(i);
    if (mismatch) {
      auth.failures[ip] = [...failures, now];
      await this.storage.put('auth', auth);
      return response({ error: 'Incorrect passcode' }, 401);
    }
    delete auth.failures[ip];
    const token = [...crypto.getRandomValues(new Uint8Array(32))].map(n => n.toString(16).padStart(2, '0')).join('');
    const keys = Object.keys(auth.sessions);
    if (keys.length >= 10) delete auth.sessions[keys[0]];
    auth.sessions[await digest(token)] = { expires: now + SESSION_MS, pin: fingerprint };
    await this.storage.put('auth', auth);
    return response(settings(), 200, { 'Set-Cookie': cookie(token) });
  }
}
