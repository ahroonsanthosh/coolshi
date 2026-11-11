// The Index: posters hung in a row on paper, printed on cloth. They ripple
// on their own, and bend and shear when you drag or scroll through them, the
// way a sheet of fabric would.

import * as THREE from 'three';
import { buildPosters, prepare, PH, PW, type Poster } from './posters.ts';
import { REDUCED_MOTION } from '../lib/motion.ts';

const GAP = 3.5; // world units between poster centres
const W = 2.62, H = (W * PH) / PW;

const vert = /* glsl */ `
  uniform float uTime;
  uniform float uVel;
  uniform float uHover;
  uniform float uSeed;
  uniform float uDrop;
  varying vec2 vUv;
  varying vec3 vNormal2;
  varying float vHang;

  // Displacement of the sheet at a point (x, y): z out of the page, plus a
  // sideways drift of the free end. Pinned along the top like a hung print.
  vec3 cloth(vec2 q) {
    float t = uTime * 0.9 + uSeed * 10.0;
    float hang = smoothstep(${(H / 2).toFixed(3)}, ${(-H / 2).toFixed(3)}, q.y);
    float wave = sin(q.x * 2.1 + t * 1.3) * 0.045 + sin(q.y * 2.7 - t * 1.1 + q.x) * 0.035;
    wave += sin((q.x + q.y) * 5.0 + t * 2.0) * 0.008;
    float amp = 0.55 + 0.45 * hang + uHover * 0.6;
    float z = wave * amp;
    float v = clamp(uVel, -1.5, 1.5);
    float xn = q.x / ${(W / 2).toFixed(3)};
    // Scrolling bows the sheet against the direction of travel and its free
    // end lags behind, catching air.
    z += -abs(v) * (1.0 - xn * xn) * 0.35;
    z += sin(q.y * 3.0 + t * 4.0) * abs(v) * 0.06 * hang;
    float dx = -v * hang * 0.22;
    return vec3(q.x + dx, q.y, z);
  }

  void main() {
    vUv = uv;
    vec2 q = position.xy;
    vec3 p = cloth(q);
    // Smooth normal from the displacement field (no faceting).
    float e = 0.01;
    vec3 px = cloth(q + vec2(e, 0.0)) - cloth(q - vec2(e, 0.0));
    vec3 py = cloth(q + vec2(0.0, e)) - cloth(q - vec2(0.0, e));
    vNormal2 = normalize(mat3(modelMatrix) * normalize(cross(px, py)));
    vHang = smoothstep(${(H / 2).toFixed(3)}, ${(-H / 2).toFixed(3)}, q.y);
    p.y += uDrop * 2.4;
    p.z += uDrop * 1.2;
    gl_Position = projectionMatrix * viewMatrix * modelMatrix * vec4(p, 1.0);
  }
`;

const frag = /* glsl */ `
  uniform sampler2D uMap;
  uniform float uDrop;
  varying vec2 vUv;
  varying vec3 vNormal2;
  varying float vHang;
  float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
  void main() {
    vec3 n = normalize(vNormal2);
    if (!gl_FrontFacing) n = -n;
    vec3 l = normalize(vec3(-0.35, 0.55, 0.9));
    float diff = clamp(dot(n, l), 0.0, 1.0);
    vec3 h = normalize(l + vec3(0.0, 0.0, 1.0));
    float spec = pow(clamp(dot(n, h), 0.0, 1.0), 28.0) * 0.07;
    vec4 tex = texture2D(uMap, vUv);
    // Fine paper tooth and a faint centre fold.
    float grain = (hash(floor(vUv * vec2(1400.0, 1960.0))) - 0.5) * 0.018;
    float fold = smoothstep(0.006, 0.0, abs(vUv.y - 0.5)) * 0.035;
    float light = 0.78 + diff * 0.3 + grain - fold;
    vec3 col = tex.rgb * light + spec;
    gl_FragColor = vec4(col, 1.0 - uDrop);
    #include <colorspace_fragment>
  }
`;

const shadowFrag = /* glsl */ `
  varying vec2 vUv;
  uniform float uDrop;
  void main() {
    vec2 d = (vUv - 0.5) * vec2(1.0, 1.0);
    float a = smoothstep(0.5, 0.1, length(d * vec2(1.0, 1.15)));
    gl_FragColor = vec4(0.27, 0.19, 0.11, a * 0.16 * (1.0 - uDrop));
  }
`;
const shadowVert = /* glsl */ `
  varying vec2 vUv;
  void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
`;

interface Item {
  poster: Poster;
  mesh: THREE.Mesh<THREE.PlaneGeometry, THREE.ShaderMaterial>;
  shadow: THREE.Mesh<THREE.PlaneGeometry, THREE.ShaderMaterial>;
  tex: THREE.CanvasTexture;
  hover: number;
  seed: number;
  tilt: number;
}

