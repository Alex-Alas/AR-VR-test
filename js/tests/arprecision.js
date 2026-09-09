// TEST 3 · PRECISIÓN DE LOS ELEMENTOS AR
// Sesión WebXR immersive-ar (ARCore). Tres tareas, todas con resultado numérico:
//   A · Colocación: poner un pin en el centro de un anillo que vos mismo pusiste.
//   B · Deriva: marcar el MISMO punto físico dos veces separadas por un paseo;
//       la distancia entre las dos marcas es la deriva acumulada del tracking.
//   C · Escala: medir algo de largo conocido y comparar con la realidad.
//
// Dos modos de puntería, según lo que el dispositivo conceda:
//   'hit-test' → retícula sobre la superficie detectada (el bueno).
//   'device'   → sin hit-test: el punto marcado es la posición del propio
//                teléfono, así que se marca apoyándolo en el punto físico.
//                Menos cómodo, pero deriva y escala se siguen midiendo igual.
import * as THREE from 'three';
import { Logger, stats } from '../logger.js';
import { disposeTree, makeButton } from '../interaction.js';
import { textPanel } from '../textures.js';
import { arPrompt, log, logWarn, el } from '../ui.js';

const RING_RADII = [0.05, 0.02, 0.01];   // m
const DRIFT_ROUNDS = 2;

