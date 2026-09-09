// Render mono o estéreo.
//
// Tres decisiones que importan para que las mediciones signifiquen algo:
//  1. Trabajamos en valores de display crudos (ColorManagement apagado en main.js).
//     Si three convierte a lineal y de vuelta, un gris 128 deja de ser 128 y el
//     test de contraste mide la gestión de color de three, no la pantalla.
//  2. El passthrough se dibuja con un quad propio en vez de scene.background,
//     para controlar exactamente el recorte y que el cursor de la mano caiga
//     donde el ojo ve el dedo.
//  3. Cada ojo se renderiza con un frustum DESCENTRADO, de modo que el "adelante"
//     de la cámara caiga sobre el centro de la lente y no sobre el centro de la
//     media pantalla. Ver la nota larga en `eyeShiftNdc`: sin esto la imagen no
//     fusiona en ningún teléfono cuya pantalla sea más ancha que la separación
//     de las lentes, que son casi todos.
import * as THREE from 'three';
import { config } from './config.js';

/** Capas para contenido monocular (tests de alineación). */
export const LAYER_LEFT = 1;
export const LAYER_RIGHT = 2;

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

// uShift desplaza el passthrough igual que el frustum descentrado desplaza la
// escena 3D. Si no, el fondo de cámara y el cursor de la mano se separarían
// justo en la magnitud del descentrado.
const BG_FRAG = /* glsl */`
precision mediump float;
uniform sampler2D tSrc;
uniform vec2 uRepeat, uOffset, uShift;
varying vec2 vUv;
void main(){ gl_FragColor = vec4(texture2D(tSrc, (vUv - uShift) * uRepeat + uOffset).rgb, 1.0); }
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
    this.eyeCams[0].layers.enable(LAYER_LEFT);
    this.eyeCams[1].layers.enable(LAYER_RIGHT);
    this.monoCam = new THREE.PerspectiveCamera(70, 1, 0.01, 200);
    this.monoCam.layers.enable(LAYER_LEFT);
    this.monoCam.layers.enable(LAYER_RIGHT);
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
        uShift:  { value: new THREE.Vector2(0, 0) },
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

  /**
   * Cuánto hay que correr el eje óptico de cada ojo, en NDC del medio viewport
   * (positivo = hacia adentro, hacia la nariz), para que caiga sobre el centro
   * de la lente.
   *
   * El ojo mira a través del centro de su lente: lo que ve "de frente" es el
   * píxel que está sobre el eje de la lente, no el píxel del centro de su media
   * pantalla. Con un teléfono de 140 mm de ancho los centros de las dos medias
   * pantallas quedan a 70 mm, pero las lentes están a 63 mm: cada imagen queda
   * 3,5 mm más afuera de lo que debería. A través de una lente de ~40 mm de
   * focal eso son ~5° de divergencia por ojo, y el ojo tolera menos de 1°. La
   * imagen no fusiona por más que la IPD y la distorsión estén perfectas.
   *
   * `imgSep` es la separación entre los dos centros de imagen en % del ancho
   * total; 50% deja cada imagen centrada en su media pantalla (el caso roto).
   */
  get eyeShiftNdc() {
    if (this.mode !== 'stereo') return 0;
    return THREE.MathUtils.clamp(1 - config.imgSep / 50, -0.6, 0.6);
  }

  syncCameraParams() {
    this.monoCam.fov = this.fov;
    this.monoCam.aspect = this.viewAspect;
    this.monoCam.near = 0.01;
    this.monoCam.far = 200;
    this.monoCam.updateProjectionMatrix();
  }

  /** Proyección con el eje óptico corrido `shift` en NDC horizontal. */
  _setEyeProjection(cam, shift) {
    const near = cam.near, far = cam.far;
    const top = near * Math.tan(THREE.MathUtils.DEG2RAD * 0.5 * cam.fov);
    const width = 2 * top * cam.aspect;
    // (izq+der)/(der-izq) tiene que valer -shift para que el punto de fuga caiga
    // en NDC x = shift; eso equivale a correr el frustum entero -shift*ancho/2.
    const left = -width / 2 - shift * width / 2;
    cam.projectionMatrix.makePerspective(left, left + width, top, -top, near, far);
    cam.projectionMatrixInverse.copy(cam.projectionMatrix).invert();
  }

  _renderEye(scene, cam, shift = 0) {
    const r = this.renderer;
    r.autoClear = false;
    r.clear(true, true, true);
    if (this.passthrough) {
      this.bgMat.uniforms.uShift.value.set(shift / 2, 0);
      r.render(this.bgQuad.scene, this.quadCam);
    }
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
    const shift = this.eyeShiftNdc;

    for (let i = 0; i < 2; i++) {
      const sign = i === 0 ? 1 : -1;             // el ojo izquierdo mira hacia la derecha
      const cam = this.eyeCams[i];
      cam.fov = this.fov;
      cam.aspect = this.viewAspect;
      cam.near = 0.01; cam.far = 200;
      cam.position.copy(head.position).addScaledVector(right, -sign * ipdM / 2);
      cam.quaternion.copy(head.quaternion);
      this._setEyeProjection(cam, sign * shift);
      cam.updateMatrixWorld(true);

      // Ojo: setViewport() toma píxeles CSS y three los multiplica por el pixel
      // ratio. Para un render target no hay que tocarlo: setRenderTarget() ya
      // deja el viewport en el tamaño real del target.
      r.setRenderTarget(this.targets[i]);
      r.setScissorTest(false);
      this._renderEye(scene, cam, sign * shift);
    }

    // composición con pre-distorsión de barril, centrada en la lente
    r.setRenderTarget(null);
    r.setScissorTest(true);
    const u = this.distortMat.uniforms;
    u.uK1.value = config.k1;
    u.uK2.value = config.k2;
    u.uChroma.value = config.chroma;
    u.uAspect.value = this.viewAspect;
    u.uEnabled.value = config.distortion ? 1 : 0;

    r.autoClear = false;
    for (let i = 0; i < 2; i++) {
      const sign = i === 0 ? 1 : -1;
      const x = i === 0 ? 0 : this.w / 2;
      r.setViewport(x, 0, this.w / 2, this.h);
      r.setScissor(x, 0, this.w / 2, this.h);
      u.tSrc.value = this.targets[i].texture;
      u.uCenter.value.set(0.5 + sign * shift / 2, 0.5);
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
