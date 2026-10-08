const $ = selector => document.querySelector(selector);
const activeStatuses = ['running', 'queued'];
const labels = { running: 'Deploying', queued: 'Queued', success: 'Deployed', failure: 'Failed', cancelled: 'Cancelled', interrupted: 'Updates lost', superseded: 'Superseded' };
const views = new Map();
let snapshot, stream, poll, retry, lastVersion = -1;

function element(tag, className, text) {
  const el = document.createElement(tag);
  if (className) el.className = className;
  if (text !== undefined) el.textContent = text;
  return el;
}
function duration(start, end = Date.now()) {
  const seconds = Math.max(0, Math.floor((end - start) / 1000));
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, '0')}s`;
}
function statusOf(run) {
  return activeStatuses.includes(run.status) && Date.now() - run.updatedAt > 90000 ? 'interrupted' : run.status;
}
function updateBadges() {
  if (!snapshot) return;
  for (const card of document.querySelectorAll('.service-card[data-service-id]')) {
    const run = snapshot.runs.find(run => run.serviceIds.includes(card.dataset.serviceId));
    const status = run && statusOf(run);
    let badge = card.querySelector('.deploy-badge');
    if (!run) { badge?.remove(); continue; }
    if (!badge) {
      badge = element('button', 'deploy-badge');
      badge.addEventListener('click', () => {
        const target = snapshot.runs.find(run => run.serviceIds.includes(card.dataset.serviceId));
        const view = target && views.get(target.id);
        if (view) { view.details.open = true; view.el.scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth', block: 'center' }); view.details.querySelector('summary').focus({ preventScroll: true }); }
      });
      card.append(badge);
    }
    badge.dataset.status = status;
    const stage = run.stages.find(s => s.status === 'running');
    badge.textContent = `${labels[status]}${activeStatuses.includes(status) && stage ? ` · ${stage.label}` : ''}`;
  }
}

class DeploymentView {
  constructor(run) {
    this.el = element('article', 'deployment-card');
    this.el.innerHTML = `<div class="deploy-top"><div class="deploy-name"></div><span class="deploy-status"></span></div><div class="deploy-current"><strong></strong><span class="deploy-elapsed"></span></div><div class="deploy-progress" role="progressbar" aria-label="Completed deployment stages"><span></span></div><div class="deploy-meta"><span class="deploy-completion"></span><a class="deploy-commit" target="_blank" rel="noopener noreferrer"></a></div><details class="deploy-details"><summary><span>View deployment</span><span class="detail-chevron">＋</span></summary><ol class="deploy-stages"></ol><div class="deploy-console" tabindex="0" aria-label="Deployment event stream"><div class="console-caption"><span>EVENT STREAM</span><span class="console-live"></span></div><div class="deploy-lines" role="log" aria-live="off"></div></div></details>`;
    this.details = this.el.querySelector('details');
    this.details.addEventListener('toggle', () => { this.el.querySelector('.detail-chevron').textContent = this.details.open ? '−' : '＋'; });
    this.render(run);
  }
  render(run) {
    this.run = run;
    const find = selector => this.el.querySelector(selector);
    const status = statusOf(run);
    this.el.dataset.status = status;
    const project = snapshot.projects.find(p => p.id === run.project);
    find('.deploy-name').textContent = `${project?.name || run.project} / ${run.environment === 'production' ? 'Production' : 'Staging'}`;
    find('.deploy-status').textContent = labels[status];
    const stage = run.stages.find(stage => stage.status === 'running' || stage.status === 'failed');
    find('.deploy-current strong').textContent = status === 'success' ? run.action === 'rollback' ? 'Previous release restored' : 'Release is live' : status === 'failure' ? 'Deployment stopped' : status === 'interrupted' ? 'Waiting for the deploy server' : status === 'cancelled' ? 'Deployment cancelled' : status === 'superseded' ? 'Replaced by a newer deployment' : stage?.label || 'Preparing release';
    const done = run.stages.filter(stage => ['complete', 'skipped'].includes(stage.status)).length;
    const progress = find('.deploy-progress');
    progress.setAttribute('aria-valuenow', done); progress.setAttribute('aria-valuemin', 0); progress.setAttribute('aria-valuemax', run.stages.length);
    progress.querySelector('span').style.width = `${done / run.stages.length * 100}%`;
    find('.deploy-completion').textContent = `${done} / ${run.stages.length} stages${run.action === 'rollback' ? ' · rollback' : ''}`;
    const commit = find('.deploy-commit');
    commit.textContent = run.commit?.slice(0, 7) || 'Repository';
    commit.href = `https://github.com/${run.repository}${run.commit ? `/commit/${run.commit}` : ''}`;
    const list = find('.deploy-stages');
    if (!list.children.length) for (const stage of run.stages) {
      const item = element('li'); item.dataset.stage = stage.id;
      item.append(element('span', 'stage-marker'), element('span', 'stage-label', stage.label), element('span', 'stage-duration'));
      list.append(item);
    }
    for (const stage of run.stages) {
      const item = [...list.children].find(item => item.dataset.stage === stage.id);
      item.dataset.status = stage.status;
      item.querySelector('.stage-marker').textContent = stage.status === 'complete' ? '✓' : stage.status === 'skipped' ? '−' : stage.status === 'failed' ? '×' : '';
      item.querySelector('.stage-duration').textContent = stage.startedAt && stage.finishedAt ? duration(stage.startedAt, stage.finishedAt) : stage.status === 'skipped' ? 'Skipped' : '';
    }
    const lines = find('.deploy-lines');
    const follow = lines.scrollTop + lines.clientHeight >= lines.scrollHeight - 35;
    const first = run.events[0]?.seq || 0;
    for (const line of [...lines.children]) if (Number(line.dataset.seq) < first) line.remove();
    for (const event of run.events) {
      if ([...lines.children].some(line => Number(line.dataset.seq) === event.seq)) continue;
      const line = element('div', 'deploy-line'); line.dataset.seq = event.seq;
      const time = element('time', '', new Date(event.time).toLocaleTimeString('en-GB')); time.dateTime = new Date(event.time).toISOString();
      line.append(time, element('span', '', event.message)); lines.append(line);
    }
    if (follow) lines.scrollTop = lines.scrollHeight;
    find('.console-live').textContent = activeStatuses.includes(status) ? 'LIVE' : labels[status].toUpperCase();
    this.tick();
  }
  tick() {
    const status = statusOf(this.run);
    this.el.querySelector('.deploy-elapsed').textContent = duration(this.run.startedAt, this.run.finishedAt || Date.now());
    if (status !== this.el.dataset.status) this.render(this.run);
  }
}

