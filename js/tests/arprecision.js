// TEST 3 · PRECISIÓN DE LOS ELEMENTOS AR
// Sesión WebXR immersive-ar (ARCore). Tres tareas, todas con resultado numérico:
//   A · Colocación: poner un pin en el centro de un anillo que vos mismo pusiste.
//   B · Deriva: marcar el MISMO punto físico dos veces separadas por un paseo;
//       la distancia entre las dos marcas es la deriva acumulada del tracking.
//   C · Escala: medir algo de largo conocido y comparar con la realidad.
import * as THREE from 'three';
import { Logger, stats } from '../logger.js';
import { disposeTree } from '../interaction.js';
import { arPrompt, log, el } from '../ui.js';

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
    arPrompt(
      `<b>Test 3 · Precisión AR</b><br>Apuntá a una superficie plana con buena textura y luz.`,
      [
        { label: 'A · Colocación', primary: true, onClick: startPlacement },
        { label: 'B · Deriva', onClick: startDrift },
        { label: 'C · Escala', onClick: startScale },
        { label: 'Ver resultados', ghost: true, onClick: showSummary },
        { label: '✕ Salir', ghost: true, onClick: () => ctx.exit() },
      ]
    );
  }

  // --- A · colocación ---
  function startPlacement() {
    state.placeRound = 0;
    nextPlacementRound();
  }

  function nextPlacementRound() {
    if (state.placeRound >= RING_RADII.length) {
      const errs = state.results.placement.map(r => r.errorMm);
      arPrompt(`<b>Tarea A lista.</b><br>Error mediano: <b>${stats(errs)?.p50 ?? '—'} mm</b>`,
        [{ label: 'Volver al menú', primary: true, onClick: goMenu }]);
      return;
    }
    clearPlaced();
    state.ring = null;
    state.phase = 'place-ring';
    const r = RING_RADII[state.placeRound];
    arPrompt(`<b>A${state.placeRound + 1} · anillo de ${(r * 1000).toFixed(0)} mm</b><br>
      Tocá la pantalla para colocar el anillo sobre la superficie.`,
      [{ label: 'Saltar', ghost: true, onClick: () => { state.placeRound++; nextPlacementRound(); } }]);
  }

  function onPlaceRing(p) {
    const r = RING_RADII[state.placeRound];
    state.ring = { pos: p.clone(), r, t: performance.now() };
    ringAt(p, r);
    state.phase = 'place-pin';
    arPrompt(`Ahora <b>movete un poco</b> y tocá para poner el pin
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
    arPrompt(`Error: <b>${rec.errorMm} mm</b> ${rec.inside ? '✅ dentro' : '❌ fuera'} del anillo.`,
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
      arPrompt(`<b>Tarea B lista.</b><br>Deriva mediana: <b>${stats(d)?.p50 ?? '—'} mm</b>`,
        [{ label: 'Volver al menú', primary: true, onClick: goMenu }]);
      return;
    }
    clearPlaced();
    state.driftA = null;
    state.phase = 'drift-a';
    arPrompt(`<b>B${state.driftRound + 1} · deriva del anclaje</b><br>
      Elegí una <b>esquina física concreta</b> (la punta de una mesa, un tornillo)
      y tocá para marcarla.`,
      [{ label: 'Saltar', ghost: true, onClick: () => { state.driftRound++; nextDriftRound(); } }]);
  }

  function onDriftA(p) {
    state.driftA = { pos: p.clone(), t: performance.now() };
    markerAt(p, 0x3ddc97);
    state.phase = 'drift-walk';
    arPrompt(`Marca puesta. Ahora <b>alejate unos 5 pasos, date la vuelta y volvé</b>
      al mismo lugar. Cuando estés listo, tocá "Ya volví".`,
      [{ label: 'Ya volví ▶', primary: true, onClick: () => {
        state.phase = 'drift-b';
        arPrompt(`Marcá <b>exactamente el mismo punto físico</b> otra vez.
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
    arPrompt(`Deriva: <b>${rec.driftMm} mm</b> (horizontal ${rec.horizontalMm} / vertical ${rec.verticalMm})
      tras ${rec.elapsedS} s.`,
      [{ label: 'Siguiente ▶', primary: true, onClick: nextDriftRound }]);
  }

  // --- C · escala ---
  function startScale() {
    clearPlaced();
    state.scalePoints = [];
    state.phase = 'scale';
    arPrompt(`<b>C · error de escala</b><br>
      Tocá los <b>dos extremos</b> de algo que puedas medir con cinta métrica
      (el largo de una mesa, una puerta).`, []);
  }

  function onScalePoint(p) {
    state.scalePoints.push(p.clone());
    markerAt(p, 0x4cc2ff, 0.008);
    if (state.scalePoints.length < 2) {
      arPrompt(`Punto 1 puesto. Tocá el <b>segundo extremo</b>.`, []);
      return;
    }
    const measured = state.scalePoints[0].distanceTo(state.scalePoints[1]);
    state.phase = 'idle';
    const input = document.createElement('input');
    input.type = 'number';
    input.step = '0.1';
    input.placeholder = 'medida real en cm';
    arPrompt(`AR midió <b>${(measured * 100).toFixed(1)} cm</b>.<br>
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
        arPrompt(`Error de escala: <b>${rec.errorPct}%</b> (${rec.errorCm} cm).`,
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
    arPrompt(`<b>Guardado.</b><br>
      Colocación: ${summary.placement.errorMm?.p50 ?? '—'} mm (mediana)<br>
      Deriva: ${summary.drift.driftMm?.p50 ?? '—'} mm<br>
      Escala: ${summary.scale.errorPct?.p50 ?? '—'} %`,
      [{ label: 'Volver al menú', onClick: goMenu },
       { label: '✕ Salir', primary: true, onClick: () => ctx.exit() }]);
  }

  // ---------- API para el runner de XR ----------
  return {
    title: 'Test 3 · AR',
    setFeatures(f) { state.results.features = f; },

    /** Se llama en cada frame XR con el pose del hit-test (o null). */
    onFrame(hitMatrix) {
      if (hitMatrix) {
        reticle.visible = state.phase !== 'idle' && state.phase !== 'menu' && state.phase !== 'drift-walk';
        reticle.matrix.copy(hitMatrix);
        state.hitPose = new THREE.Vector3().setFromMatrixPosition(hitMatrix);
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
      arPrompt('Moviendo el teléfono para encontrar una superficie…', [
        { label: '✕ Salir', ghost: true, onClick: () => ctx.exit() },
      ]);
    },

    dispose() {
      clearPlaced();
      scene.remove(root);
      disposeTree(root);
    },
  };
}
