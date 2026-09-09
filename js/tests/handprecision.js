// TEST 2 · PRECISIÓN DE INTERACCIÓN CON LAS MANOS
// Tarea tipo Fitts con la punta del índice detectada por cámara. Mide error de
// puntería en grados, tiempo de adquisición, sobrepasos, jitter y pérdidas de
// tracking; primero confirmando con pinch y después con dwell.
//
// El plano de trabajo va lejos (10 m) a propósito: el passthrough es monoscópico,
// así que se ve "en el infinito", y poner los objetivos lejos evita que la
// paralaje estéreo los despegue de la mano real.
import * as THREE from 'three';
import { disposeTree } from '../interaction.js';
import { buildButtonRow, buildPanel } from '../layout.js';
import { Logger, stats } from '../logger.js';
import { hudStatus, log, logWarn } from '../ui.js';
import { config, setConfig } from '../config.js';

const PLANE = 10;
const RADII_DEG = [4, 2, 1];        // radio angular del objetivo
const AMPL_DEG = [8, 16];           // amplitud del movimiento
const REPS = 2;                     // repeticiones por (radio x amplitud) y por bloque
const DWELL_CONFIRM = 0.6;          // s dentro del objetivo para confirmar en el bloque dwell
const JITTER_SECS = 3;

const deg = d => d * Math.PI / 180;
const atPlane = angleDeg => PLANE * Math.tan(deg(angleDeg));   // grados -> metros en el plano

