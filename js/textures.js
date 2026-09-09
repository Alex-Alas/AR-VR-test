// Texturas generadas por canvas: texto, anillos de Landolt, rampas de contraste y rejillas.
import * as THREE from 'three';

function canvas(w, h) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  return c;
}

function toTexture(c) {
  // Sin colorSpace a propósito: trabajamos en valores de display crudos para que
  // un gris 128 llegue al panel como 128 (ver nota en stereo.js).
  const t = new THREE.CanvasTexture(c);
  t.anisotropy = 4;
  t.minFilter = THREE.LinearFilter;
  t.magFilter = THREE.LinearFilter;
  return t;
}

/** Panel de texto. Devuelve { texture, aspect }. */
export function textPanel(lines, opt = {}) {
  const {
    fontSize = 44, pad = 28, bg = '#0d1420', fg = '#e6edf5',
    align = 'center', width = 1024, weight = 600, lineGap = 1.35,
  } = opt;
  const h = Math.ceil(pad * 2 + lines.length * fontSize * lineGap);
  const c = canvas(width, Math.max(64, h));
  const g = c.getContext('2d');
  if (bg !== 'transparent') { g.fillStyle = bg; g.fillRect(0, 0, c.width, c.height); }
  g.fillStyle = fg;
  g.textBaseline = 'middle';
  g.textAlign = align;
  g.font = `${weight} ${fontSize}px system-ui, -apple-system, sans-serif`;
  const x = align === 'center' ? c.width / 2 : pad;
  lines.forEach((ln, i) => {
    g.fillText(String(ln), x, pad + fontSize * lineGap * (i + 0.5), c.width - pad * 2);
  });
  const t = toTexture(c);
  return { texture: t, aspect: c.width / c.height };
}

/**
 * Anillo de Landolt: un anillo con un hueco en una de 4 direcciones.
 * Proporciones estándar: diámetro exterior D, trazo D/5, hueco D/5.
 * El hueco es el "detalle crítico", así que la agudeza se mide por su tamaño angular.
 */
export function landoltC(dir, px = 512) {
  const c = canvas(px, px);
  const g = c.getContext('2d');
  g.fillStyle = '#ffffff';
  g.fillRect(0, 0, px, px);

  const D = px * 0.92;
  const stroke = D / 5;
  const r = (D - stroke) / 2;
  const cx = px / 2, cy = px / 2;
  const gapAngle = (stroke / r);           // arco del hueco = un ancho de trazo

  const base = { right: 0, up: -Math.PI / 2, left: Math.PI, down: Math.PI / 2 }[dir] ?? 0;
  g.strokeStyle = '#000000';
  g.lineWidth = stroke;
  g.beginPath();
  g.arc(cx, cy, r, base + gapAngle / 2, base - gapAngle / 2 + Math.PI * 2);
  g.stroke();
  return toTexture(c);
}

/** Rejilla de calibración: cuadrícula + círculos concéntricos + marcas de borde. */
export function calibrationGrid(px = 1024) {
  const c = canvas(px, px);
  const g = c.getContext('2d');
  g.fillStyle = '#0a0f16';
  g.fillRect(0, 0, px, px);

  g.strokeStyle = '#2f4a63'; g.lineWidth = 2;
  const n = 10;
  for (let i = 0; i <= n; i++) {
    const p = (i / n) * px;
    g.beginPath(); g.moveTo(p, 0); g.lineTo(p, px); g.stroke();
    g.beginPath(); g.moveTo(0, p); g.lineTo(px, p); g.stroke();
  }
  g.strokeStyle = '#4cc2ff'; g.lineWidth = 4;
  for (let i = 1; i <= 5; i++) {
    g.beginPath(); g.arc(px / 2, px / 2, (i / 5) * px * 0.48, 0, Math.PI * 2); g.stroke();
  }
  // cruz central y esquinas: para ver curvatura residual y aberración de color
  g.strokeStyle = '#ff5f6d'; g.lineWidth = 5;
  g.beginPath(); g.moveTo(px / 2, px * 0.44); g.lineTo(px / 2, px * 0.56);
  g.moveTo(px * 0.44, px / 2); g.lineTo(px * 0.56, px / 2); g.stroke();
  g.fillStyle = '#ffffff';
  g.font = `600 ${Math.round(px * 0.03)}px system-ui, sans-serif`;
  g.textAlign = 'center';
  g.fillText('las líneas rectas deben verse rectas', px / 2, px * 0.34);
  g.fillText('los círculos, redondos', px / 2, px * 0.70);
  return toTexture(c);
}

/** Grados visuales -> tamaño en metros de un plano a distancia d. */
export function angularSize(arcmin, distance) {
  return 2 * distance * Math.tan((arcmin / 60) * Math.PI / 180 / 2);
}
