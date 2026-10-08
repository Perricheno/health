import { createMorph } from '/vendor/morphicons.js';
const $ = selector => document.querySelector(selector);
const dialog = $('#admin-dialog');
const lock = 'M7 11V7a5 5 0 0 1 10 0v4 M6 11H18V21H6Z';
const unlocked = 'M7 11V7a5 5 0 0 1 9-3 M6 11H18V21H6Z';
const check = 'M5 12L9 16L19 6';
const morph = createMorph($('#admin-icon path'), lock, { reducedMotion: 'user' });
let digits = '', busy = false, selected = 1, saved = 1, generation = 0, requestController;

async function api(path, method = 'GET', body) {
  const controller = new AbortController();
  requestController = controller;
  const timeout = setTimeout(() => controller.abort(), 12000);
  try {
    const response = await fetch(`/api/admin/${path}`, { method, credentials: 'same-origin', signal: controller.signal,
      ...(body ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}) });
    const data = await response.json();
    if (!response.ok) { const error = new Error(data.error || 'Please sign in'); error.status = response.status; throw error; }
    return data;
  } finally { clearTimeout(timeout); if (requestController === controller) requestController = null; }
}
function dots() {
  $('#pin-dots').querySelectorAll('i').forEach((dot, index) => dot.classList.toggle('filled', index < digits.length));
  $('#pin-progress').textContent = `${digits.length} of 4 digits entered`;
}
function pinView() {
  digits = ''; dots(); busy = false;
  $('#pin-view').hidden = false; $('#settings-view').hidden = true;
  $('#admin-title').textContent = 'Enter Passcode';
  $('#admin-subtitle').textContent = 'Your infrastructure. Your controls.';
  $('#pin-message').textContent = '';
  morph.morphTo(lock, 'snappy');
}
function choices() {
  $('#interval-options').querySelectorAll('button').forEach(button => button.setAttribute('aria-pressed', Number(button.dataset.seconds) === selected));
  $('#settings-save').disabled = busy || selected === saved;
}
function settingsView(data) {
  digits = ''; dots();
  saved = selected = data.intervalSeconds;
  $('#pin-view').hidden = true; $('#settings-view').hidden = false;
  $('#admin-title').textContent = 'Monitoring';
  $('#admin-subtitle').textContent = 'A little more control.';
  $('#settings-message').textContent = '';
  morph.morphTo(unlocked, 'snappy');
  choices();
}
$('#admin-open').addEventListener('click', async () => {
  const id = ++generation;
  pinView(); dialog.showModal(); $('#admin-title').focus(); busy = true;
  try { const data = await api('session'); if (id === generation) settingsView(data); }
  catch (error) { if (id === generation && error.status !== 401) $('#pin-message').textContent = 'Unable to connect. Try again.'; }
  finally { if (id === generation) { busy = false; choices(); } }
});
function close() { dialog.close(); }
$('#admin-close').addEventListener('click', close);
dialog.addEventListener('click', event => { if (event.target === dialog) { const r = dialog.getBoundingClientRect(); if (event.clientX < r.left || event.clientX > r.right || event.clientY < r.top || event.clientY > r.bottom) close(); } });
dialog.addEventListener('close', () => { generation++; requestController?.abort(); digits = ''; dots(); busy = false; $('#admin-open').focus(); });
async function enter(digit) {
  if (busy || $('#pin-view').hidden || digits.length >= 4) return;
  $('#pin-message').textContent = '';
  digits += digit; dots();
  if (digits.length !== 4) return;
  busy = true;
  const id = generation;
  $('#pin-dots').classList.add('checking');
  try {
    const data = await api('login', 'POST', { pin: digits });
    if (id !== generation) return;
    settingsView(data);
  } catch (error) {
    if (id !== generation) return;
    $('#pin-message').textContent = error.status === 401 || error.status === 429 ? error.message : 'Unable to connect. Try again.';
    if (!matchMedia('(prefers-reduced-motion: reduce)').matches) $('#pin-dots').animate({ transform: ['translateX(0)', 'translateX(-10px)', 'translateX(9px)', 'translateX(-6px)', 'translateX(0)'] }, { duration: 380, easing: 'ease-out' });
    digits = ''; dots();
  } finally { $('#pin-dots').classList.remove('checking'); if (id === generation) { busy = false; choices(); } }
}
function remove() { if (!busy) { digits = digits.slice(0, -1); dots(); } }
$('#pin-keypad').addEventListener('click', event => { const key = event.target.closest('[data-digit]'); if (key) enter(key.dataset.digit); });
$('#pin-delete').addEventListener('click', remove);
dialog.addEventListener('keydown', event => {
  if ($('#pin-view').hidden || event.ctrlKey || event.metaKey || event.altKey) return;
  if (/^\d$/.test(event.key)) { event.preventDefault(); enter(event.key); }
  if (event.key === 'Backspace') { event.preventDefault(); remove(); }
});
$('#interval-options').addEventListener('click', event => {
  if (busy) return;
  const button = event.target.closest('[data-seconds]');
  if (button) { selected = Number(button.dataset.seconds); choices(); $('#settings-message').textContent = ''; }
});
$('#settings-save').addEventListener('click', async () => {
  if (busy) return;
  const id = generation;
  busy = true; choices(); $('#settings-save').textContent = 'Saving…';
  try {
    const data = await api('settings', 'PUT', { intervalSeconds: selected });
    if (id !== generation) return;
    saved = selected = data.intervalSeconds;
    $('#settings-message').textContent = `Saved. Checking every ${saved} second${saved === 1 ? '' : 's'}.`;
    morph.morphTo(check, 'snappy');
    window.dispatchEvent(new CustomEvent('health-settings', { detail: data }));
  } catch (error) {
    if (id === generation) {
      if (error.status === 401) { pinView(); $('#pin-message').textContent = 'Session expired. Enter your passcode.'; }
      else $('#settings-message').textContent = error.message;
    }
  } finally { if (id === generation) { busy = false; $('#settings-save').textContent = 'Save changes'; choices(); } }
});
$('#admin-logout').addEventListener('click', async () => {
  if (busy) return;
  const id = generation; busy = true;
  try { await api('logout', 'POST'); if (id === generation) pinView(); }
  catch { if (id === generation) $('#settings-message').textContent = 'Unable to lock. Try again.'; }
  finally { if (id === generation) busy = false; }
});
