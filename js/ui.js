// Capa DOM: paneles, HUD, UI de AR y consola en pantalla
// (dentro del visor no hay devtools, así que la consola visible no es opcional).

const $ = sel => document.querySelector(sel);

export const el = {
  overlay:   $('#overlay'),
  home:      $('#panel-home'),
  calib:     $('#panel-calib'),
  results:   $('#panel-results'),
  hud:       $('#hud'),
  hudTitle:  $('#hud-title'),
  hudStatus: $('#hud-status'),
  arUI:      $('#ar-ui'),
  arMsg:     $('#ar-msg'),
  arActions: $('#ar-actions'),
  debug:     $('#debug'),
  support:   $('#support'),
  canvas:    $('#gl'),
  video:     $('#cam'),
};

const PANELS = [el.home, el.calib, el.results];

export function showPanel(name) {
  PANELS.forEach(p => p.classList.add('hidden'));
  el.hud.classList.add('hidden');
  el.arUI.classList.add('hidden');
  const p = { home: el.home, calib: el.calib, results: el.results }[name];
  if (p) p.classList.remove('hidden');
}

export function showHud(title) {
  PANELS.forEach(p => p.classList.add('hidden'));
  el.arUI.classList.add('hidden');
  el.hud.classList.remove('hidden');
  el.hudTitle.textContent = title;
  el.hudStatus.textContent = '';
}

export function hudStatus(txt) { el.hudStatus.textContent = txt; }

export function showAR() {
  PANELS.forEach(p => p.classList.add('hidden'));
  el.hud.classList.add('hidden');
  el.arUI.classList.remove('hidden');
}

/** Pinta el mensaje y los botones de la UI de AR (dom-overlay). */
export function arPrompt(msg, actions = []) {
  el.arMsg.innerHTML = msg;
  el.arActions.innerHTML = '';
  for (const a of actions) {
    const b = document.createElement('button');
    b.className = 'btn' + (a.primary ? ' primary' : a.ghost ? ' ghost' : '');
    b.textContent = a.label;
    b.onclick = ev => { ev.stopPropagation(); a.onClick(); };
    el.arActions.appendChild(b);
  }
}

// ---------------- consola ----------------
let debugOn = false;
const LINES = [];

export function log(msg, kind = '') {
  const line = `${new Date().toISOString().slice(11, 19)} ${msg}`;
  LINES.push({ line, kind });
  if (LINES.length > 200) LINES.shift();
  if (debugOn) renderDebug();
  const fn = kind === 'e' ? 'error' : kind === 'w' ? 'warn' : 'log';
  console[fn](msg);
}
export const logErr  = m => log('✖ ' + m, 'e');
export const logWarn = m => log('▲ ' + m, 'w');
export const logOk   = m => log('✔ ' + m, 'g');

function renderDebug() {
  el.debug.innerHTML = LINES.map(l => `<div class="${l.kind}">${escapeHtml(l.line)}</div>`).join('');
  el.debug.scrollTop = el.debug.scrollHeight;
}

function escapeHtml(s) {
  return s.replace(/[&<>]/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;' }[c]));
}

document.querySelector('#debug-toggle').onclick = () => {
  debugOn = !debugOn;
  el.debug.classList.toggle('hidden', !debugOn);
  if (debugOn) renderDebug();
};

window.addEventListener('error', e => logErr(`${e.message} @ ${e.filename}:${e.lineno}`));
window.addEventListener('unhandledrejection', e => logErr('promesa rechazada: ' + (e.reason?.message || e.reason)));

// ---------------- chips de soporte ----------------
export function setChips(items) {
  el.support.innerHTML = items
    .map(i => `<span class="chip ${i.ok === true ? 'ok' : i.ok === false ? 'bad' : ''}">${i.label}</span>`)
    .join('');
}

// ---------------- pantalla completa / orientación ----------------
export async function goImmersive() {
  try { await document.documentElement.requestFullscreen?.({ navigationUI: 'hide' }); }
  catch (e) { logWarn('sin fullscreen: ' + e.message); }
  try { await screen.orientation?.lock?.('landscape'); }
  catch (e) { logWarn('sin bloqueo de orientación: ' + e.message); }
  try { navigator.wakeLock?.request?.('screen')?.catch?.(e => logWarn('sin wake lock: ' + e.message)); }
  catch (e) { logWarn('sin wake lock: ' + e.message); }
}

export async function exitImmersive() {
  try { await screen.orientation?.unlock?.(); } catch {}
  try { if (document.fullscreenElement) await document.exitFullscreen(); } catch {}
}