export function createHandTest(ctx) {
  const { interaction, feed, hands, head } = ctx;

  // `world` va lejos y en unidades angulares: ahí viven los objetivos y el cursor.
  const world = new THREE.Group();
  world.position.set(0, 0, -PLANE);
  // `ui` va cerca y en coordenadas de pantalla: paneles y botones.
  const ui = new THREE.Group();
  const buttons = new THREE.Group();
  ui.add(buttons);

  // --- cursor ---
  const cursor = new THREE.Group();
  const cursorRing = new THREE.Mesh(
    new THREE.RingGeometry(atPlane(0.55), atPlane(0.8), 24),
    new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.95, depthTest: false })
  );
  const cursorDot = new THREE.Mesh(
    new THREE.CircleGeometry(atPlane(0.12), 12),
    new THREE.MeshBasicMaterial({ color: 0xffffff, depthTest: false })
  );
  cursorRing.renderOrder = 10; cursorDot.renderOrder = 11;
  cursor.add(cursorRing, cursorDot);
  cursor.visible = false;
  world.add(cursor);

  // --- objetivo ---
  const target = new THREE.Group();
  const targetDisc = new THREE.Mesh(
    new THREE.CircleGeometry(1, 32),
    new THREE.MeshBasicMaterial({ color: 0x4cc2ff, transparent: true, opacity: 0.55 })
  );
  const targetEdge = new THREE.Mesh(
    new THREE.RingGeometry(0.94, 1, 32),
    new THREE.MeshBasicMaterial({ color: 0xffffff })
  );
  const targetPip = new THREE.Mesh(
    new THREE.CircleGeometry(atPlane(0.15), 10),
    new THREE.MeshBasicMaterial({ color: 0xffffff })
  );
  targetPip.position.z = 0.01;
  target.add(targetDisc, targetEdge, targetPip);
  target.visible = false;
  world.add(target);

  let panel = null;
  let armed = 0;
  let phase = 'intro';
  let queue = [];
  const trials = [];
  const jitterSamples = [];
  let jitterT = 0;
  let pinchWasDown = false;
  let spuriousPinches = 0;
  let lastDetect = 0;
  const cursorNdc = { x: 0, y: 0, visible: false };
  let cursorValid = false;

  // estado del ensayo en curso
  let cur = null;

  // ---------- UI ----------
  function clearButtons() {
    buttons.children.slice().forEach(b => { buttons.remove(b); disposeTree(b); });
    interaction.setTargets([]);
  }

  function setButtons(items, opts = {}) {
    clearButtons();
    const wrapped = items.map(it => ({ label: it.label, onSelect: () => { if (armed <= 0) it.onSelect(); } }));
    buildButtonRow(ctx.rig, wrapped, opts).forEach(b => buttons.add(b));
    interaction.setTargets(buttons.children);
    armed = 0.5;
  }

  function showPanel(lines, fontSize = 40) {
    hidePanel();
    panel = buildPanel(ctx.rig, lines, { fontSize, dist: 2.0, yNdc: 0.2, maxHFrac: 0.5 });
    ui.add(panel);
  }

  function hidePanel() {
    if (!panel) return;
    ui.remove(panel);
    disposeTree(panel);
    panel = null;
  }

  // ---------- pasos ----------
  function stepIntro() {
    phase = 'calib';
    cursor.visible = true;
    target.visible = false;
    showPanel([
      'TEST 2 · MANOS',
      '',
      'Poné la mano delante de la cámara.',
      'El círculo blanco debe caer sobre',
      'la punta de tu dedo índice.',
      '',
      'Si está corrido, ajustá el FOV',
      'de la cámara con − / +.',
    ], 38);
    refreshCalibButtons();
  }

  function refreshCalibButtons() {
    setButtons([
      { label: `FOV −`, onSelect: () => { setConfig('camFov', Math.max(25, config.camFov - 2)); refreshCalibButtons(); } },
      { label: `${config.camFov}°`, onSelect: () => {} },
      { label: `FOV +`, onSelect: () => { setConfig('camFov', Math.min(80, config.camFov + 2)); refreshCalibButtons(); } },
      { label: 'Listo ▶', onSelect: next },
    ], { hFrac: 0.12 });
  }

  function stepJitterIntro() {
    showPanel(['ESTABILIDAD', '', 'Sostené el índice quieto', 'en el centro por 3 segundos.'], 42);
    setButtons([{ label: 'Empezar ▶', onSelect: next }], { hFrac: 0.13 });
  }

  function stepJitter() {
    phase = 'jitter';
    hidePanel();
    jitterSamples.length = 0;
    jitterT = 0;
    target.visible = true;
    setTargetAt(0, 0, atPlane(2));
    clearButtons();
    hudStatus('midiendo jitter…');
  }

  function buildBlock(confirmMode) {
    const q = [];
    for (const r of RADII_DEG) {
      for (const a of AMPL_DEG) {
        for (let i = 0; i < REPS; i++) q.push({ radiusDeg: r, amplDeg: a, confirmMode });
      }
    }
    // barajar para que no se pueda anticipar
    for (let i = q.length - 1; i > 0; i--) {
      const j = (Math.random() * (i + 1)) | 0;
      [q[i], q[j]] = [q[j], q[i]];
    }
    return q.map(t => () => startTrial(t));
  }

  function setTargetAt(x, y, r) {
    target.position.set(x, y, 0.01);
    targetDisc.scale.setScalar(r);
    targetEdge.scale.setScalar(r);
    target.visible = true;
  }

  function startTrial(spec) {
    phase = 'trial';
    hidePanel();
    clearButtons();
    const ang = Math.random() * Math.PI * 2;
    const A = atPlane(spec.amplDeg);
    const x = Math.cos(ang) * A, y = Math.sin(ang) * A * 0.7;   // achatado: la pantalla es apaisada
    const r = atPlane(spec.radiusDeg);
    setTargetAt(x, y, r);
    targetDisc.material.color.set(0x4cc2ff);
    cur = {
      ...spec, x, y, r,
      t0: performance.now(), inside: false, entries: 0,
      insideT: 0, frames: 0, tracked: 0, done: false,
    };
    hudStatus(`${spec.confirmMode} · r=${spec.radiusDeg}° · ${trials.length + 1}/${TOTAL}`);
  }

  function finishTrial(px, py, hit, aborted = false) {
    if (!cur || cur.done) return;
    cur.done = true;
    const dx = px - cur.x, dy = py - cur.y;
    const errM = Math.hypot(dx, dy);
    const errDeg = Math.atan2(errM, PLANE) * 180 / Math.PI;
    const mt = (performance.now() - cur.t0) / 1000;
    const ID = Math.log2((2 * cur.amplDeg) / (2 * cur.radiusDeg));   // índice de dificultad de Fitts
    trials.push({
      confirmMode: cur.confirmMode,
      radiusDeg: cur.radiusDeg,
      amplDeg: cur.amplDeg,
      timeS: +mt.toFixed(3),
      errDeg: +errDeg.toFixed(3),
      errMmAt50cm: +(Math.tan(deg(errDeg)) * 500).toFixed(1),   // el mismo error, a 50 cm de la mano
      hit, aborted,
      overshoots: Math.max(0, cur.entries - 1),
      trackingRate: cur.frames ? +(cur.tracked / cur.frames).toFixed(3) : 0,
      fittsID: +ID.toFixed(2),
      throughputBps: mt > 0 ? +(ID / mt).toFixed(2) : null,
    });
    targetDisc.material.color.set(hit ? 0x3ddc97 : 0xff5f6d);
    setTimeout(() => next(), 250);
  }

  function summarize() {
    phase = 'done';
    target.visible = false;
    cursor.visible = false;
    const by = mode => trials.filter(t => t.confirmMode === mode);
    const jitterDeg = jitterSamples.length > 4 ? rmsDeg(jitterSamples) : null;
    const summary = {
      mode: ctx.rig.mode,
      camFovDeg: config.camFov,
      videoRes: [feed.video.videoWidth, feed.video.videoHeight],
      jitterRmsDeg: jitterDeg,
      jitterRmsMmAt50cm: jitterDeg != null ? +(Math.tan(deg(jitterDeg)) * 500).toFixed(1) : null,
      spuriousPinches,
      fps: ctx.fps ?? null,
      trackingRate: +hands.trackingRate.toFixed(3),
      pinch: blockStats(by('pinch')),
      dwell: blockStats(by('dwell')),
      byRadius: RADII_DEG.map(r => ({
        radiusDeg: r,
        hitRate: rate(trials.filter(t => t.radiusDeg === r)),
        errDeg: stats(trials.filter(t => t.radiusDeg === r).map(t => t.errDeg)),
      })),
      calib: { ...config },
      trials,
    };
    Logger.log('hands', summary);
    log(`manos: err p50 ${summary.pinch?.errDeg?.p50 ?? '—'}° · aciertos pinch ${summary.pinch?.hitRate ?? '—'}`);

    showPanel([
      'RESULTADO',
      '',
      `Error mediano (pinch): ${fmt(summary.pinch?.errDeg?.p50)}°`,
      `  ≈ ${fmt(summary.pinch?.errMm?.p50)} mm a 50 cm`,
      `Aciertos pinch: ${pct(summary.pinch?.hitRate)}`,
      `Aciertos dwell: ${pct(summary.dwell?.hitRate)}`,
      `Jitter: ${fmt(jitterDeg)}° (${fmt(summary.jitterRmsMmAt50cm)} mm)`,
      `Tracking: ${pct(summary.trackingRate)} de los frames`,
      `Pinches espurios: ${spuriousPinches}`,
    ], 36);
    setButtons([{ label: 'Salir ✕', onSelect: () => ctx.exit() }], { hFrac: 0.13 });
    hudStatus('listo');
  }

  const fmt = v => (v == null ? '—' : (+v).toFixed(2));
  const pct = v => (v == null ? '—' : Math.round(v * 100) + '%');
  const rate = a => (a.length ? +(a.filter(t => t.hit).length / a.length).toFixed(3) : null);

  function blockStats(a) {
    if (!a.length) return null;
    return {
      n: a.length,
      hitRate: rate(a),
      errDeg: stats(a.map(t => t.errDeg)),
      errMm: stats(a.map(t => t.errMmAt50cm)),
      timeS: stats(a.map(t => t.timeS)),
      overshoots: stats(a.map(t => t.overshoots)),
      throughputBps: stats(a.filter(t => t.throughputBps != null).map(t => t.throughputBps)),
    };
  }

  function rmsDeg(samples) {
    const mx = samples.reduce((s, p) => s + p.x, 0) / samples.length;
    const my = samples.reduce((s, p) => s + p.y, 0) / samples.length;
    const v = samples.reduce((s, p) => s + (p.x - mx) ** 2 + (p.y - my) ** 2, 0) / samples.length;
    return +(Math.atan2(Math.sqrt(v), PLANE) * 180 / Math.PI).toFixed(3);
  }

  function next() {
    const step = queue.shift();
    if (step) step();
    else summarize();
  }

  let TOTAL = 0;

  // ---------- ciclo ----------
  function updateCursor() {
    const nowMs = performance.now();
    // ~30 Hz alcanza y deja CPU para el render
    if (nowMs - lastDetect >= 33) {
      lastDetect = nowMs;
      hands.detect(feed.video, nowMs);
    }
    const r = hands.result;
    cursorValid = r.present;
    if (!r.present || !r.index) { cursor.visible = phase !== 'done'; cursorRing.material.color.set(0x8ea1b8); return; }

    feed.imageToNdc(r.index.x, r.index.y, cursorNdc);
    const halfH = PLANE * Math.tan(deg(ctx.rig.fov / 2));
    const halfW = halfH * ctx.rig.viewAspect;
    cursor.position.set(cursorNdc.x * halfW, cursorNdc.y * halfH, 0.02);
    cursor.visible = true;
    const c = r.pinching ? 0x3ddc97 : 0xffffff;
    cursorRing.material.color.setHex(c);
    cursorDot.material.color.setHex(c);
  }

  return {
    title: 'Test 2 · Manos',
    needsCamera: true,
    needsHands: true,
    usesPassthrough: true,      // el fondo es la cámara: hay que ver las manos
    init() {
      head.add(world);
      head.add(ui);
      const pinchBlock = buildBlock('pinch');
      const dwellBlock = buildBlock('dwell');
      TOTAL = pinchBlock.length + dwellBlock.length;
      queue = [
        stepJitterIntro,
        stepJitter,
        () => { phase = 'panel'; target.visible = false; showPanel(['BLOQUE 1 · PINCH', '', 'Llevá el dedo al círculo', 'y juntá índice con pulgar.'], 42); setButtons([{ label: 'Empezar ▶', onSelect: next }], { hFrac: 0.13 }); },
        ...pinchBlock,
        () => { phase = 'panel'; target.visible = false; showPanel(['BLOQUE 2 · DWELL', '', 'Llevá el dedo al círculo', 'y mantenelo 0,6 s adentro.'], 42); setButtons([{ label: 'Empezar ▶', onSelect: next }], { hFrac: 0.13 }); },
        ...dwellBlock,
      ];
      if (!hands.ready) {
        // Sin detector de manos el test no mide nada: mejor decirlo que dejar
        // al usuario mirando objetivos que nunca se pueden tocar.
        logWarn('hand tracking no disponible');
        phase = 'done';
        queue = [];
        showPanel([
          'HAND TRACKING NO DISPONIBLE',
          '',
          'No se pudo cargar el modelo de MediaPipe.',
          'Revisá la conexión y volvé a entrar:',
          'el modelo se descarga la primera vez.',
        ], 36);
        setButtons([{ label: 'Salir ✕', onSelect: () => ctx.exit() }], { hFrac: 0.13 });
        hudStatus('sin hand tracking');
        return;
      }
      stepIntro();
    },

    update(dt) {
      if (armed > 0) armed = Math.max(0, armed - dt);
      updateCursor();

      const r = hands.result;
      const pinchDown = !!(r.present && r.pinching);
      const pinchEdge = pinchDown && !pinchWasDown;
      pinchWasDown = pinchDown;

      if (phase === 'jitter') {
        if (cursorValid) jitterSamples.push({ x: cursor.position.x, y: cursor.position.y });
        jitterT += dt;
        hudStatus(`jitter ${(JITTER_SECS - jitterT).toFixed(1)} s`);
        if (jitterT >= JITTER_SECS) { target.visible = false; next(); }
        return;
      }

      if (phase !== 'trial' || !cur || cur.done) {
        if (pinchEdge && phase !== 'trial') spuriousPinches++;
        return;
      }

      cur.frames++;
      if (cursorValid) cur.tracked++;

      const dx = cursor.position.x - cur.x, dy = cursor.position.y - cur.y;
      const inside = cursorValid && Math.hypot(dx, dy) <= cur.r;
      if (inside && !cur.inside) cur.entries++;
      cur.inside = inside;
      targetDisc.material.opacity = inside ? 0.85 : 0.55;

      if (cur.confirmMode === 'pinch') {
        if (pinchEdge) finishTrial(cursor.position.x, cursor.position.y, inside);
        // abandono: 8 s sin confirmar
        if (performance.now() - cur.t0 > 8000) finishTrial(cursor.position.x, cursor.position.y, false, true);
      } else {
        cur.insideT = inside ? cur.insideT + dt : 0;
        targetDisc.material.color.setHSL(0.55, 0.8, 0.5 + 0.25 * Math.min(1, cur.insideT / DWELL_CONFIRM));
        if (cur.insideT >= DWELL_CONFIRM) finishTrial(cursor.position.x, cursor.position.y, true);
        if (performance.now() - cur.t0 > 10000) finishTrial(cursor.position.x, cursor.position.y, false, true);
      }
    },

    dispose() {
      clearButtons();
      hidePanel();
      head.remove(world); head.remove(ui);
      disposeTree(world); disposeTree(ui);
    },
  };
}
