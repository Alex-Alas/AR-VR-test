// TEST 1 · VISIBILIDAD
// Mide agudeza visual con anillos de Landolt (elección forzada de 4), umbral de
// contraste (2AFC) y dos comprobaciones subjetivas de geometría/color sobre la
// rejilla de calibración. Corre igual en pantalla y dentro del visor, así que
// los números son comparables entre los dos.
import * as THREE from 'three';
import { landoltC, angularSize, calibrationGrid } from '../textures.js';
import { disposeTree } from '../interaction.js';
import { buildButtonRow, buildPanel, placeNdc } from '../layout.js';
import { Logger } from '../logger.js';
import { hudStatus, log } from '../ui.js';
import { config } from '../config.js';

const DIST = 2.0;                                   // distancia virtual del estímulo, en metros
const GAPS = [16, 10, 6, 4, 2.5, 1.5];              // tamaño del hueco, en minutos de arco
const TRIALS_PER_SIZE = 2;
// Contraste de Weber (ΔL/L) contra un fondo gris medio. Por debajo de ~2% el
// panel de 8 bits ya no puede representar el escalón, así que ese es el piso útil.
const CONTRASTS = [0.64, 0.32, 0.16, 0.08, 0.04, 0.02];
const GAMMA = 2.2;
const BG_VALUE = 0.5;
const DIRS = ['up', 'down', 'left', 'right'];
const DIR_LABEL = { up: '▲ arriba', down: '▼ abajo', left: '◀ izquierda', right: '▶ derecha' };

