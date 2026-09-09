// Orquestador: renderer, cambio de modo, sesión WebXR y paneles DOM.
import * as THREE from 'three';
import { config, setConfig, nudgeConfig, resetConfig, SCHEMA } from './config.js';
import { Logger } from './logger.js';
import { Rig, LAYER_LEFT, LAYER_RIGHT } from './stereo.js';
import { Interaction, disposeTree } from './interaction.js';
import { HeadTracker } from './orientation.js';
import { CameraFeed } from './camerafeed.js';
import { HandTracker } from './hands.js';
import { calibrationGrid, textPanel } from './textures.js';
import { buildButtonRow, halfHeightAt } from './layout.js';
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
    // Sin dom-overlay la UI de AR es 3D y se selecciona con la mirada: el dwell
    // necesita que el bucle de interacción corra también acá.
    interaction.update(dt);
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

// ---------------------------------------------------------------- ajuste del visor
// Patrón de ajuste con dos partes:
//   · rejilla a pantalla completa, para k1/k2 y aberración cromática;
//   · blanco de fusión binocular con marcas monoculares (tipo nonius) para
//     ajustar la separación de las dos imágenes, que es el parámetro que decide
//     si la imagen fusiona o se ve doble.
// Los controles están adentro del visor a propósito: sacar el teléfono, mover un
// slider y volver a meterlo hace imposible converger.
const FUSION_DIST = 6;                                   // casi infinito: paralaje despreciable
const angSize = (deg, dist) => 2 * dist * Math.tan(deg * Math.PI / 360);

/** Material plano que ignora el z-buffer: el blanco va SIEMPRE sobre la rejilla. */
function overlayMat(opt) {
  return new THREE.MeshBasicMaterial({ depthTest: false, depthWrite: false, ...opt });
}

