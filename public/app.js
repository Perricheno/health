import { createMorph } from '/vendor/morphicons.js';

const $ = (selector, parent = document) => parent.querySelector(selector);
const ranges = ['1m', '5m', '24h', '7d', '30d'];
const rangeLabels = { '1m': '1 minute ago', '5m': '5 minutes ago', '24h': '24h ago', '7d': '7 days ago', '30d': '30 days ago' };
const statusLabels = { operational: 'Operational', degraded: 'Degraded performance', down: 'Service unavailable', unknown: 'Awaiting checks' };
const overallLabels = { operational: 'All Systems Go', degraded: 'Performance Degraded', down: 'Service Disruption', unknown: 'Awaiting Checks' };
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
const cards = new Map();
const inflight = new Map();
let refreshBusy = false;
let lastData = null;
let lastReceived = 0;
let themeBusy = false;
const icons = {
  moon: 'M20.6 14.1A8.8 8.8 0 0 1 9.9 3.4 8.8 8.8 0 1 0 20.6 14.1Z',
  sun: 'M16 12A4 4 0 1 1 8 12A4 4 0 1 1 16 12Z M12 2V4 M12 20V22 M2 12H4 M20 12H22 M4.9 4.9L6.3 6.3 M17.7 17.7L19.1 19.1 M4.9 19.1L6.3 17.7 M17.7 6.3L19.1 4.9',
  refresh: 'M20 7V12H15 M4 17V12H9 M5.1 7A8 8 0 0 1 18.3 6L20 9 M4 15L5.7 18A8 8 0 0 0 18.9 17',
  check: 'M5 12L9 16L19 6',
  error: 'M6 6L18 18 M6 18L18 6',
};
const themeMorph = createMorph($('#theme-icon path'), icons[document.documentElement.dataset.theme === 'dark' ? 'sun' : 'moon'], { reducedMotion: 'user' });
const refreshMorph = createMorph($('#refresh-icon path'), icons.refresh, { reducedMotion: 'user' });
let refreshIconTimer;

function themeLabel() {
  const dark = document.documentElement.dataset.theme === 'dark';
  $('#theme-toggle').setAttribute('aria-label', `Switch to ${dark ? 'light' : 'dark'} theme`);
  $('meta[name="theme-color"]').content = dark ? '#0a0a0a' : '#f1f1f3';
  themeMorph.morphTo(icons[dark ? 'sun' : 'moon'], 'snappy');
}
themeLabel();
$('#theme-toggle').addEventListener('click', async event => {
  if (themeBusy) return;
  const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
  const apply = () => {
    document.documentElement.dataset.theme = next;
    try { localStorage.setItem('health-theme', next); } catch {}
    themeLabel();
  };
  if (!document.startViewTransition || reducedMotion.matches) return apply();
  themeBusy = true;
  const rect = event.currentTarget.getBoundingClientRect();
  const x = rect.x + rect.width / 2, y = rect.y + rect.height / 2;
  const radius = Math.hypot(Math.max(x, innerWidth - x), Math.max(y, innerHeight - y));
  try {
    const transition = document.startViewTransition(apply);
    await transition.ready;
    await document.documentElement.animate({ clipPath: [`circle(0px at ${x}px ${y}px)`, `circle(${radius}px at ${x}px ${y}px)`] }, {
      duration: 700, easing: 'cubic-bezier(.22,1,.36,1)', pseudoElement: '::view-transition-new(root)',
    }).finished;
  } catch { apply(); } finally { themeBusy = false; }
});

async function fetchStatus(range) {
  if (inflight.has(range)) return inflight.get(range);
  const promise = (async () => {
    const response = await fetch(`/api/status?range=${range}`, { signal: AbortSignal.timeout(12000), cache: 'no-cache' });
    if (!response.ok) throw new Error('Status is temporarily unavailable. Retrying automatically.');
    return response.json();
  })();
  inflight.set(range, promise);
  try { return await promise; } finally { inflight.delete(range); }
}

function notice(text = '') { $('#notice').textContent = text; $('#notice').hidden = !text; }