export function createVisibilityTest(ctx) {
  const { scene, interaction } = ctx;
  const root = new THREE.Group();
  const buttons = new THREE.Group();
  root.add(buttons);

  let stimulus = null;
  let armed = 0;
  const results = { acuity: [], contrast: [], grid: {} };
  let queue = [];
  let step = null;

  // ---------- helpers ----------
  function clearButtons() {
    buttons.children.slice().forEach(b => { buttons.remove(b); disposeTree(b); });
    interaction.setTargets([]);
  }

  function clearStimulus() {
    if (!stimulus) return;
    root.remove(stimulus);
    disposeTree(stimulus);
    stimulus = null;
  }

  /** Fila de botones, siempre visible sea cual sea el FOV del modo. */
  function setButtons(items, opts = {}) {
    clearButtons();
    const wrapped = items.map(it => ({ label: it.label, onSelect: () => { if (armed <= 0) it.onSelect(); } }));
    buildButtonRow(ctx.rig, wrapped, opts).forEach(b => buttons.add(b));
    interaction.setTargets(buttons.children);
    armed = 0.5;   // medio segundo de gracia para que la retícula no active sin querer
  }

  function showPanel(lines, opt = {}) {
    clearStimulus();
    stimulus = buildPanel(ctx.rig, lines, opt);
    root.add(stimulus);
  }

  // ---------- pasos ----------
  function stepIntro() {
    showPanel([
      'TEST 1 · VISIBILIDAD',
      '',
      '1) Agudeza: mirá el anillo e indicá',
      '   de qué lado está el hueco.',
      '2) Contraste: decí de qué lado está',
      '   el parche más claro.',
      '3) Geometría de la lente.',
      '',
      'Se selecciona mirando y sosteniendo.',
    ], { fontSize: 40 });
    setButtons([{ label: 'Comenzar ▶', onSelect: next }]);
  }

  function makeAcuityQueue() {
    const q = [];
    for (const gap of GAPS) {
      for (let i = 0; i < TRIALS_PER_SIZE; i++) {
        q.push(() => acuityTrial(gap, DIRS[(Math.random() * 4) | 0]));
      }
    }
    return q;
  }

  function acuityTrial(gapArcmin, dir) {
    clearStimulus();
    const tex = landoltC(dir, 512);
    // El anillo dibujado ocupa el 92% del canvas; D exterior = 5 x hueco.
    const size = angularSize(gapArcmin * 5, DIST) / 0.92;
    stimulus = new THREE.Mesh(
      new THREE.PlaneGeometry(size, size),
      new THREE.MeshBasicMaterial({ map: tex })
    );
    placeNdc(stimulus, ctx.rig, 0, 0.18, DIST);
    root.add(stimulus);

    const answer = given => {
      results.acuity.push({ gapArcmin, shown: dir, given, correct: given === dir });
      next();
    };
    setButtons([
      { label: '◀', onSelect: () => answer('left') },
      { label: '▲', onSelect: () => answer('up') },
      { label: '▼', onSelect: () => answer('down') },
      { label: '▶', onSelect: () => answer('right') },
      { label: '?', onSelect: () => answer('none') },
    ], { hFrac: 0.14, yNdc: -0.7 });
    hudStatus(`agudeza · hueco ${gapArcmin}′`);
  }

  function makeContrastQueue() {
    return CONTRASTS.map(c => () => contrastTrial(c, Math.random() < 0.5 ? 'left' : 'right'));
  }

  function contrastTrial(contrast, side) {
    clearStimulus();
    const g = new THREE.Group();
    const bg = new THREE.Mesh(
      new THREE.PlaneGeometry(1.8, 0.9),
      new THREE.MeshBasicMaterial({ color: new THREE.Color(BG_VALUE, BG_VALUE, BG_VALUE) })
    );
    bg.position.z = -0.004;
    g.add(bg);
    // Weber: L1 = L0 (1 + C), y de vuelta a valor de display con gamma 2.2.
    const L0 = Math.pow(BG_VALUE, GAMMA);
    const v = Math.pow(Math.min(1, L0 * (1 + contrast)), 1 / GAMMA);
    const patch = new THREE.Mesh(
      new THREE.PlaneGeometry(0.55, 0.55),
      new THREE.MeshBasicMaterial({ color: new THREE.Color(v, v, v) })
    );
    // El escalón real en 8 bits: si es 0, el estímulo no existe en este panel.
    const codeStep = Math.round(v * 255) - Math.round(BG_VALUE * 255);
    patch.position.x = side === 'left' ? -0.42 : 0.42;
    g.add(patch);
    placeNdc(g, ctx.rig, 0, 0.18, DIST);
    stimulus = g;
    root.add(g);

    const answer = given => {
      results.contrast.push({ contrast, side, given, correct: given === side, codeStep });
      next();
    };
    setButtons([
      { label: '◀ izq', onSelect: () => answer('left') },
      { label: 'no veo', onSelect: () => answer('none') },
      { label: 'der ▶', onSelect: () => answer('right') },
    ], { hFrac: 0.14, yNdc: -0.7 });
    hudStatus(`contraste · ${(contrast * 100).toFixed(1)}%`);
  }

  function stepGrid() {
    clearStimulus();
    const tex = calibrationGrid(1024);
    // La rejilla ocupa todo el campo: es lo que queremos evaluar, incluidos los bordes.
    const side = 2 * 1.9 * Math.tan(ctx.rig.fov * Math.PI / 360) * 1.0;
    stimulus = new THREE.Mesh(new THREE.PlaneGeometry(side, side), new THREE.MeshBasicMaterial({ map: tex }));
    stimulus.position.set(0, 0, -1.9);
    root.add(stimulus);
    setButtons([
      { label: 'rectas ✓', onSelect: () => { results.grid.straight = true; next(); } },
      { label: 'curvadas ✗', onSelect: () => { results.grid.straight = false; next(); } },
    ], { dist: 1.4, yNdc: -0.72, hFrac: 0.12 });
    hudStatus('geometría de la lente');
  }

  function stepChroma() {
    setButtons([
      { label: 'sin color', onSelect: () => { results.grid.chromaFringe = false; next(); } },
      { label: 'franjas de color', onSelect: () => { results.grid.chromaFringe = true; next(); } },
    ], { dist: 1.4, yNdc: -0.72, hFrac: 0.12 });
    hudStatus('aberración cromática en los bordes');
  }

  function angularResolution() {
    // Minutos de arco por píxel físico en el centro de la imagen.
    const px = ctx.rig.mode === 'stereo'
      ? (ctx.rig.targets[0]?.height ?? window.innerHeight)
      : Math.round(window.innerHeight * (window.devicePixelRatio || 1));
    return +((ctx.rig.fov * 60) / px).toFixed(3);
  }

  function summarize() {
    // Agudeza: el hueco más chico con al menos la mitad de aciertos.
    const byGap = new Map();
    for (const r of results.acuity) {
      const e = byGap.get(r.gapArcmin) || { ok: 0, n: 0 };
      e.n++; if (r.correct) e.ok++;
      byGap.set(r.gapArcmin, e);
    }
    // Escalera: bajamos de tamaño y cortamos en la primera falla. Tomar el
    // acierto más chico de toda la serie sería premiar la suerte — con 4
    // opciones, adivinar acierta 1 de cada 4 veces.
    let acuityThreshold = null;
    for (const gap of GAPS) {
      const e = byGap.get(gap);
      if (!e) continue;
      if (e.ok === e.n) acuityThreshold = gap; else break;
    }
    // Mismo criterio bajando el contraste.
    let contrastThreshold = null;
    for (const c of CONTRASTS) {
      const r = results.contrast.find(x => x.contrast === c);
      if (!r) continue;
      if (r.correct) contrastThreshold = c; else break;
    }
    const arcminPerPx = angularResolution();
    const summary = {
      mode: ctx.rig.mode,
      distanceM: DIST,
      acuityGapArcmin: acuityThreshold,
      acuityLadder: GAPS.map(g => ({ gapArcmin: g, ...(byGap.get(g) || { ok: 0, n: 0 }) })),
      acuityCriterion: 'todas las respuestas correctas, cortando en la primera falla (4AFC)',
      acuitySnellenEquiv: acuityThreshold ? `20/${Math.round(20 * acuityThreshold)}` : null,
      contrastThreshold,
      contrastModel: 'weber-gamma2.2',
      arcminPerPixel: arcminPerPx,
      fps: ctx.fps ?? null,
      minLegibleTextArcmin: acuityThreshold ? +(acuityThreshold * 5 * 1.4).toFixed(1) : null,
      grid: results.grid,
      calib: { ...config },
      trials: results,
    };
    Logger.log('visibility', summary);
    log(`visibilidad: agudeza ${acuityThreshold ?? '—'}′, contraste ${contrastThreshold ?? '—'}, ${arcminPerPx}′/px`);

    showPanel([
      'RESULTADO',
      '',
      `Agudeza (hueco mínimo): ${acuityThreshold ?? '—'}′`,
      `Equivalente Snellen: ${summary.acuitySnellenEquiv ?? '—'}`,
      `Umbral de contraste: ${contrastThreshold != null ? (contrastThreshold * 100).toFixed(0) + '%' : '—'}`,
      `Resolución angular: ${arcminPerPx}′/píxel`,
      `Texto legible mínimo: ${summary.minLegibleTextArcmin ?? '—'}′`,
      '',
      'Guardado. Podés salir.',
    ], { fontSize: 38 });
    setButtons([{ label: 'Salir ✕', onSelect: () => ctx.exit() }]);
    hudStatus('listo');
  }

  function next() {
    step = queue.shift();
    if (step) step();
    else summarize();
  }

  return {
    title: 'Test 1 · Visibilidad',
    needsCamera: false,
    usesPassthrough: false,
    init() {
      scene.add(root);
      scene.background = new THREE.Color(0x0a0f16);
      queue = [
        ...makeAcuityQueue(),
        () => { showPanel(['Ahora: CONTRASTE', '', '¿De qué lado está', 'el parche más claro?'], { fontSize: 44 }); setButtons([{ label: 'Seguir ▶', onSelect: next }]); },
        ...makeContrastQueue(),
        () => { showPanel(['Ahora: GEOMETRÍA', '', 'Mirá la rejilla y decidí', 'si las líneas se ven rectas.'], { fontSize: 44 }); setButtons([{ label: 'Seguir ▶', onSelect: next }]); },
        stepGrid,
        stepChroma,
      ];
      stepIntro();
    },
    update(dt) {
      if (armed > 0) armed = Math.max(0, armed - dt);
    },
    dispose() {
      clearButtons();
      clearStimulus();
      scene.remove(root);
    },
  };
}
