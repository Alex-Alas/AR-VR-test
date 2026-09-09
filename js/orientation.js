// Tracking de cabeza 3DOF con el giroscopio/acelerómetro (DeviceOrientation).
// Es la misma matemática de los viejos DeviceOrientationControls de three.js.
import * as THREE from 'three';
import { log, logWarn } from './ui.js';

const ZEE = new THREE.Vector3(0, 0, 1);
const EULER = new THREE.Euler();
const Q0 = new THREE.Quaternion();
const Q1 = new THREE.Quaternion(-Math.SQRT1_2, 0, 0, Math.SQRT1_2); // -90° en X
const D2R = Math.PI / 180;

export class HeadTracker {
  constructor() {
    this.enabled = false;
    this.hasData = false;
    this.device = { alpha: 0, beta: 0, gamma: 0 };
    this.screenAngle = 0;
    this.yawOffset = 0;          // recentrado manual
    this._quat = new THREE.Quaternion();
    this._onOrient = e => {
      if (e.alpha == null && e.beta == null && e.gamma == null) return;
      this.hasData = true;
      this.device.alpha = e.alpha || 0;
      this.device.beta  = e.beta  || 0;
      this.device.gamma = e.gamma || 0;
    };
    this._onScreen = () => {
      this.screenAngle = (screen.orientation?.angle ?? window.orientation ?? 0) || 0;
    };
  }

  async start() {
    // iOS exige permiso explícito; Android no.
    const DOE = window.DeviceOrientationEvent;
    if (!DOE) { logWarn('DeviceOrientationEvent no disponible'); return false; }
    if (typeof DOE.requestPermission === 'function') {
      try {
        const r = await DOE.requestPermission();
        if (r !== 'granted') { logWarn('permiso de orientación denegado'); return false; }
      } catch (e) { logWarn('permiso de orientación falló: ' + e.message); return false; }
    }
    this._onScreen();
    window.addEventListener('deviceorientation', this._onOrient, true);
    window.addEventListener('orientationchange', this._onScreen, false);
    screen.orientation?.addEventListener?.('change', this._onScreen);
    this.enabled = true;
    log('head tracking activo');
    // Si en 1.5 s no llegó ni un evento, avisamos: probablemente no hay sensor.
    setTimeout(() => { if (!this.hasData) logWarn('no llegan datos de orientación — ¿el visor no tiene giroscopio o el sitio no es HTTPS?'); }, 1500);
    return true;
  }

  stop() {
    window.removeEventListener('deviceorientation', this._onOrient, true);
    window.removeEventListener('orientationchange', this._onScreen, false);
    screen.orientation?.removeEventListener?.('change', this._onScreen);
    this.enabled = false;
  }

  /** Toma el yaw actual como "adelante". */
  recenter() { this.yawOffset = this.device.alpha * D2R; }

  /** Escribe la orientación en el quaternion de la cámara. */
  apply(camera) {
    if (!this.enabled || !this.hasData) return false;
    const alpha = this.device.alpha * D2R - this.yawOffset;
    const beta  = this.device.beta  * D2R;
    const gamma = this.device.gamma * D2R;
    const orient = this.screenAngle * D2R;

    EULER.set(beta, alpha, -gamma, 'YXZ');
    this._quat.setFromEuler(EULER);
    this._quat.multiply(Q1);                                   // mirar al horizonte, no al piso
    this._quat.multiply(Q0.setFromAxisAngle(ZEE, -orient));    // compensar rotación de pantalla
    camera.quaternion.slerp(this._quat, 1);                    // sin suavizado: queremos ver el jitter real
    return true;
  }
}
