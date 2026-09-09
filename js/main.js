// Orquestador: renderer, cambio de modo, sesión WebXR y paneles DOM.
import * as THREE from 'three';
import { config, setConfig, resetConfig, SCHEMA } from './config.js';
import { Logger } from './logger.js';
import { Rig } from './stereo.js';
import { Interaction, disposeTree } from './interaction.js';
import { HeadTracker } from './orientation.js';
import { CameraFeed } from './camerafeed.js';
import { HandTracker } from './hands.js';
import { calibrationGrid } from './textures.js';
import { buildButtonRow } from './layout.js';
import { createVisibilityTest } from './tests/visibility.js';
import { createHandTest } from './tests/handprecision.js';
import { createARTest } from './tests/arprecision.js';
import {
  el, showPanel, showHud, hudStatus, showAR,
  log, logOk, logWarn, logErr, setChips, goImmersive, exitImmersive,
} from './ui.js';

// Valores de display crudos: sin conversiones a lineal y de vuelta. Es la única
// forma de que el test de contraste mida la pantalla y no la gestión de color
// de three.js (un gris 128 tiene que llegar al panel como 128).
THREE.ColorManagement.enabled = false;

// ---------------------------------------------------------------- renderer
const renderer = new THREE.WebGLRenderer({
  canvas: el.canvas, antialias: true, alpha: true, powerPreference: 'high-performance',
});
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
renderer.outputColorSpace = THREE.LinearSRGBColorSpace;   // sin OETF de salida
renderer.setClearColor(0x0a0f16, 1);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x0a0f16);
const rig = new Rig(renderer);
const head = rig.camera;
scene.add(head);

const interaction = new Interaction();
interaction.attach(head);
interaction.bindDom(el.canvas);

const headTracker = new HeadTracker();
const feed = new CameraFeed();
const hands = new HandTracker();

let currentTest = null;
let mode = 'idle';                 // idle | mono | stereo | ar
let arSession = null, hitTestSource = null;
const hitMatrix = new THREE.Matrix4();
let lastT = performance.now();
let fpsAcc = 0, fpsN = 0;

const ctx = {
  scene, head, rig, interaction, feed, hands, renderer, fps: null,
  exit: () => stopTest(),
};

// ---------------------------------------------------------------- tamaño
function resize() {
  const w = window.innerWidth, h = window.innerHeight;
  renderer.setSize(w, h, false);
  rig.setSize(w, h);
  rig.syncCameraParams();
}
window.addEventListener('resize', resize);
screen.orientation?.addEventListener?.('change', () => setTimeout(resize, 250));
resize();

// ---------------------------------------------------------------- ciclo
renderer.setAnimationLoop((t, frame) => {
  const now = performance.now();
  const dt = Math.min(0.1, (now - lastT) / 1000);
  lastT = now;
  fpsAcc += dt; fpsN++;
  if (fpsAcc >= 1) { ctx.fps = Math.round(fpsN / fpsAcc); fpsAcc = 0; fpsN = 0; }

  if (mode === 'ar') {
    updateAR(frame);
    renderer.render(scene, head);
    return;
  }

  if (mode === 'stereo') headTracker.apply(head);

  if (currentTest?.usesPassthrough && feed.ready && feed.texture) {
    feed.fitTo(rig.viewAspect);
    rig.setPassthrough(feed.texture, feed.crop);
  } else {
    rig.setPassthrough(null);
  }

  scene.updateMatrixWorld(true);
  try { currentTest?.update?.(dt); } catch (e) { logErr('update: ' + e.message); }
  interaction.update(dt);
  rig.render(scene, head);
});

// ---------------------------------------------------------------- tests
const FACTORIES = {
  visibility: createVisibilityTest,
  hands: createHandTest,
  calibpreview: createCalibPreview,
};

async function startTest(kind, presentation) {
  const factory = FACTORIES[kind];
  if (!factory) return logErr('test desconocido: ' + kind);

  await stopTest(true);

  rig.mode = presentation;
  resize();

  const test = factory(ctx);
  showHud(test.title + (presentation === 'stereo' ? ' · visor' : ' · pantalla'));

  if (test.needsCamera) {
    hudStatus('pidiendo cámara…');
    if (!await feed.start()) {
      alert('Sin acceso a la cámara no se puede correr este test.');
      return stopTest();
    }
  }
  if (test.needsHands) {
    hudStatus('cargando hand tracking…');
    await hands.init();
    hands.reset();
  }

  if (presentation === 'stereo') {
    await goImmersive();
    await headTracker.start();
    headTracker.recenter();
    interaction.setMode('gaze');
    setTimeout(resize, 300);
  } else {
    interaction.setMode('touch');
  }

  head.position.set(0, 0, 0);
  head.quaternion.identity();

  currentTest = test;
  mode = presentation;
  hudStatus('');
  test.init();          // el test puede escribir su propio estado en el HUD
  logOk(`inicio: ${kind} (${presentation})`);
}