export function createARTest(ctx) {
  const { scene } = ctx;
  const root = new THREE.Group();

  // retícula del hit-test
  const reticle = new THREE.Mesh(
    new THREE.RingGeometry(0.045, 0.055, 32).rotateX(-Math.PI / 2),
    new THREE.MeshBasicMaterial({ color: 0x4cc2ff })
  );
  reticle.matrixAutoUpdate = false;
  reticle.visible = false;
  root.add(reticle);

  const placedGroup = new THREE.Group();
  root.add(placedGroup);

  root.add(new THREE.HemisphereLight(0xffffff, 0x334455, 2));
  scene.add(root);

  const state = {
    phase: 'wait-surface',
    hitPose: null,
    placeRound: 0,
    ring: null,
    driftRound: 0,
    driftA: null,
    scalePoints: [],
    results: { placement: [], drift: [], scale: [], features: {} },
  };

  const hasHitTest = () => state.results.features.hitTest !== false;
  const hasOverlay = () => state.results.features.domOverlay !== false;

  /** Cómo se marca un punto, según el modo de puntería que haya. */
  const AIM = () => hasHitTest()
    ? 'Tocá la pantalla'
    : 'Apoyá el borde de arriba del teléfono en el punto y tocá la pantalla';

  // ---------- UI 3D de emergencia ----------
  // Sin `dom-overlay` el DOM no se ve dentro de la sesión: la misma UI se dibuja
  // en la escena y se maneja con mirada + dwell, que sí funciona siempre.
  const fallbackUI = new THREE.Group();

  function wrap(txt, n = 38) {
    const out = [];
    for (const para of txt.split('\n')) {
      let line = '';
      for (const word of para.split(' ')) {
        if ((line + ' ' + word).trim().length > n) { out.push(line.trim()); line = word; }
        else line += ' ' + word;
      }
      out.push(line.trim());
    }
    return out.filter(l => l.length);
  }

  const stripHtml = html => html.replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '')
    .split('\n').map(l => l.trim().replace(/\s+/g, ' ')).join('\n');

  function clearFallback() {
    fallbackUI.children.slice().forEach(o => { fallbackUI.remove(o); disposeTree(o); });
    ctx.interaction.setTargets([]);
  }

  /**
   * Panel + fila de botones a 1,2 m de la cara. Las medidas no salen de
   * `rig.fov` a propósito: en AR el FOV lo fija la cámara del dispositivo, no la
   * configuración del visor, así que se asume un campo de ~50° verticales.
   */
  function paintFallback(msg, actions) {
    clearFallback();
    const D = 1.2, hh = D * Math.tan(25 * Math.PI / 180), hw = hh * 1.6;

    const lines = wrap(stripHtml(msg));
    const { texture, aspect } = textPanel(lines, { fontSize: 40, width: 1024, bg: '#111a25dd' });
    const pw = 2 * hw * 0.92;
    const panel = new THREE.Mesh(
      new THREE.PlaneGeometry(pw, pw / aspect),
      new THREE.MeshBasicMaterial({ map: texture, transparent: true })
    );
    panel.position.set(0, hh * 0.35, -D);
    fallbackUI.add(panel);

    if (!actions.length) return;
    const metas = actions.map(a => ({ a, ...textPanel([a.label], { fontSize: 52, pad: 18, bg: '#1b2430', width: 512 }) }));
    let bh = 2 * hh * 0.13;
    let widths = metas.map(m => bh * m.aspect);
    let gap = bh * 0.28;
    let total = widths.reduce((x, y) => x + y, 0) + gap * (metas.length - 1);
    const maxW = 2 * hw * 0.94;
    if (total > maxW) { const k = maxW / total; bh *= k; gap *= k; widths = widths.map(w => w * k); total = maxW; }

    let x = -total / 2;
    for (let i = 0; i < metas.length; i++) {
      const m = metas[i];
      const b = makeButton(m.texture, widths[i], bh, () => m.a.onClick());
      b.position.set(x + widths[i] / 2, -hh * 0.62, -D);
      x += widths[i] + gap;
      fallbackUI.add(b);
    }
    ctx.interaction.setTargets(fallbackUI.children.filter(o => o.userData.onSelect));
  }

  /** Único punto de pintado: DOM si hay overlay, 3D si no. */
  function paint(msg, actions = []) {
    if (hasOverlay()) return arPrompt(msg, actions);
    paintFallback(msg, actions);
  }

  // ---------- objetos ----------
  function ringAt(p, r) {
    const g = new THREE.Group();
    const torus = new THREE.Mesh(
      new THREE.TorusGeometry(r, Math.max(0.0015, r * 0.08), 8, 48).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({ color: 0x4cc2ff })
    );
    const pip = new THREE.Mesh(
      new THREE.SphereGeometry(0.003, 8, 8),
      new THREE.MeshBasicMaterial({ color: 0xffffff })
    );
    g.add(torus, pip);
    g.position.copy(p);
    placedGroup.add(g);
    return g;
  }

  function markerAt(p, color = 0xffb454, r = 0.012) {
    const m = new THREE.Mesh(
      new THREE.SphereGeometry(r, 12, 12),
      new THREE.MeshBasicMaterial({ color })
    );
    m.position.copy(p);
    const stem = new THREE.Mesh(
      new THREE.CylinderGeometry(0.001, 0.001, 0.06, 6),
      new THREE.MeshBasicMaterial({ color })
    );
    stem.position.y = 0.03;
    m.add(stem);
    placedGroup.add(m);
    return m;
  }

  function clearPlaced() {
    placedGroup.children.slice().forEach(o => { placedGroup.remove(o); disposeTree(o); });
  }

  // ---------- flujo ----------
  function goMenu() {
    state.phase = 'menu';
    clearPlaced();
    const intro = hasHitTest()
      ? 'Apuntá a una superficie plana con buena textura y luz.'
      : 'Sin hit-test: los puntos se marcan apoyando el teléfono. Movelo despacio unos segundos para que arranque el tracking.';
    const items = [
      { label: 'A · Colocación', primary: true, onClick: startPlacement },
      { label: 'B · Deriva', onClick: startDrift },
    ];
    // La tarea C necesita escribir la medida real con cinta métrica, y sin
    // dom-overlay no hay teclado adentro de la sesión.
    if (hasOverlay()) items.push({ label: 'C · Escala', onClick: startScale });
    items.push({ label: 'Ver resultados', ghost: true, onClick: showSummary });
    items.push({ label: '✕ Salir', ghost: true, onClick: () => ctx.exit() });
    paint(`<b>Test 3 · Precisión AR</b><br>${intro}`, items);
  }

  // --- A · colocación ---
  function startPlacement() {
    state.placeRound = 0;
    nextPlacementRound();
  }

  function nextPlacementRound() {
    if (state.placeRound >= RING_RADII.length) {
      const errs = state.results.placement.map(r => r.errorMm);
      paint(`<b>Tarea A lista.</b><br>Error mediano: <b>${stats(errs)?.p50 ?? '—'} mm</b>`,
        [{ label: 'Volver al menú', primary: true, onClick: goMenu }]);
      return;
    }
    clearPlaced();
    state.ring = null;
    state.phase = 'place-ring';
    const r = RING_RADII[state.placeRound];
    paint(`<b>A${state.placeRound + 1} · anillo de ${(r * 1000).toFixed(0)} mm</b><br>
      ${AIM()} para colocar el anillo sobre la superficie.`,
      [{ label: 'Saltar', ghost: true, onClick: () => { state.placeRound++; nextPlacementRound(); } }]);
  }

  function onPlaceRing(p) {
    const r = RING_RADII[state.placeRound];
    state.ring = { pos: p.clone(), r, t: performance.now() };
    ringAt(p, r);
    state.phase = 'place-pin';
    paint(`Ahora <b>movete un poco</b> y marcá el pin
      lo más centrado posible en el anillo.`, []);
  }

  function onPlacePin(p) {
    markerAt(p, 0xff5f6d, 0.006);
    const d = p.distanceTo(state.ring.pos);
    const horiz = Math.hypot(p.x - state.ring.pos.x, p.z - state.ring.pos.z);
    const rec = {
      ringRadiusMm: +(state.ring.r * 1000).toFixed(1),
      errorMm: +(horiz * 1000).toFixed(1),
      error3dMm: +(d * 1000).toFixed(1),
      verticalMm: +(Math.abs(p.y - state.ring.pos.y) * 1000).toFixed(1),
      inside: horiz <= state.ring.r,
      timeS: +((performance.now() - state.ring.t) / 1000).toFixed(2),
    };
    state.results.placement.push(rec);
    log(`AR colocación: ${rec.errorMm} mm (anillo ${rec.ringRadiusMm} mm)`);
    state.placeRound++;
    state.phase = 'idle';
    paint(`Error: <b>${rec.errorMm} mm</b> ${rec.inside ? '✅ dentro' : '❌ fuera'} del anillo.`,
      [{ label: 'Siguiente ▶', primary: true, onClick: nextPlacementRound }]);
  }

  // --- B · deriva ---
  function startDrift() {
    state.driftRound = 0;
    nextDriftRound();
  }

  function nextDriftRound() {
    if (state.driftRound >= DRIFT_ROUNDS) {
      const d = state.results.drift.map(r => r.driftMm);
      paint(`<b>Tarea B lista.</b><br>Deriva mediana: <b>${stats(d)?.p50 ?? '—'} mm</b>`,
        [{ label: 'Volver al menú', primary: true, onClick: goMenu }]);
      return;
    }
    clearPlaced();
    state.driftA = null;
    state.phase = 'drift-a';
    paint(`<b>B${state.driftRound + 1} · deriva del anclaje</b><br>
      Elegí una <b>esquina física concreta</b> (la punta de una mesa, un tornillo).
      ${AIM()} para marcarla.`,
      [{ label: 'Saltar', ghost: true, onClick: () => { state.driftRound++; nextDriftRound(); } }]);
  }

  function onDriftA(p) {
    state.driftA = { pos: p.clone(), t: performance.now() };
    markerAt(p, 0x3ddc97);
    state.phase = 'drift-walk';
    paint(`Marca puesta. Ahora <b>alejate unos 5 pasos, date la vuelta y volvé</b>
      al mismo lugar. Cuando estés listo, tocá "Ya volví".`,
      [{ label: 'Ya volví ▶', primary: true, onClick: () => {
        state.phase = 'drift-b';
        paint(`Marcá <b>exactamente el mismo punto físico</b> otra vez.
          La distancia entre las dos marcas es la deriva del tracking.`, []);
      } }]);
  }

  function onDriftB(p) {
    markerAt(p, 0xff5f6d);
    const a = state.driftA.pos;
    const rec = {
      driftMm: +(p.distanceTo(a) * 1000).toFixed(1),
      horizontalMm: +(Math.hypot(p.x - a.x, p.z - a.z) * 1000).toFixed(1),
      verticalMm: +(Math.abs(p.y - a.y) * 1000).toFixed(1),
      elapsedS: +((performance.now() - state.driftA.t) / 1000).toFixed(1),
    };
    state.results.drift.push(rec);
    log(`AR deriva: ${rec.driftMm} mm en ${rec.elapsedS}s`);
    state.driftRound++;
    state.phase = 'idle';
    paint(`Deriva: <b>${rec.driftMm} mm</b> (horizontal ${rec.horizontalMm} / vertical ${rec.verticalMm})
      tras ${rec.elapsedS} s.`,
      [{ label: 'Siguiente ▶', primary: true, onClick: nextDriftRound }]);
  }

  // --- C · escala ---
  function startScale() {
    clearPlaced();
    state.scalePoints = [];
    state.phase = 'scale';
    paint(`<b>C · error de escala</b><br>
      Marcá los <b>dos extremos</b> de algo que puedas medir con cinta métrica
      (el largo de una mesa, una puerta).`, []);
  }

  function onScalePoint(p) {
    state.scalePoints.push(p.clone());
    markerAt(p, 0x4cc2ff, 0.008);
    if (state.scalePoints.length < 2) {
      paint(`Punto 1 puesto. Marcá el <b>segundo extremo</b>.`, []);
      return;
    }
    const measured = state.scalePoints[0].distanceTo(state.scalePoints[1]);
    state.phase = 'idle';
    const input = document.createElement('input');
    input.type = 'number';
    input.step = '0.1';
    input.placeholder = 'medida real en cm';
    paint(`AR midió <b>${(measured * 100).toFixed(1)} cm</b>.<br>
      Medilo con cinta y escribí el valor real:`, [
      { label: 'Guardar', primary: true, onClick: () => {
        const real = parseFloat(input.value) / 100;
        if (!isFinite(real) || real <= 0) return;
        const rec = {
          measuredCm: +(measured * 100).toFixed(1),
          realCm: +(real * 100).toFixed(1),
          errorCm: +((measured - real) * 100).toFixed(1),
          errorPct: +(((measured - real) / real) * 100).toFixed(2),
        };
        state.results.scale.push(rec);
        log(`AR escala: ${rec.errorPct}% de error`);
        paint(`Error de escala: <b>${rec.errorPct}%</b> (${rec.errorCm} cm).`,
          [{ label: 'Otra medición', onClick: startScale },
           { label: 'Volver al menú', primary: true, onClick: goMenu }]);
      } },
      { label: 'Cancelar', ghost: true, onClick: goMenu },
    ]);
    el.arActions.appendChild(input);
    input.focus();
  }

  function showSummary() {
    const summary = {
      mode: 'ar',
      features: state.results.features,
      placement: {
        n: state.results.placement.length,
        errorMm: stats(state.results.placement.map(r => r.errorMm)),
        insideRate: state.results.placement.length
          ? +(state.results.placement.filter(r => r.inside).length / state.results.placement.length).toFixed(2) : null,
        trials: state.results.placement,
      },
      drift: {
        n: state.results.drift.length,
        driftMm: stats(state.results.drift.map(r => r.driftMm)),
        trials: state.results.drift,
      },
      scale: {
        n: state.results.scale.length,
        errorPct: stats(state.results.scale.map(r => r.errorPct)),
        trials: state.results.scale,
      },
    };
    Logger.log('ar', summary);
    paint(`<b>Guardado.</b><br>
      Colocación: ${summary.placement.errorMm?.p50 ?? '—'} mm (mediana)<br>
      Deriva: ${summary.drift.driftMm?.p50 ?? '—'} mm<br>
      Escala: ${summary.scale.errorPct?.p50 ?? '—'} %`,
      [{ label: 'Volver al menú', onClick: goMenu },
       { label: '✕ Salir', primary: true, onClick: () => ctx.exit() }]);
  }

  // ---------- API para el runner de XR ----------
  return {
    title: 'Test 3 · AR',

    /** @param {{domOverlay:boolean, hitTest:boolean, enabled:string[]|null}} f */
    setFeatures(f) {
      state.results.features = f;
      if (f.hitTest === false) logWarn('AR sin hit-test: se marca apoyando el teléfono en el punto');
      if (f.domOverlay === false) {
        logWarn('AR sin dom-overlay: la UI va en 3D, se selecciona con la mirada');
        ctx.head.add(fallbackUI);
        ctx.interaction.setMode('gaze');
      }
    },

    /**
     * Se llama en cada frame XR con el pose del punto apuntado (o null).
     * Con hit-test es el punto sobre la superficie; sin él, la posición del
     * propio teléfono.
     */
    onFrame(poseMatrix) {
      if (poseMatrix) {
        // Sin hit-test la retícula quedaría pegada a la cara: no se dibuja.
        reticle.visible = hasHitTest()
          && state.phase !== 'idle' && state.phase !== 'menu' && state.phase !== 'drift-walk';
        reticle.matrix.copy(poseMatrix);
        state.hitPose = new THREE.Vector3().setFromMatrixPosition(poseMatrix);
        if (state.phase === 'wait-surface') goMenu();
      } else {
        reticle.visible = false;
        state.hitPose = null;
      }
    },

    /** Toque en la pantalla dentro de la sesión AR. */
    onSelect() {
      if (!state.hitPose) return;
      const p = state.hitPose;
      switch (state.phase) {
        case 'place-ring': onPlaceRing(p); break;
        case 'place-pin':  onPlacePin(p);  break;
        case 'drift-a':    onDriftA(p);    break;
        case 'drift-b':    onDriftB(p);    break;
        case 'scale':      onScalePoint(p); break;
      }
    },

    start() {
      state.phase = 'wait-surface';
      paint(hasHitTest()
        ? 'Moviendo el teléfono para encontrar una superficie…'
        : 'Movete despacio unos segundos para que ARCore fije el tracking…', [
        { label: '✕ Salir', ghost: true, onClick: () => ctx.exit() },
      ]);
    },

    dispose() {
      clearPlaced();
      clearFallback();
      fallbackUI.parent?.remove(fallbackUI);
      scene.remove(root);
      disposeTree(root);
    },
  };
}