function createCalibPreview(c) {
  const root = new THREE.Group();
  const overlay = new THREE.Group();       // todo lo que va por encima de la rejilla
  let readout = null;

  const ang = deg => angSize(deg, FUSION_DIST);

  /** Barra vertical que ve un solo ojo, centrada a `yDeg` grados del centro. */
  function bar(color, yDeg, layer) {
    const m = new THREE.Mesh(
      new THREE.PlaneGeometry(ang(0.7), ang(4.5)),
      overlayMat({ color })
    );
    m.position.set(0, Math.sign(yDeg) * ang(Math.abs(yDeg)) / 2, -FUSION_DIST);
    m.renderOrder = 12;
    m.layers.set(layer);
    return m;
  }

  /**
   * Blanco de fusión. El disco y el anillo los ven los dos ojos y sirven de
   * candado de convergencia; las dos barras las ve un ojo cada una. Si la
   * separación de imágenes es la correcta, naranja y verde caen en la misma
   * vertical. Si no, se ven corridas, y cuánto se corren dice cuánto falta.
   */
  function fusionTarget() {
    const g = new THREE.Group();
    // Opaco a propósito: three dibuja TODO lo transparente después de lo opaco,
    // así que un disco translúcido terminaría pintado encima del anillo y de las
    // barras por más renderOrder que se les ponga, y se verían apagados.
    const disc = new THREE.Mesh(
      new THREE.CircleGeometry(ang(26) / 2, 64),
      overlayMat({ color: 0x05080c })
    );
    const ring = new THREE.Mesh(
      new THREE.RingGeometry(ang(11) / 2, ang(12) / 2, 64),
      overlayMat({ color: 0x4cc2ff })
    );
    const dot = new THREE.Mesh(
      new THREE.CircleGeometry(ang(0.7) / 2, 16),
      overlayMat({ color: 0xffffff })
    );
    disc.renderOrder = 10; ring.renderOrder = 11; dot.renderOrder = 12;
    for (const m of [disc, ring, dot]) m.position.z = -FUSION_DIST;
    g.add(disc, ring, dot, bar(0xffb454, 8.5, LAYER_LEFT), bar(0x3ddc97, -8.5, LAYER_RIGHT));
    return g;
  }

  function paintReadout() {
    if (readout) { overlay.remove(readout); disposeTree(readout); }
    const { texture, aspect } = textPanel([
      `separación ${config.imgSep.toFixed(1)} %   ·   k1 ${config.k1.toFixed(2)}`,
      'naranja arriba y verde abajo, en UNA sola línea vertical',
      'las rectas rectas, los círculos redondos',
    ], { fontSize: 34, width: 1024, bg: '#0d1420ee' });
    // En NDC y no en grados: si el FOV configurado no coincide con el real, el
    // texto tiene que seguir entrando en pantalla igual.
    const D = 1.6;
    const hh = halfHeightAt(c.rig, D);
    const w = Math.min(angSize(34, D), 2 * hh * c.rig.viewAspect * 0.9);
    readout = new THREE.Mesh(
      new THREE.PlaneGeometry(w, w / aspect),
      overlayMat({ map: texture, transparent: true })
    );
    readout.renderOrder = 13;
    readout.position.set(0, hh * 0.78, -D);
    overlay.add(readout);
  }

  return {
    title: 'Ajuste del visor',
    needsCamera: false,
    usesPassthrough: false,
    init() {
      c.scene.add(root);
      root.add(overlay);
      // La rejilla llena el campo entero: los bordes son justo lo que hay que juzgar.
      const side = 2 * 2 * Math.tan(c.rig.fov * Math.PI / 360);
      const grid = new THREE.Mesh(
        new THREE.PlaneGeometry(side, side),
        new THREE.MeshBasicMaterial({ map: calibrationGrid(1024) })
      );
      grid.position.set(0, 0, -2);
      root.add(grid);
      overlay.add(fusionTarget());
      paintReadout();

      const nudge = (k, d) => () => { nudgeConfig(k, d); c.rig.syncCameraParams(); paintReadout(); refreshFoot(); };
      const rows = [
        [{ label: '◀ juntar', onSelect: nudge('imgSep', -0.5) },
         { label: 'separar ▶', onSelect: nudge('imgSep', +0.5) }],
        [{ label: 'k1 −', onSelect: nudge('k1', -0.01) },
         { label: 'k1 +', onSelect: nudge('k1', +0.01) },
         { label: 'Salir ✕', onSelect: () => c.exit() }],
      ];
      const targets = [];
      rows.forEach((items, i) => {
        buildButtonRow(c.rig, items, { dist: 1.4, yNdc: i === 0 ? -0.52 : -0.82, hFrac: 0.1 })
          .forEach((b, j) => {
            // Ajustar de a 0,5% a 1,2 s por paso sería eterno: los botones que
            // repiten se disparan mucho más rápido. El de salir, no: es el único
            // que no se puede deshacer mirando para otro lado.
            if (items[j].label !== 'Salir ✕') b.userData.dwellScale = 0.3;
            root.add(b); targets.push(b);
          });
      });
      c.interaction.setTargets(targets);
    },
    update() {},
    dispose() { c.scene.remove(root); disposeTree(root); },
  };
}

// ---------------------------------------------------------------- WebXR AR
// Un toque sobre la UI del overlay no debe contar como "select" del mundo AR.
el.overlay.addEventListener('beforexrselect', ev => ev.preventDefault());

// Un solo feature no soportado hace fallar TODA la sesión con el mismo mensaje
// genérico ("The specified session configuration is not supported"), sin decir
// cuál. La única forma de averiguarlo —y de arrancar igual sin él— es probar de
// la configuración más completa a la más pobre y anotar qué falló en cada paso.
//
// `local` NO va en requiredFeatures: la spec ya lo garantiza en toda sesión
// inmersiva, y pedirlo explícitamente solo agrega una forma más de fallar.
const AR_TRIES = [
  { name: 'completa',     required: ['hit-test'], optional: ['dom-overlay', 'anchors', 'light-estimation'], overlay: true },
  { name: 'sin extras',   required: ['hit-test'], optional: ['dom-overlay'], overlay: true },
  { name: 'sin overlay',  required: ['hit-test'], optional: [], overlay: false },
  { name: 'sin hit-test', required: [], optional: ['dom-overlay', 'hit-test'], overlay: true },
  { name: 'mínima',       required: [], optional: [], overlay: false },
];

// Solo estos dos errores significan "esta combinación de features no va". Con
// cualquier otro (permiso denegado, sesión ya activa, contexto inseguro) probar
// otra configuración no cambia nada y encima le vuelve a saltar el diálogo al
// usuario, así que se corta ahí.
const AR_RETRYABLE = new Set(['NotSupportedError', 'TypeError']);

