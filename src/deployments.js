const ACTIVE = ['queued', 'running'];
export const STAGES = { prepare: 'Preparing release', build_api: 'Building API', build_web: 'Building websites', backup: 'Backing up database', start: 'Starting healthy containers', assets: 'Preserving assets', switch: 'Switching traffic', verify: 'Verifying release' };
const LOGS = { build_step: 'Build step', build_cached: 'Using build cache', build_done: 'Build step completed', build_export: 'Exporting image', health_retry: 'Waiting for release health checks', image_reused: 'Reusing tested images', rollback_restored: 'Previous gateway configuration restored', command_failed: 'Deployment command failed; check private server logs', aborted: 'Deployment interrupted', heartbeat: 'Deployment is still running' };
const DEFAULT_PROJECTS = [{ id: 'egin', name: 'Egin', repository: 'Perricheno/egin', services: { production: ['egin-web', 'egin-api'], staging: ['egin-dev-web', 'egin-dev-api'] } }];
const hash = async value => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)))].map(n => n.toString(16).padStart(2, '0')).join('');
const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });
export function deploymentProjects(env) {
  const projects = env.DEPLOY_PROJECTS_JSON ? JSON.parse(env.DEPLOY_PROJECTS_JSON) : DEFAULT_PROJECTS;
  if (!Array.isArray(projects) || projects.length > 10) throw new Error('Invalid deployment projects');
  const seen = new Set();
  return projects.map(p => {
    if (!/^[a-z0-9_-]{1,40}$/.test(p.id) || seen.has(p.id) || ['__proto__', 'constructor', 'prototype'].includes(p.id)) throw new Error('Invalid project ID');
    seen.add(p.id);
    if (typeof p.name !== 'string' || p.name.length > 60 || !/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/.test(p.repository)) throw new Error('Invalid project metadata');
    for (const environment of ['production', 'staging']) if (!Array.isArray(p.services?.[environment]) || p.services[environment].some(id => typeof id !== 'string' || !/^[a-z0-9_-]{1,64}$/.test(id))) throw new Error('Invalid service mapping');
    return { id: p.id, name: p.name, repository: p.repository, services: p.services };
  });
}
export class DeploymentStore {
  constructor(storage, env) { this.storage = storage; this.env = env; this.queue = Promise.resolve(); this.clients = new Set(); }
  publish(snapshot) {
    for (const send of this.clients) send(snapshot);
  }
  stream() {
    if (this.clients.size >= 200) return json({ error: 'Stream capacity reached' }, 503);
    const encoder = new TextEncoder();
    let timer, send;
    const close = () => { clearInterval(timer); if (send) this.clients.delete(send); };
    const stream = new ReadableStream({
      start: controller => {
        send = (snapshot, initial = false) => { try { if (!initial && controller.desiredSize <= 0) return; controller.enqueue(encoder.encode(`event: deployments\ndata: ${JSON.stringify(snapshot)}\n\n`)); } catch { close(); } };
        this.clients.add(send);
        controller.enqueue(encoder.encode('retry: 3000\n\n'));
        send(this.snapshot(), true);
        timer = setInterval(() => send(this.snapshot()), 15000);
      },
      cancel: close,
    });
    return new Response(stream, { headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', 'X-Accel-Buffering': 'no', 'X-Content-Type-Options': 'nosniff' } });
  }
  async init() { this.state = await this.storage.get('deployments') || { version: 0, runs: [] }; }
  serial(fn) { const job = this.queue.then(fn); this.queue = job.catch(() => {}); return job; }
  async issueToken(projectId) {
    return this.serial(async () => {
      if (!deploymentProjects(this.env).some(p => p.id === projectId)) throw new Error('Unknown project');
      const token = [...crypto.getRandomValues(new Uint8Array(32))].map(n => n.toString(16).padStart(2, '0')).join('');
      const tokens = await this.storage.get('deploy-tokens') || {};
      tokens[projectId] = await hash(token);
      await this.storage.put('deploy-tokens', tokens);
      return token;
    });
  }
  snapshot(now = Date.now()) {
    const projects = deploymentProjects(this.env);
    return { version: this.state.version, now, projects, runs: this.state.runs.filter(run => projects.some(p => p.id === run.project)).map(run => ({
      ...run, serviceIds: projects.find(p => p.id === run.project).services[run.environment],
      repository: projects.find(p => p.id === run.project).repository,
      status: ACTIVE.includes(run.status) && now - run.updatedAt > 90000 ? 'interrupted' : run.status,
    })) };
  }
  async ingest(request) {
    if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
    const token = request.headers.get('Authorization')?.match(/^Bearer ([a-zA-Z0-9_-]{32,256})$/)?.[1];
    if (!token) return json({ error: 'Invalid deployment token' }, 401);
    let body;
    try {
      const reader = request.body?.getReader(); let text = '', size = 0;
      if (!reader) return json({ error: 'Empty event' }, 400);
      const decoder = new TextDecoder();
      while (true) { const { value, done } = await reader.read(); if (done) break; size += value.length; if (size > 8192) { await reader.cancel(); return json({ error: 'Event too large' }, 413); } text += decoder.decode(value, { stream: true }); }
      body = JSON.parse(text);
    } catch { return json({ error: 'Invalid event' }, 400); }
    return this.serial(async () => {
      const project = deploymentProjects(this.env).find(p => p.id === body?.project);
      if (!project) return json({ error: 'Unknown project' }, 400);
      const tokens = await this.storage.get('deploy-tokens') || {};
      const supplied = await hash(token);
      const expected = tokens[project.id] || (this.env.DEPLOY_INGEST_TOKEN && project.id === 'egin' ? await hash(this.env.DEPLOY_INGEST_TOKEN) : '');
      let difference = supplied.length ^ expected.length;
      for (let i = 0; i < supplied.length; i++) difference |= supplied.charCodeAt(i) ^ (expected.charCodeAt(i) || 0);
      if (difference) return json({ error: 'Invalid deployment token' }, 401);
      if (body.type === 'ping') return json({ ok: true, project: project.id });
      try { return await this.apply(body); }
      catch (error) { if (error instanceof TypeError) return json({ error: error.message }, 400); throw error; }
    });
  }
  async apply(event, now = Date.now()) {
    if (!/^[a-f0-9-]{36}$/.test(event.runId) || !Number.isSafeInteger(event.seq) || event.seq < 1 || !['production', 'staging'].includes(event.environment)) throw new TypeError('Invalid run identity');
    if (!['start', 'stage', 'log', 'heartbeat', 'finish'].includes(event.type)) throw new TypeError('Invalid event type');
    const previous = this.state.runs.find(run => run.id === event.runId);
    if (previous && (previous.project !== event.project || previous.environment !== event.environment)) throw new TypeError('Run scope mismatch');
    if (previous && event.seq <= previous.seq) return json({ ok: true, duplicate: true, seq: previous.seq });
    if (event.seq !== (previous?.seq || 0) + 1) return json({ error: 'Event sequence gap', expectedSeq: (previous?.seq || 0) + 1 }, 409);
    if (!previous && event.type !== 'start') return json({ error: 'Start event required' }, 409);
    if (previous && !ACTIVE.includes(previous.status)) return json({ error: 'Deployment already finished' }, 409);
    const next = structuredClone(this.state);
    let run = next.runs.find(r => r.id === event.runId);
    if (event.type === 'start') {
      if (previous || !['deploy', 'rollback'].includes(event.action)) throw new TypeError('Invalid start');
      if (!Array.isArray(event.stages) || !event.stages.length || event.stages.length > 8 || new Set(event.stages).size !== event.stages.length || event.stages.some(stage => !Object.hasOwn(STAGES, stage))) throw new TypeError('Invalid deployment plan');
      if (event.commit && !/^[a-f0-9]{7,40}$/.test(event.commit)) throw new TypeError('Invalid commit');
      if (event.release && !/^[a-zA-Z0-9_.-]{1,100}$/.test(event.release)) throw new TypeError('Invalid release');
      for (const old of next.runs) if (old.project === event.project && old.environment === event.environment && ACTIVE.includes(old.status)) { old.status = 'superseded'; old.finishedAt = now; }
      run = { id: event.runId, project: event.project, environment: event.environment, action: event.action, commit: event.commit || null, release: event.release || null, status: 'running', startedAt: now, updatedAt: now, seq: 0, stages: event.stages.map(id => ({ id, label: STAGES[id], status: 'pending' })), events: [] };
      next.runs.unshift(run);
      next.runs = next.runs.slice(0, 12);
    }
    let message;
    if (event.type === 'start') message = event.action === 'rollback' ? 'Rollback started' : 'Deployment started';
    if (event.type === 'stage') {
      const stage = run.stages.find(s => s.id === event.stage);
      if (!stage || !['running', 'complete', 'skipped'].includes(event.state)) throw new TypeError('Invalid stage');
      if (stage.status === 'complete' || stage.status === 'skipped') throw new TypeError('Stage already completed');
      if (event.state === 'complete' && stage.status !== 'running') throw new TypeError('Start the stage before completing it');
      if (event.state === 'running' && run.stages.some(s => s.status === 'running' && s.id !== stage.id)) throw new TypeError('Complete the previous stage first');
      stage.status = event.state;
      stage[event.state === 'running' ? 'startedAt' : 'finishedAt'] = now;
      message = `${stage.label}${event.state === 'complete' ? ' · complete' : event.state === 'skipped' ? ' · skipped' : ''}`;
    }
    if (event.type === 'log') {
      if (!Object.hasOwn(LOGS, event.code)) throw new TypeError('Unknown log code');
      message = LOGS[event.code];
      // Public stream uses a vocabulary, never raw command output, URLs or secrets.
      if (Number.isInteger(event.step) && event.step > 0 && event.step <= 999) message += ` #${event.step}`;
      if (Number.isInteger(event.total) && event.total >= event.step && event.total <= 999) message += ` / ${event.total}`;
    }
    if (event.type === 'finish') {
      if (!['success', 'failure', 'cancelled'].includes(event.status)) throw new TypeError('Invalid outcome');
      if (event.status === 'success' && run.stages.some(s => !['complete', 'skipped'].includes(s.status))) throw new TypeError('All stages must finish before success');
      run.status = event.status; run.finishedAt = now;
      for (const stage of run.stages) if (stage.status === 'running') stage.status = event.status === 'cancelled' ? 'cancelled' : 'failed';
      message = event.status === 'success' ? (run.action === 'rollback' ? 'Rollback verified and complete' : 'Release verified and live') : event.status === 'cancelled' ? 'Deployment cancelled' : 'Deployment failed; inspect private server logs';
    }
    run.seq = event.seq; run.updatedAt = now;
    if (message) run.events.push({ seq: event.seq, time: now, type: event.type, message });
    run.events = run.events.slice(-160);
    next.version++;
    await this.storage.put('deployments', next);
    this.state = next;
    this.publish(this.snapshot(now));
    return json({ ok: true, seq: event.seq });
  }
}