function render(data) {
  snapshot = data;
  $('#deployments-section').hidden = !data.projects.length;
  const container = $('#deployment-runs');
  if (!data.runs.length) {
    container.replaceChildren(element('p', 'deploy-empty', 'No deployments yet. The next release will appear here live.'));
    updateBadges(); return;
  }
  container.querySelector('.deploy-empty')?.remove();
  // Show the newest run for each environment; reconnect always gets a full snapshot.
  const seen = new Set();
  const selected = data.runs.filter(run => { const key = `${run.project}/${run.environment}`; if (seen.has(key)) return false; seen.add(key); return true; });
  for (const [id, view] of views) if (!selected.some(run => run.id === id)) { view.el.remove(); views.delete(id); }
  for (const run of selected) {
    let view = views.get(run.id);
    if (!view) { view = new DeploymentView(run); views.set(run.id, view); container.append(view.el); }
    else view.render(run);
  }
  updateBadges(); lastVersion = data.version;
}
function connection(connected) {
  $('#stream-state').dataset.connected = String(connected);
  $('#stream-state').replaceChildren(element('i'), document.createTextNode(connected ? 'Live updates' : 'Reconnecting'));
}
async function fallback() {
  if (document.hidden) return;
  try { const response = await fetch('/api/deployments', { cache: 'no-store', signal: AbortSignal.timeout(8000) }); if (response.ok) render(await response.json()); } catch {}
}
function connect() {
  clearTimeout(retry); clearInterval(poll); stream?.close();
  if (document.hidden) return;
  stream = new EventSource('/api/deployments/stream');
  stream.addEventListener('deployments', event => {
    try { const data = JSON.parse(event.data); connection(true); clearInterval(poll); poll = null; if (data.version !== lastVersion || !snapshot) render(data); else { snapshot = data; for (const run of data.runs) views.get(run.id)?.render(run); updateBadges(); } } catch {}
  });
  stream.onerror = () => { connection(false); if (!poll) { fallback(); poll = setInterval(fallback, 5000); } };
}
document.addEventListener('visibilitychange', () => { if (document.hidden) { stream?.close(); clearInterval(poll); poll = null; } else connect(); });
window.addEventListener('online', connect);
window.addEventListener('health-services', updateBadges);
setInterval(() => { for (const view of views.values()) view.tick(); updateBadges(); }, 1000);
connect();