export class Gallery {
  private root: HTMLElement;
  private renderer: THREE.WebGLRenderer | null = null;
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(32, 1, 0.1, 100);
  private items: Item[] = [];
  private offset = 0;
  private target = 0;
  private vel = 0;
  private raf = 0;
  private t0 = 0;
  private openedAt = 0;
  private hovered = -1;
  private ray = new THREE.Raycaster();
  private mouse = new THREE.Vector2(9, 9);
  private drag: { x: number; start: number; moved: boolean } | null = null;
  private onPick: (p: Poster) => void;
  private cap: { t: HTMLElement; s: HTMLElement } | null = null;
  private lastCap = -1;

  constructor(root: HTMLElement, onPick: (p: Poster) => void) {
    this.root = root;
    this.onPick = onPick;
  }

  get isOpen() { return !this.root.hidden; }
  /** Bumped on every open and close, so an open still waiting on fonts and
   * data gives up if the Index was closed (or reopened) meanwhile. */
  private gen = 0;

  async open() {
    const gen = ++this.gen;
    this.root.hidden = false;
    this.root.innerHTML = `
      <div class="ix-top"><span>Index · the picture right now</span><button data-act="close-index">Back to the map</button></div>
      <div class="ix-cap"><div class="t"></div><div class="s"></div></div>
      <div class="ix-hint">Scroll or drag · click a poster to go there</div>`;
    this.cap = { t: this.root.querySelector('.ix-cap .t')!, s: this.root.querySelector('.ix-cap .s')! };
    this.root.querySelector('[data-act="close-index"]')!.addEventListener('click', () => this.close());
    document.querySelector('[data-act="index"]')?.setAttribute('aria-pressed', 'true');
    try {
      await Promise.all([document.fonts.load('900 100px Inter'), document.fonts.load('500 30px Inter'), document.fonts.load('700 30px Inter'), document.fonts.load('800 60px Inter')]);
    } catch { /* fall back to system font */ }
    await prepare();
    if (this.root.hidden || gen !== this.gen) return;
    this.build();
    this.bind();
    this.openedAt = performance.now();
    this.t0 = this.openedAt;
    this.lastCap = -1;
    this.loop();
  }

  close() {
    this.gen++;
    cancelAnimationFrame(this.raf);
    this.unbind();
    for (const it of this.items) {
      it.mesh.geometry.dispose(); it.mesh.material.dispose(); it.tex.dispose();
      it.shadow.geometry.dispose(); it.shadow.material.dispose();
      this.scene.remove(it.mesh, it.shadow);
    }
    this.items = [];
    this.renderer?.dispose();
    this.renderer?.domElement.remove();
    this.renderer = null;
    this.root.hidden = true;
    this.root.innerHTML = '';
    document.querySelector('[data-act="index"]')?.setAttribute('aria-pressed', 'false');
  }

  toggle() { if (this.isOpen) this.close(); else this.open(); }