// Un rechazo por features no soportadas es inmediato. Si tardó más que esto,
// hubo un diálogo de por medio (instalar ARCore, permiso de cámara) y el usuario
// lo cerró: reintentar solo se lo vuelve a tirar por la cara.
const AR_DIALOG_MS = 3000;

async function requestARSession() {
  const tried = [];
  for (const [i, t] of AR_TRIES.entries()) {
    const init = { requiredFeatures: t.required, optionalFeatures: t.optional };
    if (t.overlay) init.domOverlay = { root: el.overlay };
    const t0 = performance.now();
    try {
      const session = await navigator.xr.requestSession('immersive-ar', init);
      if (i > 0) logWarn(`AR: arrancó recién con la configuración "${t.name}"`);
      return { session, tried };
    } catch (e) {
      const ms = Math.round(performance.now() - t0);
      tried.push({ name: t.name, kind: e.name, ms, msg: `${e.name}: ${e.message} (${ms} ms)` });
      logWarn(`AR "${t.name}" falló en ${ms} ms · ${e.name}: ${e.message}`);
      if (!AR_RETRYABLE.has(e.name)) break;
      if (ms > AR_DIALOG_MS) { logWarn('AR: el rechazo tardó demasiado, parece un diálogo cancelado; no se reintenta'); break; }
    }
  }
  return { session: null, tried };
}

/** Traduce los errores de requestSession a algo accionable. */
function arDiagnosis(tried, supported) {
  const kinds = new Set(tried.map(t => t.kind));
  const out = [];

  if (!window.isSecureContext) {
    out.push('La página no está en un contexto seguro. WebXR solo funciona sobre HTTPS o en localhost.');
  } else if (kinds.has('SecurityError')) {
    out.push('El navegador bloqueó la sesión por permisos. Si abriste la página dentro de otra app (Instagram, WhatsApp, un iframe), abrila directo en Chrome.');
  } else if (kinds.has('NotAllowedError')) {
    out.push('Se denegó el permiso. Chrome pide cámara para AR y, si hace falta, instalar o actualizar "Servicios de Google Play para RA". Volvé a intentar y aceptá los dos diálogos.');
  } else if (kinds.has('InvalidStateError')) {
    out.push('Ya hay otra sesión XR abierta. Cerrá la otra pestaña o reiniciá Chrome.');
  } else if (tried.some(t => t.ms > AR_DIALOG_MS)) {
    out.push('El intento tardó varios segundos antes de fallar: casi seguro se abrió un diálogo (instalar "Servicios de Google Play para RA", o el permiso de cámara) y se canceló. Volvé a tocar el botón y aceptá lo que pida.');
  } else if (supported === false) {
    out.push('Este navegador dice que no soporta immersive-ar. Hace falta Chrome (no Firefox, no Samsung Internet viejo) en Android.');
  } else {
    // Caso típico: isSessionSupported() dice true porque el teléfono PODRÍA
    // soportarlo, y recién requestSession() descubre que ARCore no está.
    out.push('Chrome dice que el dispositivo podría soportar AR, pero la sesión no arranca. Casi siempre es ARCore:');
    out.push('1. Instalá o actualizá "Servicios de Google Play para RA" desde Play Store.');
    out.push('2. Abrí esa app una vez para que termine de configurarse.');
    out.push('3. Verificá que tu teléfono esté en la lista de dispositivos certificados de ARCore (developers.google.com/ar/devices). Muchos gama de entrada NO lo están, y ahí no hay nada que hacer desde la web.');
    out.push('4. Actualizá Chrome; hit-test necesita Chrome 81 o más nuevo.');
  }

  out.push('');
  out.push('Detalle de los intentos:');
  tried.forEach(t => out.push(`  · ${t.name} → ${t.msg}`));
  out.push(`isSessionSupported('immersive-ar') = ${supported}`);
  out.push(`secureContext = ${window.isSecureContext} · navigator.xr = ${!!navigator.xr}`);
  out.push(navigator.userAgent);
  return out.join('\n');
}

function showARDiagnosis(text) {
  const box = document.querySelector('#ar-diag');
  box.textContent = text;
  box.classList.remove('hidden');
  box.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  logErr('AR no arrancó — ver el diagnóstico en la pantalla de inicio');
}