function updateOverview(data) {
  lastData = data;
  lastReceived = Date.now();
  $('#site-name').textContent = data.siteName;
  document.title = `Status · ${data.siteName}`;
  $('#status-panel').dataset.status = data.overall;
  $('#overall').textContent = overallLabels[data.overall];
  $('#updated').textContent = data.updatedAt ? `Updated at ${new Date(data.updatedAt).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}` : 'Waiting for first check';
  $('#updated').title = data.updatedAt ? new Date(data.updatedAt).toLocaleString() : '';
}

class ServiceCard {
  constructor(service, index) {
    this.id = service.id;
    this.range = '24h';
    this.selected = -1;
    this.generation = 0;
    this.el = document.createElement('article');
    this.el.className = 'service-card';
    this.el.style.setProperty('--order', index);
    // Only fixed application markup is interpolated. All API text uses textContent.
    this.el.innerHTML = `<h2></h2><p class="service-state"><span class="status-dot" aria-hidden="true"></span><span class="service-status"></span></p>
      <div class="card-controls"><div class="range-picker" role="group" aria-label="History period"><span class="range-thumb" aria-hidden="true"></span>${ranges.map(range => `<button class="range-button" data-range="${range}" aria-pressed="${range === '24h'}">${range}</button>`).join('')}</div><div class="uptime"><span class="uptime-value">—</span><span class="small-label">Uptime</span></div></div>
      <div class="history"><div class="tooltip" role="tooltip"><time></time><strong><span class="status-dot"></span><span class="tooltip-status"></span></strong><div class="detail"><span>Response time</span><span class="tooltip-latency"></span></div><div class="detail"><span class="tooltip-samples"></span><span class="tooltip-code"></span></div></div><div class="bars" tabindex="0" role="slider" aria-valuemin="1" aria-valuemax="48" aria-valuenow="48" aria-label="Uptime history. Use arrow keys to explore."></div><div class="chart-labels"><span class="range-label">24h ago</span><span class="today">Today</span></div></div><p class="card-note" hidden></p>`;
    this.chart = $('.bars', this.el);
    this.tooltip = $('.tooltip', this.el);
    this.bars = Array.from({ length: 48 }, (_, index) => {
      const bar = document.createElement('span');
      bar.className = 'bar';
      bar.style.setProperty('--i', index);
      bar.setAttribute('aria-hidden', 'true');
      this.chart.append(bar);
      return bar;
    });
    $('.range-picker', this.el).addEventListener('click', event => {
      const button = event.target.closest('[data-range]');
      if (button && button.dataset.range !== this.range) this.changeRange(button.dataset.range);
    });
    this.chart.addEventListener('pointerdown', event => {
      this.chart.focus({ preventScroll: true });
      if (event.pointerType !== 'mouse') this.chart.setPointerCapture(event.pointerId);
      this.inspectPointer(event);
    });
    this.chart.addEventListener('pointermove', event => this.inspectPointer(event));
    this.chart.addEventListener('pointerleave', event => { if (event.pointerType === 'mouse') this.hide(); });
    this.chart.addEventListener('pointercancel', () => this.hide());
    this.chart.addEventListener('blur', () => this.hide());
    this.chart.addEventListener('focus', () => { if (this.selected < 0) this.inspect(47); });
    this.chart.addEventListener('keydown', event => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End', 'Escape'].includes(event.key)) return;
      event.preventDefault();
      if (event.key === 'Escape') return this.hide();
      this.inspect(event.key === 'Home' ? 0 : event.key === 'End' ? 47 : Math.max(0, Math.min(47, this.selected + (event.key === 'ArrowLeft' ? -1 : 1))));
    });
    this.render(service, true);
  }

  async changeRange(range) {
    const generation = ++this.generation;
    this.range = range;
    this.hide();
    this.el.setAttribute('aria-busy', 'true');
    const picker = $('.range-picker', this.el);
    picker.style.setProperty('--selected', ranges.indexOf(range));
    picker.querySelectorAll('button').forEach(button => button.setAttribute('aria-pressed', button.dataset.range === range));
    try {
      const data = await fetchStatus(range);
      if (generation !== this.generation) return;
      const service = data.services.find(s => s.id === this.id);
      if (!service) throw new Error('This service is no longer configured. Refresh to update.');
      this.render(service, true);
      updateOverview(data);
      notice();
    } catch (error) {
      if (generation !== this.generation) return;
      // Restore the range that is actually displayed when a request fails.
      this.range = this.displayedRange || '24h';
      picker.style.setProperty('--selected', ranges.indexOf(this.range));
      picker.querySelectorAll('button').forEach(button => button.setAttribute('aria-pressed', button.dataset.range === this.range));
      notice(error.message);
    } finally { if (generation === this.generation) this.el.setAttribute('aria-busy', 'false'); }
  }

  render(service, animate = false) {
    this.data = service;
    this.displayedRange = this.range;
    this.el.dataset.status = service.status;
    $('h2', this.el).textContent = service.name;
    $('.service-status', this.el).textContent = statusLabels[service.status];
    this.animateNumber(service.uptime);
    $('.range-label', this.el).textContent = rangeLabels[this.range];
    this.chart.setAttribute('aria-label', `${service.name}: ${this.range} uptime history. Use arrow keys to explore.`);
    this.bars.forEach((bar, i) => {
      bar.dataset.status = service.bars[i].status;
      if (animate && !reducedMotion.matches) {
        bar.classList.remove('enter');
        // Web Animations lets period changes restart without a forced layout per bar.
        bar.animate([{ opacity: 0, transform: 'scaleY(.2)' }, { opacity: 1, transform: 'scaleY(1)' }], {
          duration: 750, delay: i * 8, easing: 'cubic-bezier(.22,1,.36,1)', fill: 'backwards',
        });
      }
    });
    const note = $('.card-note', this.el);
    note.hidden = service.samples > 0 && service.coverage >= 95 && service.status !== 'unknown';
    note.textContent = service.status === 'unknown' && service.checkedAt ? 'Checks are delayed. Current status is unknown.' : !service.samples ? 'Waiting for observations in this period. Checks run every minute.' : `${service.samples.toLocaleString()} check${service.samples === 1 ? '' : 's'} recorded · ${service.coverage.toFixed(1)}% coverage. Gray bars have no observations.`;
    if (this.selected >= 0) this.inspect(this.selected);
  }

  animateNumber(target) {
    const element = $('.uptime-value', this.el);
    cancelAnimationFrame(this.numberFrame);
    if (target === null) { element.textContent = '—'; this.value = null; return; }
    const from = this.value ?? target;
    this.value = target;
    if (reducedMotion.matches || from === target) { element.textContent = `${target.toFixed(2)}%`; return; }
    const start = performance.now();
    const step = now => {
      const t = Math.min(1, (now - start) / 650);
      element.textContent = `${(from + (target - from) * (1 - (1 - t) ** 3)).toFixed(2)}%`;
      if (t < 1) this.numberFrame = requestAnimationFrame(step);
    };
    this.numberFrame = requestAnimationFrame(step);
  }

  inspectPointer(event) {
    const rect = this.chart.getBoundingClientRect();
    const index = Math.max(0, Math.min(47, Math.floor((event.clientX - rect.left) / rect.width * 48)));
    if (index !== this.selected || !this.tooltip.classList.contains('visible')) this.inspect(index);
  }

  inspect(index) {
    if (!this.data) return;
    this.selected = index;
    this.chart.classList.add('inspecting');
    this.bars.forEach((bar, i) => {
      const distance = Math.abs(i - index);
      bar.style.setProperty('--scale', distance === 0 ? 1.22 : distance === 1 ? 1.12 : distance === 2 ? 1.04 : 1);
      bar.style.setProperty('--lift', distance === 0 ? 3 : distance === 1 ? 1 : 0);
      bar.classList.toggle('selected', distance === 0);
      bar.classList.toggle('near', distance <= 2);
    });
    const point = this.data.bars[index];
    const dateOptions = { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', ...(this.range === '1m' || this.range === '5m' ? { second: '2-digit' } : {}) };
    const time = new Date(point.from).toLocaleString('en-US', dateOptions);
    const label = point.samples ? statusLabels[point.status] : 'No observations';
    $('time', this.tooltip).textContent = time;
    $('time', this.tooltip).dateTime = new Date(point.from).toISOString();
    this.tooltip.dataset.status = point.status;
    $('.tooltip-status', this.tooltip).textContent = label;
    $('.tooltip-latency', this.tooltip).textContent = point.latency === null ? '—' : `${point.latency} ms`;
    $('.tooltip-samples', this.tooltip).textContent = `${point.samples} check${point.samples === 1 ? '' : 's'}`;
    $('.tooltip-code', this.tooltip).textContent = point.code ? `HTTP ${point.code}` : point.reason === 'timeout' ? 'Timed out' : point.reason === 'connection' ? 'Connection failed' : '—';
    const width = this.chart.clientWidth;
    const position = (index + .5) / 48 * width;
    const left = Math.max(0, Math.min(width - this.tooltip.offsetWidth, position - this.tooltip.offsetWidth / 2));
    this.tooltip.style.left = `${left}px`;
    this.tooltip.style.setProperty('--arrow', `${Math.max(14, Math.min(this.tooltip.offsetWidth - 18, position - left - 4))}px`);
    this.tooltip.classList.add('visible');
    this.chart.setAttribute('aria-valuenow', index + 1);
    this.chart.setAttribute('aria-valuetext', `${time}, ${label}, ${point.samples} checks${point.latency === null ? '' : `, ${point.latency} milliseconds`}`);
  }

  hide() {
    this.selected = -1;
    this.chart.classList.remove('inspecting');
    this.tooltip.classList.remove('visible');
    this.tooltip.style.left = '0px';
    this.bars.forEach(bar => {
      bar.style.setProperty('--scale', 1);bar.style.setProperty('--lift', 0);
      bar.classList.remove('selected', 'near');
    });
  }
}

