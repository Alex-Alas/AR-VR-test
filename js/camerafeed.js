// Feed de la cámara trasera: sirve de passthrough (fondo estéreo) y de entrada
// para el hand tracking. Un solo <video> alimenta las dos cosas.
import * as THREE from 'three';
import { el, log, logErr } from './ui.js';

export class CameraFeed {
  constructor() {
    this.video = el.video;
    this.stream = null;
    this.texture = null;
    this.ready = false;
  }

  async start() {
    if (this.ready) return true;
    if (!navigator.mediaDevices?.getUserMedia) { logErr('getUserMedia no disponible (¿sitio sin HTTPS?)'); return false; }
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } },
      });
    } catch (e) {
      logErr('cámara denegada o no disponible: ' + e.message);
      return false;
    }
    this.video.srcObject = this.stream;
    await this.video.play().catch(e => logErr('video.play(): ' + e.message));
    await new Promise(res => {
      if (this.video.videoWidth) return res();
      this.video.onloadedmetadata = () => res();
      setTimeout(res, 3000);
    });

    this.texture = new THREE.VideoTexture(this.video);
    this.texture.wrapS = this.texture.wrapT = THREE.ClampToEdgeWrapping;
    this.texture.minFilter = THREE.LinearFilter;

    const track = this.stream.getVideoTracks()[0];
    const s = track?.getSettings?.() || {};
    log(`cámara: ${this.video.videoWidth}x${this.video.videoHeight} @${s.frameRate ?? '?'}fps (${s.facingMode ?? '?'})`);
    this.settings = s;
    this.ready = true;
    return true;
  }

  stop() {
    this.stream?.getTracks().forEach(t => t.stop());
    this.stream = null;
    this.texture?.dispose();
    this.texture = null;
    this.ready = false;
  }

  get aspect() {
    return this.video.videoWidth && this.video.videoHeight
      ? this.video.videoWidth / this.video.videoHeight : 16 / 9;
  }

  /** Recorta la textura tipo "cover" para el aspecto del viewport dado. */
  fitTo(viewAspect) {
    if (!this.texture) return;
    const va = this.aspect;
    const t = this.texture;
    if (viewAspect > va) {            // viewport más ancho: recortamos arriba y abajo
      t.repeat.set(1, va / viewAspect);
      t.offset.set(0, (1 - t.repeat.y) / 2);
    } else {                          // viewport más alto: recortamos a los lados
      t.repeat.set(viewAspect / va, 1);
      t.offset.set((1 - t.repeat.x) / 2, 0);
    }
    this.crop = { rx: t.repeat.x, ry: t.repeat.y, ox: t.offset.x, oy: t.offset.y };
  }

  /**
   * Punto normalizado de la imagen de MediaPipe (x,y en [0,1], origen arriba-izq)
   * a NDC del viewport, usando el mismo recorte que el fondo.
   * Así el cursor cae donde tus ojos ven el dedo.
   */
  imageToNdc(nx, ny, out = { x: 0, y: 0, visible: true }) {
    const c = this.crop || { rx: 1, ry: 1, ox: 0, oy: 0 };
    const u = (nx - c.ox) / c.rx;          // u en [0,1] del viewport
    const v = ((1 - ny) - c.oy) / c.ry;    // MediaPipe mide y hacia abajo; la textura, hacia arriba
    out.x = u * 2 - 1;
    out.y = v * 2 - 1;
    out.visible = u >= 0 && u <= 1 && v >= 0 && v <= 1;
    return out;
  }
}
