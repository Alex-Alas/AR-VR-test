// Hand tracking por visión con MediaPipe Tasks. Es lo que reemplaza al hand
// tracking de hardware que un visor Cardboard no tiene: la cámara trasera mira
// hacia adelante por la apertura del visor y ahí ponés las manos.
import { log, logErr, logWarn } from './ui.js';

const VERSION = '0.10.14';
const CDN = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${VERSION}`;
const MODEL = 'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task';

// Índices de landmarks que usamos
export const LM = { WRIST: 0, THUMB_TIP: 4, INDEX_MCP: 5, INDEX_TIP: 8, MIDDLE_MCP: 9, MIDDLE_TIP: 12 };

export class HandTracker {
  constructor() {
    this.ready = false;
    this.landmarker = null;
    this.lastTs = -1;
    this.frames = 0;
    this.detections = 0;
    this.pinching = false;
    this.result = { present: false, pinching: false, pinchRatio: 1, index: null, thumb: null, landmarks: null };
  }

  async init() {
    if (this.ready) return true;
    let mod;
    try {
      mod = await import(/* @vite-ignore */ `${CDN}/vision_bundle.mjs`);
    } catch (e) {
      logWarn('vision_bundle.mjs falló, probando raíz del paquete');
      try { mod = await import(/* @vite-ignore */ CDN); }
      catch (e2) { logErr('no se pudo cargar MediaPipe: ' + e2.message); return false; }
    }
    try {
      const fileset = await mod.FilesetResolver.forVisionTasks(`${CDN}/wasm`);
      this.landmarker = await mod.HandLandmarker.createFromOptions(fileset, {
        baseOptions: { modelAssetPath: MODEL, delegate: 'GPU' },
        runningMode: 'VIDEO',
        numHands: 1,
        minHandDetectionConfidence: 0.5,
        minHandPresenceConfidence: 0.5,
        minTrackingConfidence: 0.5,
      });
      this.ready = true;
      log('MediaPipe HandLandmarker listo (GPU)');
      return true;
    } catch (e) {
      logErr('HandLandmarker: ' + e.message);
      return false;
    }
  }

  /**
   * Procesa un frame de video. Devuelve el estado actual de la mano.
   * Hay que llamarlo como mucho una vez por frame de video (MediaPipe exige
   * timestamps estrictamente crecientes).
   */
  detect(video, tsMs) {
    if (!this.ready || !video.videoWidth) return this.result;
    if (tsMs <= this.lastTs) return this.result;
    this.lastTs = tsMs;
    this.frames++;

    let res;
    try { res = this.landmarker.detectForVideo(video, tsMs); }
    catch (e) { logWarn('detectForVideo: ' + e.message); return this.result; }

    const lms = res?.landmarks?.[0];
    if (!lms) {
      this.result.present = false;
      this.result.pinching = false;
      this.pinching = false;
      return this.result;
    }
    this.detections++;

    const idx = lms[LM.INDEX_TIP], th = lms[LM.THUMB_TIP];
    const wrist = lms[LM.WRIST], mmcp = lms[LM.MIDDLE_MCP];
    // Escala de la mano en la imagen: sirve para normalizar el pinch a cualquier distancia.
    const scale = Math.hypot(mmcp.x - wrist.x, mmcp.y - wrist.y) || 0.001;
    const pinchDist = Math.hypot(idx.x - th.x, idx.y - th.y);
    const ratio = pinchDist / scale;

    // Histéresis: entra en pinch a 0.35, sale a 0.55. Evita el parpadeo.
    if (!this.pinching && ratio < 0.35) this.pinching = true;
    else if (this.pinching && ratio > 0.55) this.pinching = false;

    this.result.present = true;
    this.result.landmarks = lms;
    this.result.index = idx;
    this.result.thumb = th;
    this.result.handScale = scale;
    this.result.pinchRatio = ratio;
    this.result.pinching = this.pinching;
    this.result.handedness = res.handedness?.[0]?.[0]?.categoryName ?? null;
    return this.result;
  }

  get trackingRate() { return this.frames ? this.detections / this.frames : 0; }

  reset() { this.frames = 0; this.detections = 0; }

  dispose() {
    try { this.landmarker?.close(); } catch {}
    this.landmarker = null; this.ready = false;
  }
}
