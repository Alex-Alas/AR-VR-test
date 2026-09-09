// Parámetros de calibración del visor. Se guardan en localStorage.
const KEY = 'xrbench.calib.v1';

export const SCHEMA = [
  { k:'ipd',        label:'IPD (separación de ojos)', min:52, max:76, step:0.5, val:63, unit:'mm',
    desc:'Distancia interpupilar. Solo afecta la paralaje entre los dos ojos, no la fusión.' },
  { k:'imgSep',     label:'Separación de las dos imágenes', min:25, max:62, step:0.5, val:45, unit:'% ancho',
    desc:'LO PRIMERO que hay que ajustar: distancia entre los centros de las dos imágenes, en % del ancho TOTAL de la pantalla. Tiene que dar igual a la separación entre los centros de tus lentes. Cuenta: separación de lentes ÷ ancho de pantalla × 100 (63 mm ÷ 140 mm ≈ 45%). Si la ponés en 50% cada imagen queda centrada en su media pantalla y en casi ningún teléfono fusiona.' },
  { k:'fov',        label:'FOV vertical de render', min:40, max:110, step:1, val:80, unit:'°',
    desc:'FOV con el que se renderiza cada ojo. Subilo si el patrón de ajuste se ve recortado.' },
  { k:'k1',         label:'Distorsión k1', min:-0.6, max:0.8, step:0.01, val:0.22, unit:'',
    desc:'Pre-distorsión de barril para cancelar el efecto almohadilla de la lente.' },
  { k:'k2',         label:'Distorsión k2', min:-0.6, max:0.8, step:0.01, val:0.20, unit:'',
    desc:'Término de segundo orden. Tocá esto solo si las esquinas siguen curvadas.' },
  { k:'chroma',     label:'Corrección cromática', min:0, max:0.06, step:0.002, val:0.0, unit:'',
    desc:'Separa R/B para compensar la franja de color en los bordes de la lente.' },
  { k:'camFov',     label:'FOV vertical de la cámara', min:25, max:80, step:1, val:45, unit:'°',
    desc:'FOV real de tu cámara trasera. Calibralo en el Test 2 hasta que el cursor caiga sobre tu dedo.' },
  { k:'dwell',      label:'Tiempo de dwell (mirada)', min:0.4, max:3, step:0.1, val:1.2, unit:'s',
    desc:'Cuánto hay que mantener la mirada sobre un botón para activarlo dentro del visor.' },
  { k:'screenH',    label:'Alto físico de la pantalla', min:5, max:20, step:0.1, val:14, unit:'cm',
    desc:'Medilo con una regla, en la posición en la que sostenés el teléfono para el modo pantalla (con el teléfono vertical es el lado largo). Sin esto, los grados del modo pantalla son inventados.' },
  { k:'viewDist',   label:'Distancia de visión en mano', min:15, max:60, step:1, val:30, unit:'cm',
    desc:'A qué distancia sostenés el teléfono en el modo pantalla. Define el FOV equivalente.' },
  { k:'distortion', label:'Distorsión activada', min:0, max:1, step:1, val:1, unit:'0/1',
    desc:'Apagala para comparar legibilidad con y sin corrección de lente.' },
];

const defaults = Object.fromEntries(SCHEMA.map(s => [s.k, s.val]));

/**
 * `lensSep` (v1 temprana) desplazaba el centro de distorsión hacia afuera desde
 * el centro de cada media pantalla, con 0 = centrado. Es el mismo grado de
 * libertad que `imgSep`, con otro origen: imgSep% = 50 + lensSep.
 */
function migrate(raw) {
  if (raw.imgSep === undefined && typeof raw.lensSep === 'number') {
    raw.imgSep = 50 + raw.lensSep;
  }
  delete raw.lensSep;
  return raw;
}

function load() {
  try {
    const raw = migrate(JSON.parse(localStorage.getItem(KEY) || '{}'));
    return { ...defaults, ...raw };
  } catch { return { ...defaults }; }
}

export const config = load();

export function setConfig(k, v) {
  config[k] = v;
  try { localStorage.setItem(KEY, JSON.stringify(config)); } catch {}
}

/** Igual que setConfig, pero recorta al rango del slider. Para los ajustes en visor. */
export function nudgeConfig(k, delta) {
  const s = SCHEMA.find(x => x.k === k);
  if (!s) return config[k];
  const v = Math.min(s.max, Math.max(s.min, +(config[k] + delta).toFixed(4)));
  setConfig(k, v);
  return v;
}

export function resetConfig() {
  Object.assign(config, defaults);
  try { localStorage.removeItem(KEY); } catch {}
}