async function startAR() {
  document.querySelector('#ar-diag').classList.add('hidden');
  if (!navigator.xr) {
    return showARDiagnosis('Este navegador no expone navigator.xr, así que no tiene WebXR.\n\n'
      + 'Hace falta Chrome en Android. Safari/iOS no tiene WebXR y no hay forma de habilitarlo.\n\n'
      + navigator.userAgent);
  }

  await stopTest(true);
  const { session, tried } = await requestARSession();
  if (!session) {
    let supported = null;
    try { supported = await navigator.xr.isSessionSupported('immersive-ar'); } catch {}
    return showARDiagnosis(arDiagnosis(tried, supported));
  }

  arSession = session;
  mode = 'ar';
  rig.mode = 'mono';
  scene.background = null;
  renderer.xr.enabled = true;
  renderer.setClearAlpha(0);

  // three.js pide 'local-floor' por defecto, y la spec solo garantiza 'viewer' y
  // 'local' en una sesión inmersiva: si el dispositivo no concedió local-floor,
  // setSession() explota DESPUÉS de haber abierto la sesión y queda todo colgado.
  // Acá alcanza con 'local' — se miden distancias entre puntos marcados, no
  // alturas contra el piso.
  renderer.xr.setReferenceSpaceType('local');
  try {
    await renderer.xr.setSession(session);
  } catch (e) {
    logErr('setSession: ' + e.message);
    await session.end().catch(() => {});
    return showARDiagnosis('La sesión AR se abrió pero el renderer no pudo engancharla:\n\n'
      + `${e.name}: ${e.message}\n\n` + navigator.userAgent);
  }

  // `enabledFeatures` es lo único que dice qué concedió de verdad el navegador;
  // los viejos no lo exponen, así que ahí se prueba y se ve qué pasa.
  const enabled = session.enabledFeatures ? [...session.enabledFeatures] : null;
  const viewerSpace = await session.requestReferenceSpace('viewer');
  hitTestSource = null;
  if (!enabled || enabled.includes('hit-test')) {
    try { hitTestSource = await session.requestHitTestSource({ space: viewerSpace }); }
    catch (e) { logWarn('sin hit-test: ' + e.message); }
  }

  const test = createARTest(ctx);
  currentTest = test;
  test.setFeatures({
    domOverlay: !!session.domOverlayState,
    hitTest: !!hitTestSource,
    enabled,
  });

  session.addEventListener('select', () => { try { test.onSelect(); } catch (e) { logErr('select: ' + e.message); } });
  session.addEventListener('end', onARend);

  showAR();
  test.start();
  logOk(`sesión AR iniciada · features: ${enabled ? enabled.join(', ') : 'no informadas'}`);
}

function updateAR(frame) {
  if (!frame || !currentTest?.onFrame) return;
  const refSpace = renderer.xr.getReferenceSpace();
  if (!refSpace) return;

  if (hitTestSource) {
    const results = frame.getHitTestResults(hitTestSource);
    const pose = results.length ? results[0].getPose(refSpace) : null;
    if (pose) hitMatrix.fromArray(pose.transform.matrix);
    return currentTest.onFrame(pose ? hitMatrix : null);
  }

  // Sin hit-test el punto apuntado es la posición del propio teléfono: se marca
  // apoyándolo contra el punto físico. Es menos cómodo, pero la deriva y la
  // escala se miden igual de bien porque solo dependen del tracking 6DOF.
  const viewer = frame.getViewerPose(refSpace);
  if (!viewer) return currentTest.onFrame(null);
  hitMatrix.fromArray(viewer.transform.matrix);
  currentTest.onFrame(hitMatrix);
}

function onARend() {
  hitTestSource = null;
  arSession = null;
  renderer.xr.enabled = false;
  renderer.setClearAlpha(1);
  mode = 'idle';
  if (currentTest) { try { currentTest.dispose(); } catch {} currentTest = null; }
  interaction.setTargets([]);
  interaction.setMode('touch');
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
    if (kind === 'calib') { buildCalib(); return showPanel('calib'); }
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
    `${Logger.records.length} registros · ${px}px vert. · sep ${config.imgSep}% · IPD ${config.ipd}mm · FOV ${config.fov}° · sesión ${Logger.session.id}`;
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
