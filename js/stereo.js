// Render mono o estéreo.
//
// Dos decisiones que importan para que las mediciones signifiquen algo:
//  1. Trabajamos en valores de display crudos (ColorManagement apagado en main.js).
//     Si three convierte a lineal y de vuelta, un gris 128 deja de ser 128 y el
//     test de contraste mide la gestión de color de three, no la pantalla.
//  2. El passthrough se dibuja con un quad propio en vez de scene.background,
//     para controlar exactamente el recorte y que el cursor de la mano caiga
//     donde el ojo ve el dedo.
import * as THREE from 'three';
import { config } from './config.js';

const QUAD_VERT = /* glsl */`
varying vec2 vUv;
void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }
`;

const DISTORT_FRAG = /* glsl */`
precision highp float;
uniform sampler2D tSrc;
uniform vec2  uCenter;
uniform float uK1, uK2, uChroma, uAspect, uEnabled;
varying vec2 vUv;

vec2 warp(vec2 uv, float scale){
  vec2 c = uv - uCenter;
  c.x *= uAspect;                 // isotropía: r debe medir igual en x y en y
  float r2 = dot(c, c);
  c *= 1.0 + (uK1 * r2 + uK2 * r2 * r2) * scale;
  c.x /= uAspect;
  return uCenter + c;
}

vec3 sampleAt(vec2 uv){
  if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) return vec3(0.0);
  return texture2D(tSrc, uv).rgb;
}

void main(){
  if (uEnabled < 0.5) { gl_FragColor = vec4(texture2D(tSrc, vUv).rgb, 1.0); return; }
  vec2 uvG = warp(vUv, 1.0);
  vec3 col;
  if (uChroma > 0.0001){
    col.r = sampleAt(warp(vUv, 1.0 + uChroma)).r;
    col.g = sampleAt(uvG).g;
    col.b = sampleAt(warp(vUv, 1.0 - uChroma)).b;
    if (uvG.x < 0.0 || uvG.x > 1.0 || uvG.y < 0.0 || uvG.y > 1.0) col = vec3(0.0);
  } else {
    col = sampleAt(uvG);
  }
  gl_FragColor = vec4(col, 1.0);
}
`;

const BG_FRAG = /* glsl */`
precision mediump float;
uniform sampler2D tSrc;
uniform vec2 uRepeat, uOffset;
varying vec2 vUv;
void main(){ gl_FragColor = vec4(texture2D(tSrc, vUv * uRepeat + uOffset).rgb, 1.0); }
`;

function fullscreenQuad(material) {
  const m = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), material);
  m.frustumCulled = false;
  const s = new THREE.Scene();
  s.add(m);
  return { scene: s, mesh: m };
}

export class Rig {
  /** @param {THREE.WebGLRenderer} renderer */
  constructor(renderer) {
    this.renderer = renderer;
    this.mode = 'mono';
    this.w = 1; this.h = 1;

    this.eyeCams = [new THREE.PerspectiveCamera(), new THREE.PerspectiveCamera()];
    this.monoCam = new THREE.PerspectiveCamera(70, 1, 0.01, 200);
    this.targets = [null, null];
    this.quadCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

    this.distortMat = new THREE.ShaderMaterial({
      vertexShader: QUAD_VERT, fragmentShader: DISTORT_FRAG,
      depthTest: false, depthWrite: false,
      uniforms: {
        tSrc: { value: null }, uCenter: { value: new THREE.Vector2(0.5, 0.5) },
        uK1: { value: 0.22 }, uK2: { value: 0.20 }, uChroma: { value: 0 },
        uAspect: { value: 1 }, uEnabled: { value: 1 },
      },
    });
    this.distortQuad = fullscreenQuad(this.distortMat);

    this.bgMat = new THREE.ShaderMaterial({
      vertexShader: QUAD_VERT, fragmentShader: BG_FRAG,
      depthTest: false, depthWrite: false,
      uniforms: {
        tSrc: { value: null },
        uRepeat: { value: new THREE.Vector2(1, 1) },
        uOffset: { value: new THREE.Vector2(0, 0) },
      },
    });
    this.bgQuad = fullscreenQuad(this.bgMat);
    this.passthrough = null;
  }

  setSize(w, h) {
    this.w = Math.max(1, w); this.h = Math.max(1, h);
    this._allocTargets();
  }