async function refresh(manual = false) {
  if (refreshBusy) return;
  refreshBusy = true;
  const button = $('#refresh');
  button.disabled = true;
  button.classList.add('is-refreshing');
  clearTimeout(refreshIconTimer);
  refreshMorph.morphTo(icons.refresh, 'snappy');
  let success = false;
  try {
    const selectedRanges = [...new Set(['24h', ...[...cards.values()].map(card => card.range)])];
    const responses = await Promise.all(selectedRanges.map(fetchStatus));
    const data = responses[0];
    updateOverview(data);
    const container = $('#services');
    if (!cards.size) container.replaceChildren();
    for (const [id, card] of cards) if (!data.services.some(service => service.id === id)) { card.el.remove(); cards.delete(id); }
    data.services.forEach((service, index) => {
      let card = cards.get(service.id);
      if (!card) { card = new ServiceCard(service, index); cards.set(service.id, card); container.append(card.el); }
      else {
        const response = responses.find(response => response.range === card.range);
        const latest = response?.services.find(s => s.id === card.id);
        if (latest && card.el.getAttribute('aria-busy') !== 'true') card.render(latest);
      }
    });
    if (!data.services.length) {
      container.innerHTML = '<div class="service-card empty-state"><h2>No services yet</h2><p>Configured services will appear here automatically.</p></div>';
    }
    notice();
    success = true;
    if (manual) $('#announcement').textContent = 'Status updated.';
  } catch (error) {
    notice(navigator.onLine ? error.message : 'You are offline. Reconnecting automatically.');
    if (!cards.size) {
      $('#overall').textContent = 'Status Unavailable';
      $('#services').innerHTML = '<div class="service-card empty-state"><h2>Unable to load status</h2><p>Monitoring data is temporarily unavailable.</p><button id="retry">Try again</button></div>';
      $('#retry').addEventListener('click', () => refresh(true));
    }
  } finally {
    refreshBusy = false;
    button.disabled = false;
    button.classList.remove('is-refreshing');
    refreshMorph.morphTo(success ? icons.check : icons.error, 'snappy');
    refreshIconTimer = setTimeout(() => refreshMorph.morphTo(icons.refresh, 'snappy'), 1400);
    $('#services').setAttribute('aria-busy', 'false');
  }
}

$('#refresh').addEventListener('click', () => refresh(true));
document.addEventListener('pointerdown', event => { if (!event.target.closest('.bars')) for (const card of cards.values()) card.hide(); });
window.addEventListener('resize', () => { for (const card of cards.values()) card.hide(); });
window.addEventListener('online', () => refresh());
document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });
setInterval(() => {
  // A disconnected browser must not keep displaying a green current status forever.
  if (lastData && Date.now() - lastReceived > 180000) {
    $('#status-panel').dataset.status = 'unknown';
    $('#overall').textContent = 'Updates Delayed';
    for (const card of cards.values()) { card.el.dataset.status = 'unknown'; $('.service-status', card.el).textContent = 'Updates delayed'; }
  }
  if (!document.hidden) refresh();
}, 30000);
refresh();
