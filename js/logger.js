// Registro de resultados: todo lo que miden los tests cae acá y se exporta como JSON.
const KEY = 'xrbench.records.v1';

function deviceInfo() {
  const s = window.screen || {};
  return {
    ua: navigator.userAgent,
    platform: navigator.platform,
    screenCssPx: [s.width | 0, s.height | 0],
    devicePixelRatio: window.devicePixelRatio || 1,
    screenPhysicalPx: [Math.round((s.width | 0) * (devicePixelRatio || 1)),
                       Math.round((s.height | 0) * (devicePixelRatio || 1))],
    deviceMemoryGB: navigator.deviceMemory ?? null,
    cores: navigator.hardwareConcurrency ?? null,
    lang: navigator.language,
  };
}

class LoggerImpl {
  constructor() {
    this.session = {
      id: Math.random().toString(36).slice(2, 10),
      startedAt: new Date().toISOString(),
      device: deviceInfo(),
      support: {},
    };
    this.records = [];
    try {
      const prev = JSON.parse(localStorage.getItem(KEY) || 'null');
      if (prev && Array.isArray(prev.records)) this.records = prev.records;
    } catch {}
    this.listeners = [];
  }

  log(test, data) {
    const rec = { t: new Date().toISOString(), session: this.session.id, test, ...data };
    this.records.push(rec);
    this._persist();
    this.listeners.forEach(fn => fn(rec));
    return rec;
  }

  onLog(fn) { this.listeners.push(fn); }

  clear() { this.records = []; this._persist(); }

  _persist() {
    try { localStorage.setItem(KEY, JSON.stringify({ records: this.records })); } catch {}
  }

  toJSON() {
    return JSON.stringify({ session: this.session, records: this.records }, null, 2);
  }

  download() {
    const blob = new Blob([this.toJSON()], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `xrbench-${this.session.id}-${Date.now()}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  }

  async copy() {
    try { await navigator.clipboard.writeText(this.toJSON()); return true; }
    catch { return false; }
  }
}

export const Logger = new LoggerImpl();

// Estadística simple para los resúmenes de cada test.
export function stats(arr) {
  if (!arr.length) return null;
  const a = [...arr].sort((x, y) => x - y);
  const n = a.length;
  const mean = a.reduce((s, v) => s + v, 0) / n;
  const sd = Math.sqrt(a.reduce((s, v) => s + (v - mean) ** 2, 0) / n);
  const q = p => a[Math.min(n - 1, Math.max(0, Math.round(p * (n - 1))))];
  return { n, mean:+mean.toFixed(3), sd:+sd.toFixed(3), min:a[0], p50:q(.5), p95:q(.95), max:a[n-1] };
}
