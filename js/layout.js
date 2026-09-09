// Colocación de UI en coordenadas de pantalla (NDC) en vez de metros fijos.
//
// Hace falta porque el FOV cambia muchísimo entre modos: dentro del visor son
// ~80° verticales, y con el teléfono en la mano son ~26° (el alto físico del
// display a 30 cm). Un botón a "0,55 m debajo del centro" está bien en el visor
// y completamente fuera de cuadro en la mano.
import * as THREE from 'three';
import { textPanel } from './textures.js';
import { makeButton } from './interaction.js';

const D2R = Math.PI / 180;

export const halfHeightAt = (rig, dist) => dist * Math.tan(rig.fov * D2R / 2);
export const halfWidthAt = (rig, dist) => halfHeightAt(rig, dist) * rig.viewAspect;

/** Coloca un objeto en la posición NDC (x, y) sobre un plano a `dist` metros. */
export function placeNdc(obj, rig, x, y, dist) {
  obj.position.set(x * halfWidthAt(rig, dist), y * halfHeightAt(rig, dist), -dist);
}

/** Fila de botones que siempre entra en pantalla, en cualquier modo. */
export function buildButtonRow(rig, items, opt = {}) {
  const { dist = 1.6, yNdc = -0.72, hFrac = 0.13, gapFrac = 0.28, fontSize = 52 } = opt;
  const hh = halfHeightAt(rig, dist);
  const maxW = 2 * halfWidthAt(rig, dist) * 0.94;

  const metas = items.map(it => ({ it, ...textPanel([it.label], { fontSize, pad: 18, bg: '#1b2430', width: 512 }) }));
  let h = 2 * hh * hFrac;
  let widths = metas.map(m => h * m.aspect);
  let gap = h * gapFrac;
  let total = widths.reduce((a, b) => a + b, 0) + gap * (metas.length - 1);
  if (total > maxW) {
    const k = maxW / total;
    h *= k; gap *= k; widths = widths.map(w => w * k); total = maxW;
  }

  const meshes = [];
  let x = -total / 2;
  for (let i = 0; i < metas.length; i++) {
    const m = metas[i];
    const mesh = makeButton(m.texture, widths[i], h, () => m.it.onSelect());
    mesh.position.set(x + widths[i] / 2, yNdc * hh, -dist);
    x += widths[i] + gap;
    meshes.push(mesh);
  }
  return meshes;
}

/** Panel de texto proporcional al viewport. */
export function buildPanel(rig, lines, opt = {}) {
  const { dist = 2.2, yNdc = 0.16, wFrac = 0.86, maxHFrac = 0.52, fontSize = 42 } = opt;
  const hh = halfHeightAt(rig, dist);
  const { texture, aspect } = textPanel(lines, { fontSize, width: 1024, bg: '#111a25' });
  let w = 2 * halfWidthAt(rig, dist) * wFrac;
  let h = w / aspect;
  const maxH = 2 * hh * maxHFrac;
  if (h > maxH) { h = maxH; w = h * aspect; }
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshBasicMaterial({ map: texture }));
  mesh.position.set(0, yNdc * hh, -dist);
  return mesh;
}