  _allocTargets() {
    const pr = this.renderer.getPixelRatio();
    const tw = Math.max(2, Math.floor((this.w / 2) * pr));
    const th = Math.max(2, Math.floor(this.h * pr));
    for (let i = 0; i < 2; i++) {
      if (this.targets[i]) this.targets[i].setSize(tw, th);
      else this.targets[i] = new THREE.WebGLRenderTarget(tw, th, {
        minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, depthBuffer: true,
      });
    }
  }

  /** Passthrough de cámara. `crop` viene de CameraFeed.fitTo(). */
  setPassthrough(texture, crop) {
    this.passthrough = texture || null;
    if (texture && crop) {
      this.bgMat.uniforms.tSrc.value = texture;
      this.bgMat.uniforms.uRepeat.value.set(crop.rx, crop.ry);
      this.bgMat.uniforms.uOffset.value.set(crop.ox, crop.oy);
    }
  }

  /** Aspecto del viewport de UN ojo (o de la pantalla completa en mono). */
  get viewAspect() {
    return this.mode === 'stereo' ? (this.w / 2) / this.h : this.w / this.h;
  }

  get camera() { return this.monoCam; }

  /**
   * FOV vertical efectivo. En estéreo lo fija la lente; en pantalla lo fija la
   * geometría real: el alto físico del display a la distancia a la que lo
   * sostenés. Sin eso, los grados del modo pantalla no significarían nada.
   */
  get fov() {
    if (this.mode === 'stereo') return config.fov;
    return 2 * Math.atan((config.screenH / 2) / config.viewDist) * 180 / Math.PI;
  }

  syncCameraParams() {
    this.monoCam.fov = this.fov;
    this.monoCam.aspect = this.viewAspect;
    this.monoCam.near = 0.01;
    this.monoCam.far = 200;
    this.monoCam.updateProjectionMatrix();
  }

  _renderEye(scene, cam) {
    const r = this.renderer;
    r.autoClear = false;
    r.clear(true, true, true);
    if (this.passthrough) r.render(this.bgQuad.scene, this.quadCam);
    r.render(scene, cam);
    r.autoClear = true;
  }

  render(scene, head) {
    const r = this.renderer;

    if (this.mode !== 'stereo') {
      r.setRenderTarget(null);
      r.setScissorTest(false);
      r.setViewport(0, 0, this.w, this.h);
      this._renderEye(scene, head);
      return;
    }

    head.updateMatrixWorld();
    const ipdM = config.ipd / 1000;
    const right = new THREE.Vector3(1, 0, 0).applyQuaternion(head.quaternion);

    for (let i = 0; i < 2; i++) {
      const cam = this.eyeCams[i];
      cam.fov = this.fov;
      cam.aspect = this.viewAspect;
      cam.near = 0.01; cam.far = 200;
      cam.position.copy(head.position).addScaledVector(right, (i === 0 ? -1 : 1) * ipdM / 2);
      cam.quaternion.copy(head.quaternion);
      cam.updateProjectionMatrix();
      cam.updateMatrixWorld(true);

      // Ojo: setViewport() toma píxeles CSS y three los multiplica por el pixel
      // ratio. Para un render target no hay que tocarlo: setRenderTarget() ya
      // deja el viewport en el tamaño real del target.
      r.setRenderTarget(this.targets[i]);
      r.setScissorTest(false);
      this._renderEye(scene, cam);
    }

    // composición con pre-distorsión de barril
    r.setRenderTarget(null);
    r.setScissorTest(true);
    const u = this.distortMat.uniforms;
    u.uK1.value = config.k1;
    u.uK2.value = config.k2;
    u.uChroma.value = config.chroma;
    u.uAspect.value = this.viewAspect;
    u.uEnabled.value = config.distortion ? 1 : 0;
    const off = config.lensSep / 100;

    r.autoClear = false;
    for (let i = 0; i < 2; i++) {
      const x = i === 0 ? 0 : this.w / 2;
      r.setViewport(x, 0, this.w / 2, this.h);
      r.setScissor(x, 0, this.w / 2, this.h);
      u.tSrc.value = this.targets[i].texture;
      u.uCenter.value.set(i === 0 ? 0.5 - off : 0.5 + off, 0.5);
      r.render(this.distortQuad.scene, this.quadCam);
    }
    r.autoClear = true;
    r.setScissorTest(false);
    r.setViewport(0, 0, this.w, this.h);
  }

  dispose() {
    this.targets.forEach(t => t?.dispose());
    this.targets = [null, null];
    this.distortQuad.mesh.geometry.dispose();
    this.bgQuad.mesh.geometry.dispose();
    this.distortMat.dispose();
    this.bgMat.dispose();
  }
}