async function stopTest(silent = false) {
  if (currentTest) {
    try { currentTest.dispose(); } catch (e) { logWarn('dispose: ' + e.message); }
    currentTest = null;
  }
  interaction.setTargets([]);
  interaction.setMode('touch');
  headTracker.stop();
  rig.setPassthrough(null);
  scene.background = new THREE.Color(0x0a0f16);
  mode = 'idle';
  rig.mode = 'mono';
  resize();
  if (!silent) {
    await exitImmersive();
    goHome();
  }
}

// ---------------------------------------------------------------- vista previa de calibración
function createCalibPreview(c) {
  const root = new THREE.Group();
  return {
    title: 'Vista previa de calibración',
    needsCamera: false,
    usesPassthrough: false,
    init() {
      c.scene.add(root);
      // La rejilla llena el campo entero: los bordes son justo lo que hay que juzgar.
      const side = 2 * 2 * Math.tan(c.rig.fov * Math.PI / 360);
      const grid = new THREE.Mesh(
        new THREE.PlaneGeometry(side, side),
        new THREE.MeshBasicMaterial({ map: calibrationGrid(1024) })
      );
      grid.position.set(0, 0, -2);
      root.add(grid);
      const btns = buildButtonRow(c.rig, [{ label: 'Salir ✕', onSelect: () => c.exit() }],
        { dist: 1.4, yNdc: -0.84, hFrac: 0.11 });
      btns.forEach(b => root.add(b));
      c.interaction.setTargets(btns);
    },
    update() {},
    dispose() { c.scene.remove(root); disposeTree(root); },
  };
}

// ---------------------------------------------------------------- WebXR AR
// Un toque sobre la UI del overlay no debe contar como "select" del mundo AR.
el.overlay.addEventListener('beforexrselect', ev => ev.preventDefault());

async function startAR() {
  if (!navigator.xr) return alert('Este navegador no tiene WebXR. Usá Chrome en Android.');
  let supported = false;
  try { supported = await navigator.xr.isSessionSupported('immersive-ar'); } catch {}
  if (!supported) {
    return alert('immersive-ar no está disponible.\n\nNecesitás Chrome en Android con "Servicios de Google Play para RA" (ARCore) instalado.');
  }

  await stopTest(true);
  let session;
  try {
    session = await navigator.xr.requestSession('immersive-ar', {
      requiredFeatures: ['hit-test', 'local'],
      optionalFeatures: ['dom-overlay', 'anchors', 'light-estimation', 'local-floor'],
      domOverlay: { root: el.overlay },
    });
  } catch (e) {
    return alert('No se pudo iniciar AR: ' + e.message);
  }

  arSession = session;
  mode = 'ar';
  rig.mode = 'mono';
  scene.background = null;
  renderer.xr.enabled = true;
  renderer.setClearAlpha(0);
  await renderer.xr.setSession(session);

  const test = createARTest(ctx);
  currentTest = test;
  test.setFeatures({
    domOverlay: !!session.domOverlayState,
    enabled: session.enabledFeatures ? [...session.enabledFeatures] : null,
  });

  const viewerSpace = await session.requestReferenceSpace('viewer');
  hitTestSource = await session.requestHitTestSource({ space: viewerSpace });

  session.addEventListener('select', () => { try { test.onSelect(); } catch (e) { logErr('select: ' + e.message); } });
  session.addEventListener('end', onARend);

  showAR();
  test.start();
  logOk('sesión AR iniciada');
}

function updateAR(frame) {
  if (!frame || !hitTestSource || !currentTest?.onFrame) return;
  const refSpace = renderer.xr.getReferenceSpace();
  const results = frame.getHitTestResults(hitTestSource);
  if (results.length) {
    const pose = results[0].getPose(refSpace);
    if (pose) { hitMatrix.fromArray(pose.transform.matrix); currentTest.onFrame(hitMatrix); return; }
  }
  currentTest.onFrame(null);
}

function onARend() {
  hitTestSource = null;
  arSession = null;
  renderer.xr.enabled = false;
  renderer.setClearAlpha(1);
  mode = 'idle';
  if (currentTest) { try { currentTest.dispose(); } catch {} currentTest = null; }
  scene.background = new THREE.Color(0x0a0f16);
  resize();
  goHome();
  log('sesión AR terminada');
}

// ---------------------------------------------------------------- paneles DOM
function goHome() { showPanel('home'); refreshFoot(); }

document.querySelectorAll('[data-go]').forEach(b => {
  b.addEventListener('click', () => {
    const [kind, pres] = b.dataset.go.split(':');
    if (kind === 'home') return goHome();
    if (kind === 'calib') return showPanel('calib');
    if (kind === 'results') return renderResults();
    if (kind === 'calibpreview') return startTest('calibpreview', 'stereo');
    startTest(kind, pres || 'mono');
  });
});
document.querySelector('#btn-ar').addEventListener('click', startAR);
document.querySelector('#hud-exit').addEventListener('click', () => {
  if (arSession) arSession.end().catch(() => {});
  else stopTest();
});

