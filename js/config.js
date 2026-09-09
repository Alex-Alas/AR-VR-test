// Parámetros de calibración del visor. Se guardan en localStorage.
const KEY = 'xrbench.calib.v1';

export const SCHEMA = [
  { k:'ipd',        label:'IPD (separación de ojos)', min:52, max:76, step:0.5, val:63, unit:'mm',
    desc:'Distancia interpupilar. Mide la tuya o probá hasta que las dos imágenes fusionen sin esfuerzo.' },
  { k:'lensSep',    label:'Separación de centros de lente', min:0, max:20, step:0.5, val:0, unit:'% ancho',
    desc:'Desplaza el centro de cada media pantalla hacia afuera. Si ves viñeteo asimétrico, ajustá acá.' },
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
    desc:'Medilo con una regla (lado corto del área visible). Sin esto, los grados del modo pantalla son inventados.' },
  { k:'viewDist',   label:'Distancia de visión en mano', min:15, max:60, step:1, val:30, unit:'cm',
    desc:'A qué distancia sostenés el teléfono en el modo pantalla. Define el FOV equivalente.' },
  { k:'distortion', label:'Distorsión activada', min:0, max:1, step:1, val:1, unit:'0/1',
    desc:'Apagala para comparar legibilidad con y sin corrección de lente.' },
];

const defaults = Object.fromEntries(SCHEMA.map(s => [s.k, s.val]));

function load() {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) || '{}');
    return { ...defaults, ...raw };
  } catch { return { ...defaults }; }
}

export const config = load();

export function setConfig(k, v) {
  config[k] = v;
  try { localStorage.setItem(KEY, JSON.stringify(config)); } catch {}
}

export function resetConfig() {
  Object.assign(config, defaults);
  try { localStorage.removeItem(KEY); } catch {}
}
