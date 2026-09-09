// Selección de objetos, con dos modos bien distintos:
//   'gaze'  → dentro del visor: retícula al centro + dwell (mirar y sostener).
//             No hay dedos disponibles, la pantalla está tapada.
//   'touch' → teléfono en la mano: raycast en el punto tocado, sin dwell.
// Cualquier tecla o botón (mando bluetooth del VR Box) activa lo enfocado.
import * as THREE from 'three';
import { config } from './config.js';

export class Interaction {
  constructor() {
    this.raycaster = new THREE.Raycaster();
    this.targets = [];
    this.hovered = null;
    this.dwell = 0;
    this.pointer = new THREE.Vector2(0, 0);   // NDC del último toque
    this.mode = 'touch';
    this.enabled = true;

    this.group = new THREE.Group();
    this.group.position.set(0, 0, -1.5);
    this.group.visible = false;

    const ringMat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.55, depthTest: false });
    this.ring = new THREE.Mesh(new THREE.RingGeometry(0.012, 0.016, 32), ringMat);
    this.ring.renderOrder = 999;
    this.group.add(this.ring);

    this.progMat = new THREE.MeshBasicMaterial({ color: 0x4cc2ff, transparent: true, depthTest: false });
    this.prog = new THREE.Mesh(new THREE.RingGeometry(0.019, 0.028, 32, 1, Math.PI / 2, 0), this.progMat);
    this.prog.renderOrder = 1000;
    this.group.add(this.prog);
    this._progVal = -1;
  }

  attach(camera) { camera.add(this.group); this.camera = camera; }
  detach() { this.group.parent?.remove(this.group); }

  bindDom(canvas) {
    this.canvas = canvas;
    this._onKey = () => { if (this.mode === 'gaze') this.selectHovered(); };
    this._onDown = ev => {
      const r = canvas.getBoundingClientRect();
      this.pointer.set(((ev.clientX - r.left) / r.width) * 2 - 1,
                       -((ev.clientY - r.top) / r.height) * 2 + 1);
      if (this.mode === 'gaze') this.selectHovered();
      else this.selectAtPointer();
    };
    window.addEventListener('keydown', this._onKey);
    canvas.addEventListener('pointerdown', this._onDown);
  }

  unbindDom() {
    window.removeEventListener('keydown', this._onKey);
    this.canvas?.removeEventListener('pointerdown', this._onDown);
  }

  setMode(m) {
    this.mode = m;
    this.showReticle(m === 'gaze');
    this._setHover(null);
  }

  setTargets(list) {
    this.targets = list || [];
    if (this.hovered && !this.targets.includes(this.hovered)) this._setHover(null);
  }

  showReticle(v) { this.group.visible = !!v; }

  _raycastAt(ndc) {
    if (!this.camera || !this.targets.length) return null;
    this.raycaster.setFromCamera(ndc, this.camera);
    const hits = this.raycaster.intersectObjects(this.targets, false);
    return hits.length ? hits[0] : null;
  }

  _setHover(obj) {
    if (this.hovered === obj) return;
    this.hovered?.userData?.onHover?.(false);
    this.hovered = obj;
    this.dwell = 0;
    this.hovered?.userData?.onHover?.(true);
  }

  selectHovered() {
    if (!this.enabled) return false;
    const t = this.hovered || this._raycastAt({ x: 0, y: 0 })?.object;
    if (!t) return false;
    this.dwell = 0;
    this._setProgress(0);
    t.userData?.onSelect?.(t);
    return true;
  }

  selectAtPointer() {
    if (!this.enabled) return false;
    const hit = this._raycastAt(this.pointer);
    if (!hit) return false;
    hit.object.userData?.onSelect?.(hit.object);
    return true;
  }

  update(dt) {
    if (!this.enabled || this.mode !== 'gaze') { this._setProgress(0); return; }
    const hit = this._raycastAt({ x: 0, y: 0 });
    this._setHover(hit ? hit.object : null);

    if (this.hovered && this.hovered.userData?.noDwell !== true) {
      this.dwell += dt;
      // `dwellScale` deja que un botón que repite (los ± de calibración) se
      // dispare mucho más rápido que uno de navegación, sin tocar la config.
      const need = Math.max(0.2, config.dwell * (this.hovered.userData?.dwellScale ?? 1));
      this._setProgress(Math.min(1, this.dwell / need));
      if (this.dwell >= need) {
        this.dwell = 0;
        this._setProgress(0);
        this.hovered.userData?.onSelect?.(this.hovered);
      }
    } else {
      this._setProgress(0);
    }
    this.ring.material.opacity = this.hovered ? 0.95 : 0.45;
  }

  _setProgress(v) {
    if (v === this._progVal) return;
    if (v !== 0 && Math.abs(v - this._progVal) < 0.03) return;
    this._progVal = v;
    this.prog.geometry.dispose();
    this.prog.geometry = new THREE.RingGeometry(0.019, 0.028, 32, 1, Math.PI / 2, -v * Math.PI * 2);
    this.prog.visible = v > 0.001;
  }

  dispose() {
    this.unbindDom();
    this.detach();
    this.ring.geometry.dispose(); this.ring.material.dispose();
    this.prog.geometry.dispose(); this.progMat.dispose();
  }
}

/** Botón 3D: panel con texto que responde a mirada o toque. */
export function makeButton(texture, w, h, onSelect) {
  const mesh = new THREE.Mesh(
    new THREE.PlaneGeometry(w, h),
    new THREE.MeshBasicMaterial({ map: texture, transparent: true })
  );
  const edge = new THREE.Mesh(
    new THREE.PlaneGeometry(w * 1.06, h * 1.18),
    new THREE.MeshBasicMaterial({ color: 0x4cc2ff, transparent: true, opacity: 0 })
  );
  edge.position.z = -0.002;
  mesh.add(edge);
  mesh.userData.onSelect = onSelect;
  mesh.userData.onHover = on => { edge.material.opacity = on ? 0.85 : 0; };
  return mesh;
}

/** Libera geometrías y materiales de un subárbol. */
export function disposeTree(obj) {
  obj.traverse(o => {
    o.geometry?.dispose?.();
    const mats = Array.isArray(o.material) ? o.material : o.material ? [o.material] : [];
    for (const m of mats) { m.map?.dispose?.(); m.dispose?.(); }
  });
}