// --- calibración ---
function buildCalib() {
  const wrap = document.querySelector('#calib-sliders');
  wrap.innerHTML = '';
  for (const s of SCHEMA) {
    const d = document.createElement('div');
    d.className = 'sl';
    const val = document.createElement('b');
    val.textContent = `${config[s.k]}${s.unit ? ' ' + s.unit : ''}`;
    const lab = document.createElement('label');
    lab.append(document.createTextNode(s.label + ' '), val);
    const inp = document.createElement('input');
    inp.type = 'range';
    inp.min = s.min; inp.max = s.max; inp.step = s.step; inp.value = config[s.k];
    inp.oninput = () => {
      const v = parseFloat(inp.value);
      setConfig(s.k, v);
      val.textContent = `${v}${s.unit ? ' ' + s.unit : ''}`;
      rig.syncCameraParams();
      refreshFoot();
    };
    const desc = document.createElement('div');
    desc.className = 'desc';
    desc.textContent = s.desc;
    d.append(lab, inp, desc);
    wrap.appendChild(d);
  }
}
document.querySelector('#calib-reset').addEventListener('click', () => {
  resetConfig(); buildCalib(); rig.syncCameraParams();
});

// --- resultados ---
function renderResults() {
  showPanel('results');
  const n = Logger.records.length;
  document.querySelector('#results-count').textContent =
    n ? `${n} registro${n > 1 ? 's' : ''} guardado${n > 1 ? 's' : ''}` : 'Todavía no hay resultados.';
  document.querySelector('#results-dump').textContent = n
    ? Logger.records.map(r => `• ${r.t.slice(11, 19)} · ${r.test} · ${summaryLine(r)}`).join('\n')
      + '\n\n' + Logger.toJSON()
    : '—';
}

function summaryLine(r) {
  if (r.test === 'visibility') {
    return `agudeza ${r.acuityGapArcmin ?? '—'}′ · contraste ${r.contrastThreshold ?? '—'} · ${r.arcminPerPixel}′/px [${r.mode}]`;
  }
  if (r.test === 'hands') {
    return `err p50 ${r.pinch?.errDeg?.p50 ?? '—'}° · pinch ${Math.round((r.pinch?.hitRate ?? 0) * 100)}% · jitter ${r.jitterRmsDeg ?? '—'}° [${r.mode}]`;
  }
  if (r.test === 'ar') {
    return `colocación ${r.placement?.errorMm?.p50 ?? '—'}mm · deriva ${r.drift?.driftMm?.p50 ?? '—'}mm · escala ${r.scale?.errorPct?.p50 ?? '—'}%`;
  }
  return '';
}

document.querySelector('#res-download').addEventListener('click', () => Logger.download());
document.querySelector('#res-copy').addEventListener('click', async () => {
  alert(await Logger.copy() ? 'JSON copiado al portapapeles.' : 'No se pudo copiar; usá Descargar.');
});
document.querySelector('#res-clear').addEventListener('click', () => {
  if (confirm('¿Borrar todos los resultados guardados?')) { Logger.clear(); renderResults(); }
});

// ---------------------------------------------------------------- soporte
async function detectSupport() {
  const s = {
    secureContext: window.isSecureContext,
    webgl2: !!document.createElement('canvas').getContext('webgl2'),
    getUserMedia: !!navigator.mediaDevices?.getUserMedia,
    deviceOrientation: 'DeviceOrientationEvent' in window,
    webxr: !!navigator.xr,
    immersiveAR: null,
  };
  if (navigator.xr) {
    try { s.immersiveAR = await navigator.xr.isSessionSupported('immersive-ar'); } catch { s.immersiveAR = false; }
  }
  Logger.session.support = s;
  setChips([
    { label: s.secureContext ? 'HTTPS ✓' : 'sin HTTPS ✗', ok: s.secureContext },
    { label: s.getUserMedia ? 'cámara ✓' : 'cámara ✗', ok: s.getUserMedia },
    { label: s.deviceOrientation ? 'giroscopio ✓' : 'giroscopio ✗', ok: s.deviceOrientation },
    { label: s.immersiveAR ? 'WebXR AR ✓' : 'WebXR AR ✗', ok: !!s.immersiveAR },
    { label: `${window.innerWidth}×${window.innerHeight} @${(window.devicePixelRatio || 1).toFixed(1)}x` },
  ]);
  if (!s.secureContext) logErr('el sitio no está en HTTPS: cámara, sensores y WebXR van a fallar');
  if (!s.immersiveAR) logWarn('immersive-ar no disponible en este dispositivo/navegador');
  return s;
}

function refreshFoot() {
  const px = Math.round(window.innerHeight * (window.devicePixelRatio || 1));
  document.querySelector('#foot-info').textContent =
    `${Logger.records.length} registros · ${px}px vert. · IPD ${config.ipd}mm · FOV ${config.fov}° · sesión ${Logger.session.id}`;
}

// Gancho de inspección: dentro del visor no hay devtools, y para depurar la
// calibración hace falta poder leer el estado real desde afuera.
window.__bench = { THREE, renderer, scene, rig, head, interaction, config, Logger, feed, hands,
                   get mode() { return mode; }, get test() { return currentTest; } };

// ---------------------------------------------------------------- arranque
buildCalib();
goHome();
detectSupport();
Logger.onLog(refreshFoot);
log('XR Test Bench listo');