  private build() {
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'high-performance' });
    renderer.setPixelRatio(Math.min(2, window.devicePixelRatio));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.setClearColor(0x000000, 0);
    this.root.prepend(renderer.domElement);
    this.renderer = renderer;
    const posters = buildPosters();
    const geo = () => new THREE.PlaneGeometry(W, H, 48, 64);
    posters.forEach((p, i) => {
      const cv = document.createElement('canvas');
      cv.width = PW; cv.height = PH;
      const ctx = cv.getContext('2d')!;
      p.draw(ctx);
      const tex = new THREE.CanvasTexture(cv);
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.anisotropy = renderer.capabilities.getMaxAnisotropy();
      const seed = Math.random();
      const mat = new THREE.ShaderMaterial({
        vertexShader: vert, fragmentShader: frag, transparent: true, side: THREE.DoubleSide,
        uniforms: { uMap: { value: tex }, uTime: { value: 0 }, uVel: { value: 0 }, uHover: { value: 0 }, uSeed: { value: seed }, uDrop: { value: 1 } },
      });
      const mesh = new THREE.Mesh(geo(), mat);
      const shadow = new THREE.Mesh(new THREE.PlaneGeometry(W * 1.25, H * 0.3), new THREE.ShaderMaterial({
        vertexShader: shadowVert, fragmentShader: shadowFrag, transparent: true, depthWrite: false,
        uniforms: { uDrop: { value: 1 } },
      }));
      shadow.rotation.x = -Math.PI / 2;
      this.scene.add(shadow, mesh);
      this.items.push({ poster: p, mesh, shadow, tex, hover: 0, seed, tilt: (Math.random() - 0.5) * 0.035 });
      void i;
    });
    this.offset = this.target = 0;
    this.resize();
  }

  private resize = () => {
    if (!this.renderer) return;
    const w = this.root.clientWidth, h = this.root.clientHeight;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    // Fit roughly three posters across on a wide screen, one on a phone.
    const across = w / h > 1.2 ? 2.95 : 1.2;
    const span = across * GAP;
    const dist = (span / 2) / Math.tan(((this.camera.fov * Math.PI) / 180) / 2) / this.camera.aspect;
    this.camera.position.set(0, 0.05, Math.max(dist, (H * 1.32) / 2 / Math.tan(((this.camera.fov * Math.PI) / 180) / 2)));
    this.camera.lookAt(0, 0.05, 0);
    this.camera.updateProjectionMatrix();
  };

  private onWheel = (e: WheelEvent) => {
    e.preventDefault();
    const d = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
    this.target += d * 0.0045;
    this.clamp();
  };
  private onDown = (e: PointerEvent) => {
    this.drag = { x: e.clientX, start: this.target, moved: false };
    (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
  };
  private onMove = (e: PointerEvent) => {
    const r = this.root.getBoundingClientRect();
    this.mouse.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    if (this.drag) {
      const dx = e.clientX - this.drag.x;
      if (Math.abs(dx) > 4) this.drag.moved = true;
      this.target = this.drag.start - dx * (GAP * 3.2) / r.width;
      this.clamp();
    }
  };
  private onUp = () => {
    if (this.drag && !this.drag.moved && this.hovered >= 0) {
      const it = this.items[this.hovered];
      const idx = this.hovered;
      // Clicking a side poster brings it to the centre; the centre one goes.
      if (Math.abs(idx * GAP - this.offset) > GAP * 0.5) this.target = idx * GAP;
      else this.onPick(it.poster);
    } else if (this.drag) {
      // settle on the nearest poster
      this.target = Math.round(this.target / GAP) * GAP;
      this.clamp();
    }
    this.drag = null;
  };
  private onKey = (e: KeyboardEvent) => {
    if (e.key === 'ArrowRight') this.target = (Math.round(this.target / GAP) + 1) * GAP;
    else if (e.key === 'ArrowLeft') this.target = (Math.round(this.target / GAP) - 1) * GAP;
    else if (e.key === 'Enter') { const i = Math.round(this.offset / GAP); if (this.items[i]) this.onPick(this.items[i].poster); }
    else return;
    this.clamp();
  };
  private settleTimer = 0;
  private clamp() {
    this.target = Math.max(0, Math.min((this.items.length - 1) * GAP, this.target));
    clearTimeout(this.settleTimer);
    this.settleTimer = window.setTimeout(() => {
      if (!this.drag) this.target = Math.round(this.target / GAP) * GAP;
    }, 180);
  }

  private bind() {
    const c = this.renderer!.domElement;
    c.addEventListener('wheel', this.onWheel, { passive: false });
    c.addEventListener('pointerdown', this.onDown);
    window.addEventListener('pointermove', this.onMove);
    window.addEventListener('pointerup', this.onUp);
    window.addEventListener('resize', this.resize);
    window.addEventListener('keydown', this.onKey);
  }
  private unbind() {
    window.removeEventListener('pointermove', this.onMove);
    window.removeEventListener('pointerup', this.onUp);
    window.removeEventListener('resize', this.resize);
    window.removeEventListener('keydown', this.onKey);
  }

  private loop = () => {
    if (!this.renderer) return;
    this.raf = requestAnimationFrame(this.loop);
    const now = performance.now();
    // Reduced motion: posters hang still, no ripple, no drop-in.
    const still = REDUCED_MOTION.matches;
    const t = still ? 0 : (now - this.t0) / 1000;
    const prev = this.offset;
    this.offset += (this.target - this.offset) * 0.085;
    const v = still ? 0 : (this.offset - prev) * 6;
    this.vel += (v - this.vel) * 0.15;
    // Hover
    this.ray.setFromCamera(this.mouse, this.camera);
    const hits = this.ray.intersectObjects(this.items.map((i) => i.mesh));
    this.hovered = hits.length ? this.items.findIndex((i) => i.mesh === hits[0].object) : -1;
    this.renderer!.domElement.style.cursor = this.drag ? 'grabbing' : this.hovered >= 0 ? 'pointer' : 'grab';
    const since = (now - this.openedAt) / 1000;
    this.items.forEach((it, i) => {
      const x = i * GAP - this.offset;
      // Gentle arc: posters away from centre turn in and step back.
      it.mesh.position.set(x, 0, -Math.abs(x) * 0.12);
      it.mesh.rotation.set(0, -x * 0.05, it.tilt);
      it.hover += ((this.hovered === i ? 1 : 0) - it.hover) * 0.1;
      const drop = still ? 0 : Math.max(0, Math.min(1, 1 - (since - i * 0.07 - 0.05) / 0.9));
      const eased = drop * drop * (3 - 2 * drop);
      const u = it.mesh.material.uniforms;
      u.uTime.value = t;
      u.uVel.value = this.vel;
      u.uHover.value = it.hover;
      u.uDrop.value = eased;
      it.shadow.position.set(x, -H / 2 - 0.32, -Math.abs(x) * 0.12 + 0.1);
      it.shadow.material.uniforms.uDrop.value = eased;
    });
    const centre = Math.round(this.offset / GAP);
    if (centre !== this.lastCap && this.items[centre] && this.cap) {
      this.lastCap = centre;
      this.cap.t.textContent = this.items[centre].poster.title;
      this.cap.s.textContent = this.items[centre].poster.subtitle;
    }
    this.renderer!.render(this.scene, this.camera);
  };
}
