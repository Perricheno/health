import test from 'node:test';
import assert from 'node:assert/strict';
import { DeploymentStore } from '../src/deployments.js';
import { AdminApi } from '../src/admin.js';

class Storage {
  data = new Map();
  async get(key) { return structuredClone(this.data.get(key)); }
  async put(key, value) { this.data.set(key, structuredClone(value)); }
}
async function setup() {
  const storage = new Storage();
  const store = new DeploymentStore(storage, {}); await store.init();
  const token = await store.issueToken('egin');
  let seq = 0;
  const runId = crypto.randomUUID();
  const event = fields => ({ project: 'egin', environment: 'staging', runId, seq: ++seq, ...fields });
  const send = (payload, auth = token) => store.ingest(new Request('https://health.test/api/deployments/ingest', { method: 'POST', headers: { Authorization: `Bearer ${auth}` }, body: JSON.stringify(payload) }));
  return { storage, store, token, event, send, runId };
}

test('deployment ingestion authenticates, validates scope, and ping never creates a fake deployment', async () => {
  const { store, send } = await setup();
  assert.equal((await send({ project: 'egin', type: 'ping' }, 'x'.repeat(64))).status, 401);
  assert.equal((await send({ project: 'other', type: 'ping' })).status, 400);
  assert.equal((await send({ project: 'egin', type: 'ping' })).status, 200);
  assert.equal(store.snapshot().runs.length, 0);
});

test('ordered stages, idempotency, completion and public event vocabulary', async () => {
  const { store, send, event } = await setup();
  const start = event({ type: 'start', action: 'deploy', commit: 'a'.repeat(40), stages: ['prepare', 'verify'] });
  assert.equal((await send(start)).status, 200);
  assert.equal((await (await send(start)).json()).duplicate, true);
  assert.equal((await send({ ...start, seq: 3, type: 'heartbeat' })).status, 409);
  for (const stage of ['prepare', 'verify']) {
    assert.equal((await send(event({ type: 'stage', stage, state: 'running' }))).status, 200);
    assert.equal((await send(event({ type: 'stage', stage, state: 'complete' }))).status, 200);
  }
  assert.equal((await send(event({ type: 'log', code: 'build_step', step: 3, total: 9, raw: 'SECRET_TOKEN=private', message: '<script>alert(1)</script>' }))).status, 200);
  assert.equal((await send(event({ type: 'finish', status: 'success' }))).status, 200);
  const snapshot = store.snapshot();
  assert.equal(snapshot.runs[0].status, 'success');
  assert.deepEqual(snapshot.runs[0].serviceIds, ['egin-dev-web', 'egin-dev-api']);
  assert.doesNotMatch(JSON.stringify(snapshot), /SECRET_TOKEN|private|script>/);
  assert.equal((await send(event({ type: 'heartbeat' }))).status, 409);
});

test('incomplete plans cannot be reported successful and invalid events do not advance sequence', async () => {
  const { send, event, store } = await setup();
  await send(event({ type: 'start', action: 'deploy', stages: ['prepare'] }));
  const invalid = event({ type: 'finish', status: 'success' });
  assert.equal((await send(invalid)).status, 400);
  assert.equal(store.snapshot().runs[0].seq, 1);
  assert.equal((await send({ ...invalid, type: 'log', code: 'raw-log' })).status, 400);
  assert.equal((await send({ ...invalid, type: 'finish', status: 'failure' })).status, 200);
});

test('superseded runs cannot overwrite the current run; missing heartbeats show interrupted', async () => {
  const { send, event, store } = await setup();
  await send(event({ type: 'start', action: 'deploy', stages: ['prepare'] }));
  const old = store.snapshot().runs[0];
  assert.equal(store.snapshot(old.updatedAt + 91000).runs[0].status, 'interrupted');
  await send({ project: 'egin', environment: 'staging', runId: crypto.randomUUID(), seq: 1, type: 'start', action: 'rollback', stages: ['prepare'] });
  assert.equal(store.snapshot().runs[1].status, 'superseded');
  assert.equal((await send(event({ type: 'finish', status: 'failure' }))).status, 409);
});

test('token rotation revokes old token and persisted history survives coordinator restart', async () => {
  const { store, send, event, storage, token } = await setup();
  await send(event({ type: 'start', action: 'deploy', stages: ['prepare'] }));
  await store.issueToken('egin');
  assert.equal((await send({ project: 'egin', type: 'ping' }, token)).status, 401);
  const next = new DeploymentStore(storage, {}); await next.init();
  assert.equal(next.snapshot().runs.length, 1);
  assert.doesNotMatch(JSON.stringify(next.snapshot()), new RegExp(token));
});

test('SSE broadcasts new events and reconnect receives persisted snapshot', async () => {
  const { store, send, event } = await setup();
  const stream = store.stream(); const reader = stream.body.getReader(); const decoder = new TextDecoder();
  assert.match(decoder.decode((await reader.read()).value), /retry: 3000/);
  assert.match(decoder.decode((await reader.read()).value), /"runs":\[\]/);
  await send(event({ type: 'start', action: 'deploy', stages: ['prepare'] }));
  assert.match(decoder.decode((await reader.read()).value), /"status":"running"/);
  await reader.cancel(); assert.equal(store.clients.size, 0);
  const second = store.stream().body.getReader(); await second.read();
  assert.match(decoder.decode((await second.read()).value), /"status":"running"/);
  await second.cancel();
});

test('deployment tokens can only be issued through an authenticated same-origin admin session', async () => {
  const { storage, store } = await setup();
  const engine = { state: { intervalMs: 1000 } };
  const admin = new AdminApi(storage, engine, {}, store);
  const req = (path, body, cookie = '') => new Request(`https://health.test/api/admin/${path}`, { method: 'POST', headers: { Origin: 'https://health.test', Cookie: cookie }, body: JSON.stringify(body) });
  assert.equal((await admin.handle(req('deploy-token', { project: 'egin' }))).status, 401);
  const login = await admin.handle(req('login', { pin: '0000' }));
  const cookie = login.headers.get('Set-Cookie').split(';')[0];
  const issued = await admin.handle(req('deploy-token', { project: 'egin' }, cookie));
  assert.equal(issued.status, 200);
  assert.match((await issued.json()).token, /^[a-f0-9]{64}$/);
});
