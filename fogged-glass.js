// <fogged-glass> : a fogged window you wipe with your finger (WebGL2, zero deps).
//
// What makes it read as real glass, not a blur filter:
//   1. Fog = the scene heavily blurred, lifted toward a tint and muted, with micro beads.
//   2. The finger pushes water aside: a ridge of bigger beads lines every stroke.
//   3. That water gathers on the lower lip of the stroke, swells, and runs down as drops
//      that refract the scene upside down and cut a clear trail through the fog.
//   4. The glass fogs back up, unevenly, after a while.
//
//   <fogged-glass data-src="/scene.mp4" data-poster="/scene.jpg"
//                 data-refog="14" data-brush="24" data-drops="1"
//                 data-focus="0.66,0.75" data-target="0.6,0.69,0.13,0.16"></fogged-glass>
//
// data-focus: which point of the media stays in view when cropped (object-position).
// data-zoom (>= 1): crop tighter than object-fit: cover.
// data-target: the thing to find, as a rect in MEDIA coords (x, y, w, h, 0..1, y down),
//              so it follows the crop on any screen shape.
//
// data-goal="write": write a word, any word, freehand. Once the finger lifts and pauses,
// the strokes are checked (looksLikeWriting): a word unlocks, a swipe or a scrub does not.
//
// Events: "fogprogress" {cleared, target}, "fogwrite" {ok} after each pause in "write" mode,
// "fogreveal" (goal reached once).
// Methods: clearAll(seconds), fogUp(), setGravity(x, y).
//
// Standards: DPR capped, rAF paused off-viewport and on hidden tabs, prefers-reduced-motion
// => no intro, no running drops, no refog; clean teardown; poster stays visible without WebGL2.

const NOISE = `
float hash12(vec2 p){ vec3 p3 = fract(vec3(p.xyx) * .1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
vec2 hash22(vec2 p){ vec3 p3 = fract(vec3(p.xyx) * vec3(.1031, .1030, .0973)); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.xx + p3.yz) * p3.zy); }
float vnoise(vec2 p){
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash12(i), hash12(i + vec2(1, 0)), u.x),
             mix(hash12(i + vec2(0, 1)), hash12(i + vec2(1, 1)), u.x), u.y);
}
float fbm(vec2 p){ float a = 0.5, s = 0.0; for (int i = 0; i < 4; i++){ s += a * vnoise(p); p *= 2.03; a *= 0.5; } return s / 0.9375; }
float segDist(vec2 p, vec2 a, vec2 b){
  vec2 pa = p - a, ba = b - a;
  float h = clamp(dot(pa, ba) / max(dot(ba, ba), 1e-8), 0.0, 1.0);
  return length(pa - ba * h);
}`;

const VERT = `#version 300 es
in vec2 aPos;
out vec2 vUv;
void main(){ vUv = aPos * 0.5 + 0.5; gl_Position = vec4(aPos, 0.0, 1.0); }`;

const MAX_SEGS = 16;
const MAX_TRAILS = 48;
const MAX_DROPS = 160;

// Mask pass. r = clear (1 = wiped), g = ridge water pushed by the finger, b = drop trail,
// a = intro clear (the pane starts clear and fogs up from the frame inward).
const MASK = `#version 300 es
precision highp float;
in vec2 vUv;
uniform sampler2D uMask;
uniform vec2  uAspect;              // (w/h, 1): distances in "height units"
uniform float uDt;
uniform float uRefog;               // clear lost per second
uniform float uIntro;               // 0..1 progress of the first fog-up
uniform float uEvap;                // 0..1.3, reveal: the fog evaporates in patches
uniform float uSeed;
uniform float uQuant;               // 1/255 when the mask is stored in 8 bits, else 0
uniform float uTick;                // changes every frame: fresh noise for the rounding
uniform int   uSegCount;
uniform vec4  uSeg[${MAX_SEGS}];    // finger segments this frame, uv (y up)
uniform float uSegR[${MAX_SEGS}];
uniform int   uTrailCount;
uniform vec4  uTrail[${MAX_TRAILS}];   // drops: prev.xy, cur.xy
uniform float uTrailR[${MAX_TRAILS}];
out vec4 frag;
${NOISE}
void main(){
  vec4 m = texture(uMask, vUv);
  float C = m.r, G = m.g, T = m.b, A = m.a;
  vec2 p = vUv * uAspect;

  // in 8 bits a slow refog step rounds to zero every frame: round it at random instead,
  // so it stays right on average
  float rnd = hash12(gl_FragCoord.xy + uTick);
  #define STEP(x) (uQuant > 0.0 ? floor((x) / uQuant + rnd) * uQuant : (x))

  // refog: patchy, never uniform
  float n = fbm(p * 2.2 + uSeed);
  C = max(0.0, C - STEP(uDt * uRefog * mix(0.6, 1.5, n)));

  // first fog-up: a ragged front creeping in from the frame
  float border = min(min(vUv.x, 1.0 - vUv.x) * uAspect.x, min(vUv.y, 1.0 - vUv.y));
  float front = uIntro * 1.7 - (0.45 * n + 0.85 * clamp(border / 0.5, 0.0, 1.0));
  A = min(A, 1.0 - smoothstep(0.0, 0.25, front));
  G = max(0.0, G - STEP(uDt * uRefog * 0.3));   // big beads outlive the haze
  T = max(0.0, T - STEP(uDt * uRefog * 0.45));

  // the finger: a clean core, water pushed into a ridge along the edge
  for (int i = 0; i < ${MAX_SEGS}; i++){
    if (i >= uSegCount) break;
    vec4 s = uSeg[i];
    float wob = 1.0 + 0.14 * (vnoise(p * 34.0 + uSeed) - 0.5) + 0.06 * (vnoise(p * 140.0) - 0.5);
    float d = segDist(p, s.xy * uAspect, s.zw * uAspect) / (uSegR[i] * wob);
    float core = 1.0 - smoothstep(0.6, 1.0, d);
    float ring = smoothstep(0.72, 0.98, d) * (1.0 - smoothstep(1.0, 1.35, d));
    C = max(C, core);
    G = max(G * (1.0 - core), ring);
    T *= 1.0 - core;
  }

  // drops eat the fog on their way down
  for (int i = 0; i < ${MAX_TRAILS}; i++){
    if (i >= uTrailCount) break;
    vec4 t = uTrail[i];
    float d = segDist(p, t.xy * uAspect, t.zw * uAspect) / uTrailR[i];
    float core = 1.0 - smoothstep(0.7, 1.0, d);
    C = max(C, core * 0.96);
    T = max(T, core);
  }

  // reveal: evaporates thin patches first
  C = max(C, smoothstep(n * 0.9, n * 0.9 + 0.25, uEvap));
  frag = vec4(C, G, T, A);
}`;

// Scene -> low-res copy with object-fit: cover, prefiltered through the mip chain.
const COPY = `#version 300 es
precision highp float;
in vec2 vUv;
uniform sampler2D uScene;
uniform vec2  uCover;
uniform vec2  uCenter;
uniform float uLod;
uniform float uGlow;    // warm lights bloom through the fog (heavy chain only)
out vec4 frag;
float luma3(vec3 c){ return dot(c, vec3(0.299, 0.587, 0.114)); }
void main(){
  vec2 uv = uCenter + (vUv - 0.5) * uCover;
  vec3 c = textureLod(uScene, uv, uLod).rgb;
  vec3 hi = textureLod(uScene, uv, max(0.0, uLod - 2.0)).rgb;   // small lights survive here
  float warm = smoothstep(0.08, 0.35, hi.r - hi.b) * smoothstep(0.35, 0.8, hi.r);
  frag = vec4(c, luma3(hi) * warm * uGlow);   // alpha carries the glow (HDR when available)
}`;

// Separable gaussian, 9 taps in 5 bilinear fetches.
const BLUR = `#version 300 es
precision highp float;
in vec2 vUv;
uniform sampler2D uSrc;
uniform vec2 uDir;
out vec4 frag;
void main(){
  vec4 c = texture(uSrc, vUv) * 0.2270270270;
  c += texture(uSrc, vUv + uDir * 1.3846153846) * 0.3162162162;
  c += texture(uSrc, vUv - uDir * 1.3846153846) * 0.3162162162;
  c += texture(uSrc, vUv + uDir * 3.2307692308) * 0.0702702703;
  c += texture(uSrc, vUv - uDir * 3.2307692308) * 0.0702702703;
  frag = c;
}`;

// Mask resample when the element resizes (keeps the wiped strokes).
const BLIT = `#version 300 es
precision highp float;
in vec2 vUv;
uniform sampler2D uSrc;
out vec4 frag;
void main(){ frag = texture(uSrc, vUv); }`;

// Drops: one quad each. Output rg = normal (y up), b = radius / 16 px, a = coverage.
const DROP_VS = `#version 300 es
layout(location = 0) in vec2 aPos;
layout(location = 1) in vec2 aLocal;
layout(location = 2) in vec3 aParam;
out vec2 vLocal;
out vec3 vParam;
void main(){ vLocal = aLocal; vParam = aParam; gl_Position = vec4(aPos, 0.0, 1.0); }`;

const DROP_FS = `#version 300 es
precision highp float;
in vec2 vLocal;
in vec3 vParam;   // x = elongation (running), y = alpha, z = radius / 16
out vec4 frag;
void main(){
  vec2 s = vLocal;
  float e = vParam.x;
  if (s.y > 0.0){
    s.y /= 1.0 + e * 1.6;                      // a running drop drags a tail upward
    s.x *= 1.0 + 0.7 * e * clamp(s.y, 0.0, 1.0);
  } else {
    s.y *= 1.0 + e * 0.12;                     // and its belly sags a little
  }
  float d = length(s);
  float a = 1.0 - smoothstep(0.86, 1.0, d);
  if (a <= 0.0) discard;
  frag = vec4(s * 0.5 + 0.5, vParam.z, a * vParam.y);
}`;

const COMPOSITE = `#version 300 es
precision highp float;
in vec2 vUv;
uniform sampler2D uScene;
uniform sampler2D uBlurM;
uniform sampler2D uBlurH;
uniform sampler2D uMask;
uniform sampler2D uDrops;
uniform sampler2D uGhost;
uniform vec2  uCover;
uniform vec2  uCenter;       // focus point of the cover crop (texture uv)
uniform vec2  uCss;          // element size in css px
uniform float uTime;
uniform float uSeed;
uniform vec3  uTint;
uniform float uThick;
uniform float uGhostAmt;
uniform float uLens;
uniform vec3  uGlowTint;
out vec4 frag;
${NOISE}

vec2 cover(vec2 uv){ return uCenter + (uv - 0.5) * uCover; }
float luma(vec3 c){ return dot(c, vec3(0.299, 0.587, 0.114)); }

// Voronoi beads: xy = offset from the bead centre in radii (y down), z = coverage, w = radius px.
vec4 beads(vec2 px, float cell, float fill, float seed, float sparsity){
  vec2 g = px / cell;
  vec2 i = floor(g), f = fract(g);
  vec4 best = vec4(0.0);
  for (int y = -1; y <= 1; y++)
  for (int x = -1; x <= 1; x++){
    vec2 o = vec2(float(x), float(y));
    vec2 id = i + o;
    if (hash12(id + seed * 3.7) < sparsity) continue;
    vec2 c = o + 0.2 + 0.6 * hash22(id + seed);
    float rr = (0.14 + 0.36 * hash12(id + seed + 7.13)) * fill;
    if (rr < 0.03) continue;
    vec2 dv = (f - c) / rr;
    float cov = 1.0 - smoothstep(0.7, 1.0, length(dv));
    if (cov > best.z) best = vec4(dv, cov, rr * cell);
  }
  return best;
}

// A drop of water on glass is a tiny ball lens: the scene shows upside down,
// the rim goes dark (total internal reflection), a highlight sits on top.
vec3 water(vec2 uv, vec2 n, float radPx){
  float l = clamp(length(n), 0.0, 1.0);
  vec2 off = -n * radPx * uLens / uCss;
  vec3 c = texture(uScene, cover(uv + off)).rgb;
  c = mix(c, c * c * 1.6, 0.25);
  c = mix(c, texture(uBlurM, uv).rgb * 1.15, 0.28);   // a bead also gathers the light around it
  c *= 1.0 - smoothstep(0.5, 1.0, l) * 0.45;
  float spec = smoothstep(0.36, 0.0, length(n - vec2(-0.3, 0.4)));
  c += spec * 0.55;
  c += smoothstep(0.55, 0.0, length(n - vec2(0.1, -0.52))) * 0.1;
  return c;
}

// The beads a finger leaves are flatter and smaller than a drop: a softer lens,
// mostly the blurred light around them, a faint highlight. Diffuse, not glassy.
vec3 bead(vec2 uv, vec2 n, float radPx){
  float l = clamp(length(n), 0.0, 1.0);
  vec2 off = -n * radPx * uLens * 0.45 / uCss;
  vec3 c = mix(texture(uScene, cover(uv + off)).rgb, texture(uBlurM, uv).rgb * 1.08, 0.5);
  c *= 1.0 - smoothstep(0.55, 1.0, l) * 0.22;
  c += smoothstep(0.55, 0.0, length(n - vec2(-0.3, 0.4))) * 0.16;
  return c;
}
float soft(vec4 b){ return 1.0 - smoothstep(0.2, 1.0, length(b.xy)); }

void main(){
  vec2 uv = vUv;
  vec2 px = vec2(uv.x, 1.0 - uv.y) * uCss;
  float aspect = uCss.x / uCss.y;
  vec4 m = texture(uMask, uv);
  float C = max(m.r, m.a), G = m.g, T = m.b;

  vec3 sharp = texture(uScene, cover(uv)).rgb;
  vec3 bm = texture(uBlurM, uv).rgb;
  vec4 bhg = texture(uBlurH, uv);
  vec3 bh = bhg.rgb;
  vec3 glow = uGlowTint * bhg.a;          // a lit window, smeared by the fog

  // fog body: light scattered by millions of droplets. Muted, lifted, bright sources bloom.
  vec3 fog = mix(bh, vec3(luma(bh)), 0.35);
  fog = 1.0 - (1.0 - fog) * (1.0 - uTint * 0.3);
  fog += glow;
  vec3 haze = mix(bm, vec3(luma(bm)), 0.12);
  haze = 1.0 - (1.0 - haze) * (1.0 - uTint * 0.1);

  // density: patchy, heavier low on the glass, thinner along old finger traces
  float n1 = fbm(uv * vec2(aspect, 1.0) * 2.2 + uSeed);
  float low = smoothstep(0.6, 0.0, uv.y);
  float ghost = texture(uGhost, uv).r * uGhostAmt;
  float fogMax = uThick * (0.84 + 0.12 * n1 + 0.07 * low) * (1.0 - 0.55 * ghost);
  float residue = 0.025 + 0.05 * vnoise(px * 0.012 + uSeed);   // a wiped pane is never spotless
  // the first stretch of refog stays invisible: a wiped patch keeps clear for a few seconds
  float dens = smoothstep(0.22, 1.0, 1.0 - C);
  float D = mix(residue, 1.0, dens) * fogMax;

  vec3 col = mix(sharp, haze, smoothstep(0.0, 0.4, D));
  col = mix(col, fog, smoothstep(0.3, 1.0, D));
  col += glow * 0.35 * smoothstep(0.05, 0.4, D) * (1.0 - smoothstep(0.3, 1.0, D));

  // micro beads: the grain of condensation
  if (D > 0.08){
    vec4 b = beads(px, 4.0, smoothstep(0.1, 0.9, D), 1.0, 0.0);
    if (b.z > 0.0){
      vec2 n = vec2(b.x, -b.y);
      vec3 bc = texture(uBlurM, uv - n * b.w * 2.0 / uCss).rgb;
      bc = 1.0 - (1.0 - bc) * (1.0 - uTint * 0.2);
      bc += smoothstep(0.45, 0.0, length(n - vec2(-0.3, 0.35))) * 0.12;
      col = mix(col, bc, b.z * 0.25 * D);
    }
  }

  // ridge: the water the finger pushed aside gathers into beads along the stroke,
  // a few big ones on the crest, a crowd of small ones around them
  if (G > 0.02){
    vec4 b = beads(px, 11.0, smoothstep(0.35, 1.0, G) * 0.85, 11.0, 0.8);
    if (b.z > 0.0) col = mix(col, bead(uv, vec2(b.x, -b.y), b.w), soft(b) * 0.7);
    else {
      vec4 s2 = beads(px, 5.5, smoothstep(0.1, 0.9, G) * 0.75, 17.0, 0.62);
      if (s2.z > 0.0) col = mix(col, bead(uv, vec2(s2.x, -s2.y), s2.w), soft(s2) * 0.5);
    }
  }

  // what a drop leaves behind: now and then a tiny bead in its trail
  if (T > 0.02){
    vec4 b = beads(px, 8.0, T * 0.6, 23.0, 0.86);
    if (b.z > 0.0) col = mix(col, bead(uv, vec2(b.x, -b.y), b.w), soft(b) * 0.5);
  }

  // running and resting drops
  vec4 dr = texture(uDrops, uv);
  if (dr.a > 0.004){
    vec2 n = dr.rg * 2.0 - 1.0;
    col = mix(col, water(uv, n, dr.b * 16.0), smoothstep(0.0, 0.85, dr.a));
  }

  float vig = smoothstep(1.3, 0.3, length((uv - 0.5) * vec2(aspect, 1.0)));
  col *= mix(0.84, 1.0, vig);
  col += (hash12(px + fract(uTime) * 91.0) - 0.5) * 0.018;   // grain + dither (no banding)
  frag = vec4(col, 1.0);
}`;

// ---------------------------------------------------------------------------------------
// Drop simulation: pure JS, no DOM, no GL. Units are css px, y down.
// Kept separate on purpose so a React Native (Skia) host can reuse it as is.
// ---------------------------------------------------------------------------------------

function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function segPointDist(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const l2 = dx * dx + dy * dy;
  const h = l2 > 1e-6 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / l2)) : 0;
  return Math.hypot(px - ax - dx * h, py - ay - dy * h);
}

export class DropSim {
  constructor(w, h, seed = 7) {
    this.rand = mulberry32(seed);
    this.drops = [];
    this.trails = [];          // [{x0,y0,x1,y1,r}] this step, for the mask pass
    this.path = null;          // the stroke being drawn: [{x, y, s, w}] (s = arc length, w = water)
    this.amount = 1;
    this.ambient = 0;          // drops per minute that form on their own (0 = only from strokes)
    this.gravity = [0, 1];
    this.ambientT = 0;
    this.resize(w, h);
  }

  resize(w, h) {
    if (this.w) {
      const sx = w / this.w, sy = h / this.h;
      for (const d of this.drops) { d.x *= sx; d.y *= sy; }
    }
    this.w = w; this.h = h;
    // coarse "how much is wiped" grid, for progress and the reveal goal
    this.gw = 48;
    this.gh = Math.max(1, Math.round(48 * h / w));
    this.grid = new Float32Array(this.gw * this.gh);
  }

  fillGrid(v) { this.grid.fill(v); }

  _spawn(x, y, r, run) {
    if (this.drops.length >= MAX_DROPS) {
      // forget the smallest resting bead first
      let k = -1, best = Infinity;
      for (let i = 0; i < this.drops.length; i++) {
        const d = this.drops[i];
        if (!d.run && d.r < best) { best = d.r; k = i; }
      }
      if (k < 0) return null;
      this.drops.splice(k, 1);
    }
    const d = {
      x, y, px: x, py: y, r, run, vy: 0, vx: 0, go: 1, slip: 0,
      wait: 0.15 + this.rand() * 0.9, life: 1, travel: 0, a: 0,
    };
    this.drops.push(d);
    return d;
  }

  wipe(x0, y0, x1, y1, r) {
    // the finger takes the drops it touches
    for (let i = this.drops.length - 1; i >= 0; i--) {
      const d = this.drops[i];
      if (segPointDist(d.x, d.y, x0, y0, x1, y1) < r * 0.92) this.drops.splice(i, 1);
    }
    // grid
    const cw = this.w / this.gw, ch = this.h / this.gh;
    const minX = Math.max(0, Math.floor((Math.min(x0, x1) - r) / cw));
    const maxX = Math.min(this.gw - 1, Math.floor((Math.max(x0, x1) + r) / cw));
    const minY = Math.max(0, Math.floor((Math.min(y0, y1) - r) / ch));
    const maxY = Math.min(this.gh - 1, Math.floor((Math.max(y0, y1) + r) / ch));
    for (let gy = minY; gy <= maxY; gy++) {
      for (let gx = minX; gx <= maxX; gx++) {
        const d = segPointDist((gx + 0.5) * cw, (gy + 0.5) * ch, x0, y0, x1, y1);
        const v = Math.max(0, Math.min(1, (r - d) / cw + 0.5));
        const k = gy * this.gw + gx;
        if (v > this.grid[k]) this.grid[k] = v;
      }
    }
    // the finger pushes water along; it will gather at the low points of the stroke
    if (this.amount <= 0) return;
    this.brush = r;
    if (!this.path) this.path = [{ x: x0, y: y0, s: 0, w: 0 }];
    const last = this.path[this.path.length - 1];
    const len = Math.hypot(x1 - x0, y1 - y0);
    this.path.push({ x: x1, y: y1, s: last.s + len, w: len * 0.014 * this.amount });
    // a long gesture that never lifts still drips, from the part already drawn
    if (last.s + len - this.path[0].s > 900) this._gather(false);
  }

  /** The finger lifted: the stroke's water settles into drops at its low points. */
  endStroke() {
    if (this.path) this._gather(true);
    this.path = null;
  }

  // Water runs down the lower lip to the lowest points of the stroke (the foot of a
  // vertical line, the belly of a curve). Each low point collects the water of its
  // stretch of stroke: a lot of it makes a drop that runs, a little makes a bead.
  _gather(final) {
    const P = this.path, r = this.brush || 24;
    if (!P || P.length < 2) return;
    const W = Math.max(28, r * 1.4);
    const tailS = P[P.length - 1].s - W * 3;
    let end = P.length;
    if (!final) { while (end > 1 && P[end - 1].s > tailS) end--; if (end < 2) return; }

    // low points: nothing lower within W of arc length on either side
    const lows = [];
    for (let i = 0; i < end; i++) {
      let low = true;
      for (let j = i - 1; j >= 0 && P[i].s - P[j].s <= W; j--) if (P[j].y > P[i].y + 0.5) { low = false; break; }
      for (let j = i + 1; low && j < P.length && P[j].s - P[i].s <= W; j++) if (P[j].y > P[i].y + 0.5) low = false;
      if (low) lows.push({ i, x: P[i].x, y: P[i].y, s: P[i].s, water: 0 });
    }
    // flat stretches give a row of candidates: keep the deepest, spaced apart
    lows.sort((a, b) => b.y - a.y);
    const keep = [];
    for (const l of lows) if (keep.every((k) => Math.hypot(k.x - l.x, k.y - l.y) > Math.max(46, r * 2))) keep.push(l);
    if (!keep.length) return;
    // catchment: each bit of stroke feeds the nearest low point along the stroke
    for (let i = 0; i < end; i++) {
      let best = null, bd = Infinity;
      for (const k of keep) { const d = Math.abs(P[i].s - k.s); if (d < bd) { bd = d; best = k; } }
      if (best) best.water += P[i].w;
    }
    for (const k of keep) {
      if (k.water < 0.3) continue;
      const rd = Math.min(8, 1.4 + 1.5 * Math.sqrt(k.water * (0.75 + this.rand() * 0.5)));
      const cx = k.x + (this.rand() - 0.5) * r * 0.5, cy = k.y + r * (0.88 + this.rand() * 0.1);
      let host = null;
      for (const d of this.drops) if (!d.run && Math.hypot(d.x - cx, d.y - cy) < r * 0.6) { host = d; break; }
      if (host) { host.r = Math.min(9, Math.hypot(host.r, rd)); host.wait = Math.min(host.wait, 0.4); }
      else this._spawn(cx, cy, rd, false);
    }
    this.path = final ? null : P.slice(end - 1);
  }

  step(dt, refogRate) {
    const R = this.rand;
    const [gx, gy] = this.gravity;
    this.trails.length = 0;

    if (this.ambient > 0 && this.amount > 0) {
      this.ambientT -= dt;
      if (this.ambientT <= 0) {
        this.ambientT = (60 / this.ambient) * (0.5 + R());
        const d = this._spawn(this.w * (0.04 + R() * 0.92), this.h * R() * 0.45, 5 + R() * 3, true);
        if (d) d.wait = 0;
      }
    }

    for (let i = this.drops.length - 1; i >= 0; i--) {
      const d = this.drops[i];
      d.px = d.x; d.py = d.y;
      d.a = Math.min(1, d.a + dt * 6);              // fade in
      if (!d.run) {
        // a resting bead: big enough, it lets go after a beat
        if (d.r >= 4.2) { d.wait -= dt; if (d.wait <= 0) d.run = true; }
        d.life -= dt * refogRate * 0.35;
        if (d.life <= 0) { d.r -= dt * (this.ambient === 0 && refogRate === 0 ? 3 : 0.8); if (d.r < 0.6) { this.drops.splice(i, 1); continue; } }
        continue;
      }
      // stick and slip: drops on glass move in bursts, not at constant speed
      d.slip -= dt;
      if (d.slip <= 0) {
        d.slip = 0.12 + R() * 0.8;
        d.go = R() < 0.25 ? 0.03 : 0.6 + R() * 0.6;
        d.vx = (R() - 0.5) * 110;                    // each restart picks a new heading
      }
      const target = Math.min(230, Math.max(0, (d.r - 2.2) * 40)) * d.go;
      d.vy += (target - d.vy) * Math.min(1, dt * 5);
      d.vx += (R() - 0.5) * 140 * dt;
      d.vx *= 1 - Math.min(1, dt * 2.5);
      const lat = Math.max(-48, Math.min(48, d.vx)) * Math.min(1, d.vy / 90);
      // move along gravity, meander across it
      d.x += (gx * d.vy - gy * lat) * dt;
      d.y += (gy * d.vy + gx * lat) * dt;
      const moved = Math.hypot(d.x - d.px, d.y - d.py);
      d.travel += moved;
      d.r -= moved * 0.0032;                         // it leaves water behind
      if (d.travel > 50 + R() * 90 && d.r > 2.4) {
        d.travel = 0;
        if (R() < 0.3) this._spawn(d.px + (R() - 0.5) * d.r * 0.6, d.py - d.r * 0.8, 0.9 + R() * 0.7, false);
      }
      if (d.r < 2.2) { d.run = false; d.vy = 0; d.wait = 1e9; }
      if (d.y - d.r > this.h || d.x < -20 || d.x > this.w + 20 || d.y < -40) {
        this.drops.splice(i, 1); continue;
      }
    }

    // merge: a running drop swallows what it meets, and speeds up
    for (const d of this.drops) {
      if (!d.run) continue;
      for (let j = this.drops.length - 1; j >= 0; j--) {
        const o = this.drops[j];
        if (o === d) continue;
        if (Math.hypot(o.x - d.x, o.y - d.y) < (o.r + d.r) * 0.85) {
          d.r = Math.min(9, Math.hypot(d.r, o.r));
          this.drops.splice(j, 1);
        }
      }
    }

    // trails for the mask pass: running drops first, then big resting beads (their halo)
    for (const d of this.drops) {
      if (this.trails.length >= MAX_TRAILS) break;
      if (d.run) this.trails.push({ x0: d.px, y0: d.py, x1: d.x, y1: d.y, r: d.r * 1.15 });
    }
    for (const d of this.drops) {
      if (this.trails.length >= MAX_TRAILS) break;
      if (!d.run && d.r > 2.6) this.trails.push({ x0: d.x, y0: d.y, x1: d.x, y1: d.y, r: d.r * 1.25 });
    }

    // grid refog, at the shader's average pace
    const k = dt * refogRate;
    if (k > 0) for (let i = 0; i < this.grid.length; i++) this.grid[i] = Math.max(0, this.grid[i] - k);
  }

  // fraction wiped, overall and inside a normalised rect [x, y, w, h] (y down)
  progress(rect) {
    let all = 0, tin = 0, tn = 0;
    for (let gy = 0; gy < this.gh; gy++) {
      for (let gx = 0; gx < this.gw; gx++) {
        const v = this.grid[gy * this.gw + gx];
        all += v;
        if (rect) {
          const u = (gx + 0.5) / this.gw, w = (gy + 0.5) / this.gh;
          if (u >= rect[0] && u <= rect[0] + rect[2] && w >= rect[1] && w <= rect[1] + rect[3]) { tin += v; tn++; }
        }
      }
    }
    return { cleared: all / this.grid.length, target: tn ? tin / tn : 0 };
  }
}

/**
 * Does a set of finger strokes look like a handwritten word? Pure, no DOM: strokes are flat
 * [x0, y0, x1, y1, ...] arrays in css px. Not recognition, a shape test: a word is wider than
 * a dot, inks a lot more than its own size, and keeps turning; a swipe is straight, a circle
 * turns once, a scrub over the whole pane is too big.
 */
export function looksLikeWriting(strokes, W, H) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity, ink = 0, turn = 0;
  for (const p of strokes) {
    let ax = p[0], ay = p[1], prev = null;
    for (let i = 0; i < p.length; i += 2) {
      const x = p[i], y = p[i + 1];
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
      const d = Math.hypot(x - ax, y - ay);
      if (d < 5) continue;
      ink += d;
      const a = Math.atan2(y - ay, x - ax);
      if (prev !== null) {
        let da = a - prev;
        while (da > Math.PI) da -= 2 * Math.PI;
        while (da < -Math.PI) da += 2 * Math.PI;
        turn += Math.abs(da);
      }
      prev = a; ax = x; ay = y;
    }
  }
  const w = maxX - minX, h = maxY - minY;
  // several strokes is how people write; a single one must turn more than a circle does
  const minTurn = strokes.length >= 2 ? 1.8 : 2.6;
  const reason =
    w * h > 0.5 * W * H ? "big" :
    Math.max(w, h) < 40 ? "small" :
    Math.min(w, h) < 18 || w / h < 0.35 || w / h > 9 || ink < 2 * Math.max(w, h) ||
      turn < minTurn * Math.PI ? "simple" : "";
  return { ok: !reason, reason, w, h, ink, turn: turn / Math.PI, strokes: strokes.length };
}

// ---------------------------------------------------------------------------------------
// GL helpers
// ---------------------------------------------------------------------------------------

function compile(gl, type, src) {
  const s = gl.createShader(type);
  gl.shaderSource(s, src);
  gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
    throw new Error(gl.getShaderInfoLog(s) || "shader compile failed");
  }
  return s;
}

function program(gl, vs, fs) {
  const p = gl.createProgram();
  gl.attachShader(p, compile(gl, gl.VERTEX_SHADER, vs));
  gl.attachShader(p, compile(gl, gl.FRAGMENT_SHADER, fs));
  gl.bindAttribLocation(p, 0, "aPos");
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
    throw new Error(gl.getProgramInfoLog(p) || "program link failed");
  }
  const u = {};
  const n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
  for (let i = 0; i < n; i++) {
    const info = gl.getActiveUniform(p, i);
    u[info.name.replace(/\[0\]$/, "")] = gl.getUniformLocation(p, info.name);
  }
  return { p, u };
}

function target(gl, w, h, half) {
  const tex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, tex);
  if (half) gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, w, h, 0, gl.RGBA, gl.HALF_FLOAT, null);
  else gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  const fb = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
  return { tex, fb, w, h };
}

function freeTarget(gl, t) {
  if (!t) return;
  gl.deleteTexture(t.tex);
  gl.deleteFramebuffer(t.fb);
}

function hexToRgb(hex, fallback) {
  const m = /^#?([0-9a-f]{6})$/i.exec((hex || "").trim());
  if (!m) return fallback;
  const v = parseInt(m[1], 16);
  return [(v >> 16 & 255) / 255, (v >> 8 & 255) / 255, (v & 255) / 255];
}

// ---------------------------------------------------------------------------------------
// The element
// ---------------------------------------------------------------------------------------

class FoggedGlass extends HTMLElement {
  static get observedAttributes() { return ["data-src", "data-poster", "data-ghost"]; }

  attributeChangedCallback(name, oldV, newV) {
    if (!this._init || oldV === newV) return;
    if (name === "data-ghost") { if (this._gl && this._css) this._buildGhost(); return; }
    // swap the media in place: the old frame keeps rendering until the new one is ready
    clearTimeout(this._swapT);
    this._swapT = setTimeout(() => this._loadMedia(), 0);
  }

  connectedCallback() {
    if (this._init) return;
    this._init = true;
    const root = this.attachShadow({ mode: "open" });
    root.innerHTML = `<style>
      :host{ position:relative; display:block; overflow:hidden; background:#0b1222;
             touch-action:none; user-select:none; -webkit-user-select:none; -webkit-touch-callout:none; }
      img,canvas{ position:absolute; inset:0; width:100%; height:100%; object-fit:cover; display:block; }
      img{ filter: blur(18px) brightness(1.15) saturate(.7); transform: scale(1.08); transition:opacity .5s ease; }
      canvas{ opacity:0; transition:opacity .5s ease; }
      :host([data-ready]) canvas{ opacity:1; }
      :host([data-ready]) img{ opacity:0; }
    </style>
    <img alt="" aria-hidden="true">
    <canvas aria-hidden="true"></canvas>`;
    this._img = root.querySelector("img");
    this._canvas = root.querySelector("canvas");
    this._num = (k, d) => { const v = parseFloat(this.dataset[k]); return Number.isFinite(v) ? v : d; };

    this._reduce = matchMedia("(prefers-reduced-motion: reduce)");
    this._loadMedia();
  }

  _isVideo(src) { return /\.(mp4|webm|mov|m4v)(\?|#|$)/i.test(src || ""); }

  _loadMedia() {
    const src = this.dataset.src;
    const poster = this.dataset.poster;
    const token = (this._mediaToken = (this._mediaToken || 0) + 1);
    const live = () => token === this._mediaToken;
    this._dropVideo();
    const still = poster || (!this._isVideo(src) ? src : "");
    if (still) this._img.src = still;
    const onImage = (im) => {
      if (!live()) return;
      if (!this._videoReady) { this._source = im; this._sceneDirty = true; }
      this._tryStart();
    };
    if (still) {
      const im = new Image();
      im.crossOrigin = "anonymous";
      im.decoding = "async";
      im.onload = () => onImage(im);
      im.src = still;
    }
    if (this._isVideo(src) && !this._reduce.matches) {
      const v = document.createElement("video");
      v.muted = true; v.loop = true; v.playsInline = true; v.autoplay = true;
      v.setAttribute("playsinline", ""); v.setAttribute("muted", "");
      v.crossOrigin = "anonymous"; v.preload = "auto";
      v.addEventListener("loadeddata", () => {
        if (!live()) return;
        this._videoReady = true;
        this._source = v;
        this._sceneDirty = true;
        this._tryStart();
      });
      v.src = src;
      v.play().catch(() => { /* autoplay refused: the poster still renders */ });
      this._video = v;
      const tick = () => { this._sceneDirty = true; this._vfc = v.requestVideoFrameCallback(tick); };
      if ("requestVideoFrameCallback" in v) this._vfc = v.requestVideoFrameCallback(tick);
    }
  }

  _dropVideo() {
    const v = this._video;
    if (!v) return;
    if (this._vfc && v.cancelVideoFrameCallback) v.cancelVideoFrameCallback(this._vfc);
    this._vfc = null;
    v.pause(); v.removeAttribute("src"); v.load();
    this._video = null;
    this._videoReady = false;
  }

  _tryStart() {
    if (this._running || !this._source) return;
    if (!this._io) {
      this._io = new IntersectionObserver((es) => {
        for (const e of es) {
          this._visible = e.isIntersecting;
          if (this._visible) this._start(); else this._pause();
        }
      }, { threshold: 0.01 });
      this._io.observe(this);
      this._onVis = () => {
        if (document.hidden) this._pause();
        else if (this._visible) this._start();
      };
      document.addEventListener("visibilitychange", this._onVis);
    }
  }

  _start() {
    if (this._running) { this._resume(); return; }
    try {
      if (!this._setupGL()) { this.dispatchEvent(new CustomEvent("fogunsupported")); return; }
    } catch (err) {
      console.warn("[fogged-glass]", err);
      this.dispatchEvent(new CustomEvent("fogunsupported"));
      return;
    }
    this._running = true;
    this.setAttribute("data-ready", "");
    this._resume();
  }

  _setupGL() {
    const gl = this._canvas.getContext("webgl2", { antialias: false, alpha: false, premultipliedAlpha: false, powerPreference: "high-performance" });
    if (!gl) return false;
    this._half = this.dataset.lowp !== "1" && !!gl.getExtension("EXT_color_buffer_float");
    this._gl = gl;

    this._pMask = program(gl, VERT, MASK);
    this._pCopy = program(gl, VERT, COPY);
    this._pBlur = program(gl, VERT, BLUR);
    this._pBlit = program(gl, VERT, BLIT);
    this._pComp = program(gl, VERT, COMPOSITE);
    this._pDrop = program(gl, DROP_VS, DROP_FS);

    // full-screen triangle
    this._vao = gl.createVertexArray();
    gl.bindVertexArray(this._vao);
    this._quad = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this._quad);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

    // drop sprites
    this._dropData = new Float32Array(MAX_DROPS * 6 * 7);
    this._dropVao = gl.createVertexArray();
    gl.bindVertexArray(this._dropVao);
    this._dropBuf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this._dropBuf);
    gl.bufferData(gl.ARRAY_BUFFER, this._dropData.byteLength, gl.DYNAMIC_DRAW);
    const stride = 7 * 4;
    gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 2, gl.FLOAT, false, stride, 0);
    gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 2, gl.FLOAT, false, stride, 8);
    gl.enableVertexAttribArray(2); gl.vertexAttribPointer(2, 3, gl.FLOAT, false, stride, 16);
    gl.bindVertexArray(null);

    // scene texture (mipmapped: the blur chain reads it at a coarse level)
    this._scene = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this._scene);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

    // ghost writing (an old finger trace that shows when the glass fogs up)
    this._ghost = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this._ghost);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([0, 0, 0, 255]));
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

    const r = this.getBoundingClientRect();
    this._sim = new DropSim(Math.max(1, r.width), Math.max(1, r.height), (Math.random() * 1e9) | 0);
    this._seed = Math.random() * 100;
    this._time = 0;
    this._segs = [];
    this._evap = 0;
    this._evapRate = 0;
    this._revealed = false;
    this._progT = 0;

    const reduce = this._reduce.matches;
    const intro = !reduce && this.dataset.intro !== "none";
    this._introDur = intro ? this._num("introSeconds", 2.8) : 0;
    this._intro = intro ? 0 : 1;
    this._boostT = 0;

    // the ghost trace uses a handwriting font: redraw once it has loaded
    if (this.dataset.ghost && document.fonts) {
      const fam = this.dataset.ghostFont || "Caveat";
      document.fonts.load(`64px ${fam}`).then(() => { if (this._gl && this._css) this._buildGhost(); }).catch(() => {});
    }
    this._bindPointer();
    this._ro = new ResizeObserver(() => { this._needResize = true; });
    this._ro.observe(this);
    this._needResize = true;
    return true;
  }

  // -- input ------------------------------------------------------------------------------

  _bindPointer() {
    const pos = (e) => {
      const r = this.getBoundingClientRect();
      return [e.clientX - r.left, e.clientY - r.top];
    };
    const hover = this.dataset.wipe === "hover";
    this._onDown = (e) => {
      this._down = true;
      try { this.setPointerCapture(e.pointerId); } catch { /* synthetic events */ }
      const p = pos(e);
      this._last = p;
      this._segs.push([p[0], p[1], p[0], p[1]]);
      this.dispatchEvent(new CustomEvent("fogtouch"));
    };
    this._onMove = (e) => {
      if (!this._down && !hover) return;
      const evs = e.getCoalescedEvents ? e.getCoalescedEvents() : [e];
      for (const ce of (evs.length ? evs : [e])) {
        const p = pos(ce);
        if (!this._last) { this._last = p; continue; }
        if (Math.hypot(p[0] - this._last[0], p[1] - this._last[1]) < 1.5) continue;
        this._segs.push([this._last[0], this._last[1], p[0], p[1]]);
        this._last = p;
      }
    };
    // null in the queue = the finger lifted (keeps order with the strokes not yet applied)
    this._onUp = () => { if (this._down) this._segs.push(null); this._down = false; if (!hover) this._last = null; };
    this._onLeave = () => { if (hover) { this._last = null; this._segs.push(null); } };
    this.addEventListener("pointerdown", this._onDown);
    this.addEventListener("pointermove", this._onMove);
    this.addEventListener("pointerup", this._onUp);
    this.addEventListener("pointercancel", this._onUp);
    this.addEventListener("pointerleave", this._onLeave);
    this._setCursor();
  }

  _setCursor() {
    const b = Math.min(60, this._num("brush", 24));
    const s = Math.ceil(b * 2 + 4);
    const svg = `<svg xmlns='http://www.w3.org/2000/svg' width='${s}' height='${s}'><circle cx='${s / 2}' cy='${s / 2}' r='${b}' fill='none' stroke='white' stroke-opacity='.55' stroke-width='1.25'/></svg>`;
    this.style.cursor = `url("data:image/svg+xml,${encodeURIComponent(svg)}") ${s / 2} ${s / 2}, crosshair`;
  }

  // -- public API -------------------------------------------------------------------------

  /** Evaporate the fog in patches over `seconds`, and keep the glass clear. */
  clearAll(seconds = 1.6) {
    this._evapRate = 1.3 / Math.max(0.1, seconds);
    this._calm = true;
    // resting beads dry up with the fog
    if (this._sim) for (const d of this._sim.drops) if (!d.run) d.life = 0;
  }

  /** Breathe on the glass again: it fogs back up over about `seconds`. */
  fogUp(seconds = 2.5) {
    this._evap = 0; this._evapRate = 0; this._revealed = false; this._calm = false;
    this._boostT = this._boostDur = seconds * 1.6;
    if (this._sim) this._sim.fillGrid(0);
    this._strokes = []; this._stroke = null; this._writeAt = 0;
  }

  // -- write mode: keep the strokes, judge them once the finger rests -------------------

  _ink(s) {
    if (!this._stroke) { this._stroke = [s[0], s[1]]; this._strokeT0 = this._time; }
    this._stroke.push(s[2], s[3]);
  }

  _inkEnd() {
    if (this._stroke) {
      this._strokes = this._strokes || [];
      this._strokes.push({ pts: this._stroke, t0: this._strokeT0, t: this._time });
      if (this._strokes.length > 60) this._strokes.shift();
    }
    this._stroke = null;
    this._writeAt = this._time + this._num("writePause", 0.9);
  }

  _checkWriting() {
    if (!this._writeAt || this._stroke || this._down || this._time < this._writeAt) return;
    this._writeAt = 0;
    if (this._revealed || this._evapRate > 0 || !this._strokes?.length) return;
    // one attempt = strokes chained by short pauses (finger up to finger down), however
    // slowly each one is drawn; a long pause starts a new attempt
    const S = this._strokes, group = [S[S.length - 1]];
    for (let i = S.length - 2; i >= 0 && group[0].t0 - S[i].t < 2.5; i--) group.unshift(S[i]);
    const [W, H] = this._css;
    const res = looksLikeWriting(group.map((g) => g.pts), W, H);
    this.dispatchEvent(new CustomEvent("fogwrite", { detail: res }));
    if (res.ok) {
      this._revealed = true;
      this.dispatchEvent(new CustomEvent("fogreveal", { detail: res }));
    }
  }

  /** Tilt: drops follow this direction (unit vector, y down). */
  setGravity(x, y) {
    const l = Math.hypot(x, y) || 1;
    if (this._sim) this._sim.gravity = [x / l, y / l];
  }

  // -- frame ------------------------------------------------------------------------------

  _resize() {
    const gl = this._gl;
    const dpr = Math.min(window.devicePixelRatio || 1, this._num("dpr", 1.5));
    const r = this.getBoundingClientRect();
    const W = Math.max(1, r.width), H = Math.max(1, r.height);
    this._css = [W, H];
    this._canvas.width = Math.max(1, Math.round(W * dpr));
    this._canvas.height = Math.max(1, Math.round(H * dpr));

    // mask at half css res, long side capped
    const k = Math.min(0.5, 900 / Math.max(W, H));
    const mw = Math.max(2, Math.round(W * k)), mh = Math.max(2, Math.round(H * k));
    const old = this._mask;
    const fresh = [target(gl, mw, mh, this._half), target(gl, mw, mh, this._half)];
    if (old) {
      // carry the wiped strokes over to the new size
      this._pass(this._pBlit, fresh[0], { uSrc: [0, old[this._mi].tex] });
      freeTarget(gl, old[0]); freeTarget(gl, old[1]);
    } else {
      gl.bindFramebuffer(gl.FRAMEBUFFER, fresh[0].fb);
      gl.clearColor(0, 0, 0, this._intro < 1 ? 1 : 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
    }
    this._mask = fresh;
    this._mi = 0;

    freeTarget(gl, this._dropsT);
    this._dropsT = target(gl, Math.round(W), Math.round(H), false);
    for (const t of this._blur || []) freeTarget(gl, t);
    const m4 = [Math.max(2, Math.round(W / 4)), Math.max(2, Math.round(H / 4))];
    const m10 = [Math.max(2, Math.round(W / 10)), Math.max(2, Math.round(H / 10))];
    const hdr = this._half;
    this._blur = [target(gl, ...m4, false), target(gl, ...m4, false), target(gl, ...m10, hdr), target(gl, ...m10, hdr)];

    this._sim.resize(W, H);
    this._buildGhost();
    this._sceneDirty = true;
    this._needResize = false;
  }

  _buildGhost() {
    const text = this.dataset.ghost;
    const gl = this._gl;
    if (!text) {
      gl.bindTexture(gl.TEXTURE_2D, this._ghost);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([0, 0, 0, 255]));
      return;
    }
    const [W, H] = this._css;
    const c = document.createElement("canvas");
    const k = Math.min(1, 1200 / Math.max(W, H));
    c.width = Math.round(W * k); c.height = Math.round(H * k);
    const x = c.getContext("2d");
    const font = this.dataset.ghostFont || "'Caveat', 'Segoe Script', 'Bradley Hand', cursive";
    let size = Math.min(c.width * 0.16, c.height * 0.24) * this._num("ghostScale", 1);
    const fit = this._num("ghostFit", 0);
    if (fit > 0) {
      // size the word to a share of the pane's width, whatever its length
      x.font = `100px ${font}`;
      size = Math.min(c.height * 0.3, (fit * c.width * 100) / Math.max(1, x.measureText(text).width));
    }
    x.fillStyle = "#000"; x.fillRect(0, 0, c.width, c.height);
    x.font = `${size}px ${font}`;
    x.textAlign = "center"; x.textBaseline = "middle";
    x.lineJoin = "round"; x.lineCap = "round";
    x.strokeStyle = "#fff"; x.lineWidth = Math.max(4, size * this._num("ghostWeight", 0.07));
    x.filter = `blur(${Math.max(1, size * 0.02)}px)`;
    const gx = this._num("ghostX", 0.5) * c.width, gy = this._num("ghostY", 0.42) * c.height;
    x.save();
    x.translate(gx, gy); x.rotate(-0.06);
    x.strokeText(text, 0, 0);
    x.restore();
    gl.bindTexture(gl.TEXTURE_2D, this._ghost);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, c);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
  }

  _uploadScene() {
    const gl = this._gl;
    const src = this._source;
    const w = src.videoWidth || src.naturalWidth || src.width;
    const h = src.videoHeight || src.naturalHeight || src.height;
    if (!w || !h) return false;
    if (this._video && src === this._video && src.readyState < 2) return false;
    gl.bindTexture(gl.TEXTURE_2D, this._scene);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, src);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.generateMipmap(gl.TEXTURE_2D);
    this._srcSize = [w, h];
    return true;
  }

  _cover() {
    const [W, H] = this._css;
    const [w, h] = this._srcSize;
    const cA = W / H, iA = w / h;
    const z = Math.max(1, this._num("zoom", 1));      // data-zoom: tighter than cover
    return iA > cA ? [cA / iA / z, 1 / z] : [1 / z, iA / cA / z];
  }

  // centre of the crop in texture uv (y up), pulled toward data-focus, never past the edges
  _center() {
    const c = this._cover();
    const f = (this.dataset.focus || "0.5,0.5").split(",").map(Number);
    const fx = Number.isFinite(f[0]) ? f[0] : 0.5, fy = Number.isFinite(f[1]) ? f[1] : 0.5;
    const cl = (v, k) => Math.min(1 - k / 2, Math.max(k / 2, v));
    return [cl(fx, c[0]), cl(1 - fy, c[1])];
  }

  // a media-space rect (y down) -> element-space rect (y down)
  _targetRect() {
    const t = (this.dataset.target || "").split(",").map(Number);
    if (t.length !== 4 || !t.every(Number.isFinite) || !this._srcSize) return null;
    const c = this._cover(), m = this._center();
    const left = m[0] - c[0] / 2, top = (1 - m[1]) - c[1] / 2;
    return [(t[0] - left) / c[0], (t[1] - top) / c[1], t[2] / c[0], t[3] / c[1]];
  }

  _pass(prog, dst, uniforms) {
    const gl = this._gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, dst ? dst.fb : null);
    gl.viewport(0, 0, dst ? dst.w : this._canvas.width, dst ? dst.h : this._canvas.height);
    gl.useProgram(prog.p);
    gl.bindVertexArray(this._vao);
    let unit = 0;
    for (const [name, v] of Object.entries(uniforms)) {
      const loc = prog.u[name];
      if (loc === undefined || loc === null) continue;
      if (Array.isArray(v) && v.length === 2 && v[1] instanceof WebGLTexture) {
        gl.activeTexture(gl.TEXTURE0 + unit);
        gl.bindTexture(gl.TEXTURE_2D, v[1]);
        gl.uniform1i(loc, unit++);
      } else if (typeof v === "number") gl.uniform1f(loc, v);
      else if (v.i !== undefined) gl.uniform1i(loc, v.i);
      else if (v.v4) gl.uniform4fv(loc, v.v4);
      else if (v.f) gl.uniform1fv(loc, v.f);
      else if (v.length === 2) gl.uniform2f(loc, v[0], v[1]);
      else if (v.length === 3) gl.uniform3f(loc, v[0], v[1], v[2]);
    }
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  _blurScene() {
    const [W, H] = this._css;
    const [mA, mB, hA, hB] = this._blur;
    const cover = this._cover();
    const lod = (t) => Math.max(0, Math.log2((this._srcSize[0] * cover[0]) / t.w));
    const center = this._center();
    this._pass(this._pCopy, mA, { uScene: [0, this._scene], uCover: cover, uCenter: center, uLod: lod(mA), uGlow: 0 });
    for (let i = 0; i < 2; i++) {
      this._pass(this._pBlur, mB, { uSrc: [0, mA.tex], uDir: [(1 + i) / mA.w, 0] });
      this._pass(this._pBlur, mA, { uSrc: [0, mB.tex], uDir: [0, (1 + i) / mA.h] });
    }
    this._pass(this._pCopy, hA, { uScene: [0, this._scene], uCover: cover, uCenter: center, uLod: lod(hA), uGlow: this._num("glow", 10) * (this._half ? 1 : 0.1) });
    for (let i = 0; i < 3; i++) {
      this._pass(this._pBlur, hB, { uSrc: [0, hA.tex], uDir: [(1.2 + i * 0.6) / hA.w, 0] });
      this._pass(this._pBlur, hA, { uSrc: [0, hB.tex], uDir: [0, (1.2 + i * 0.6) / hA.h] });
    }
    void W; void H;
  }

  _drawDrops() {
    const gl = this._gl;
    const [W, H] = this._css;
    const out = this._dropData;
    let n = 0;
    const put = (x, y, lx, ly, e, a, r) => {
      out[n++] = (x / W) * 2 - 1; out[n++] = 1 - (y / H) * 2;
      out[n++] = lx; out[n++] = ly;
      out[n++] = e; out[n++] = a; out[n++] = r / 16;
    };
    for (const d of this._sim.drops) {
      const e = d.run ? Math.min(0.85, d.vy / 160) : 0;
      const qx = 1.15, qb = -1.15, qt = 1.15 + e * 1.6;
      const x0 = d.x - qx * d.r, x1 = d.x + qx * d.r;
      const yT = d.y - qt * d.r, yB = d.y - qb * d.r;
      const a = d.a;
      put(x0, yB, -qx, qb, e, a, d.r); put(x1, yB, qx, qb, e, a, d.r); put(x1, yT, qx, qt, e, a, d.r);
      put(x0, yB, -qx, qb, e, a, d.r); put(x1, yT, qx, qt, e, a, d.r); put(x0, yT, -qx, qt, e, a, d.r);
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, this._dropsT.fb);
    gl.viewport(0, 0, this._dropsT.w, this._dropsT.h);
    gl.clearColor(0.5, 0.5, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    if (!n) return;
    gl.useProgram(this._pDrop.p);
    gl.bindVertexArray(this._dropVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this._dropBuf);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, out, 0, n);
    gl.enable(gl.BLEND);
    gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.drawArrays(gl.TRIANGLES, 0, n / 7);
    gl.disable(gl.BLEND);
  }

  _frame(dt) {
    const gl = this._gl;
    if (!gl) return;
    if (this._needResize) this._resize();
    this._time += dt;
    const [W, H] = this._css;
    const reduce = this._reduce.matches;

    if (this._video && this._source === this._video && !this._vfc) this._sceneDirty = true;
    if (this._sceneDirty) {
      if (this._uploadScene()) this._blurScene();
      this._sceneDirty = false;
    }

    // first fog-up, then the configured refog pace (boosted after fogUp())
    if (this._intro < 1) this._intro = Math.min(1, this._intro + dt / this._introDur);
    let refog = reduce ? 0 : 1 / Math.max(1, this._num("refog", 14));
    if (this._boostT > 0) {
      this._boostT -= dt;
      refog += (1.5 / (this._boostDur / 1.6)) * Math.max(0, this._boostT / this._boostDur);
    }
    if (this._evapRate > 0) { this._evap = Math.min(1.35, this._evap + dt * this._evapRate); refog = 0; }

    // finger segments -> sim + uniforms
    const brush = this._num("brush", 24);
    if (brush !== this._cursorBrush) { this._cursorBrush = brush; this._setCursor(); }
    this._sim.amount = reduce ? 0 : this._num("drops", 1);
    this._sim.ambient = reduce || this._calm ? 0 : this._num("ambient", 0);
    const queue = this._segs;
    this._segs = [];
    for (const s of queue) {
      if (s) { this._sim.wipe(s[0], s[1], s[2], s[3], brush); this._ink(s); }
      else { this._sim.endStroke(); this._inkEnd(); }
    }
    if (this.dataset.goal === "write") this._checkWriting();
    let segs = queue.filter(Boolean);
    if (segs.length > MAX_SEGS) {
      // keep the path, drop the resolution
      const out = [];
      const step = segs.length / MAX_SEGS;
      for (let i = 0; i < MAX_SEGS; i++) {
        const a = segs[Math.floor(i * step)], b = segs[Math.min(segs.length - 1, Math.floor((i + 1) * step) - 1)];
        out.push([a[0], a[1], b[2], b[3]]);
      }
      segs = out;
    }
    const segV = new Float32Array(MAX_SEGS * 4), segR = new Float32Array(MAX_SEGS);
    segs.forEach((s, i) => {
      segV.set([s[0] / W, 1 - s[1] / H, s[2] / W, 1 - s[3] / H], i * 4);
      segR[i] = brush / H;
    });

    this._sim.step(dt, refog);
    const tr = this._sim.trails;
    const trV = new Float32Array(MAX_TRAILS * 4), trR = new Float32Array(MAX_TRAILS);
    tr.forEach((t, i) => {
      trV.set([t.x0 / W, 1 - t.y0 / H, t.x1 / W, 1 - t.y1 / H], i * 4);
      trR[i] = Math.max(0.5, t.r) / H;
    });

    // mask
    const src = this._mask[this._mi], dst = this._mask[this._mi ^ 1];
    this._pass(this._pMask, dst, {
      uMask: [0, src.tex], uAspect: [W / H, 1], uDt: dt, uRefog: refog, uIntro: this._intro,
      uEvap: this._evap, uSeed: this._seed, uQuant: this._half ? 0 : 1 / 255, uTick: (this._time * 61.7) % 997,
      uSegCount: { i: segs.length }, uSeg: { v4: segV }, uSegR: { f: segR },
      uTrailCount: { i: tr.length }, uTrail: { v4: trV }, uTrailR: { f: trR },
    });
    this._mi ^= 1;

    this._drawDrops();
    if (!this._srcSize) return;

    this._pass(this._pComp, null, {
      uScene: [0, this._scene], uBlurM: [0, this._blur[0].tex], uBlurH: [0, this._blur[2].tex],
      uMask: [0, this._mask[this._mi].tex], uDrops: [0, this._dropsT.tex], uGhost: [0, this._ghost],
      uCover: this._cover(), uCenter: this._center(), uCss: [W, H], uTime: this._time, uSeed: this._seed,
      uTint: hexToRgb(this.dataset.tint, [0.86, 0.9, 0.95]), uThick: this._num("thickness", 0.92),
      uGhostAmt: this.dataset.ghost ? this._num("ghostAmount", 1) : 0, uLens: this._num("lens", 2.4),
      uGlowTint: hexToRgb(this.dataset.glowTint, [1, 0.62, 0.3]).map((v) => v * (this._half ? 1 : 10)),
    });

    // progress, a few times a second
    this._progT -= dt;
    if (this._progT <= 0) {
      this._progT = 0.2;
      const rect = this._targetRect();
      const p = this._sim.progress(rect);
      if (this._evap > 0) { p.cleared = Math.max(p.cleared, Math.min(1, this._evap)); }
      this.dispatchEvent(new CustomEvent("fogprogress", { detail: p }));
      // goal: clear the target, or clear that much of the pane ("write" decides on its own)
      const score = rect ? p.target : p.cleared;
      if (this.dataset.goal !== "write" && !this._revealed && this._evapRate === 0 &&
          score >= this._num("threshold", 0.55)) {
        this._revealed = true;
        this.dispatchEvent(new CustomEvent("fogreveal", { detail: p }));
      }
    }
  }

  _resume() {
    if (this._raf || !this._running) return;
    this._t = performance.now();
    const loop = (now) => {
      this._raf = requestAnimationFrame(loop);
      const dt = Math.min(0.05, (now - this._t) / 1000) || 0.016;
      this._t = now;
      this._frame(dt);
    };
    this._raf = requestAnimationFrame(loop);
  }

  _pause() {
    if (this._raf) { cancelAnimationFrame(this._raf); this._raf = null; }
  }

  disconnectedCallback() { this.destroy(); }

  destroy() {
    this._pause();
    this._io?.disconnect();
    this._ro?.disconnect();
    if (this._onVis) document.removeEventListener("visibilitychange", this._onVis);
    this.removeEventListener("pointerdown", this._onDown);
    this.removeEventListener("pointermove", this._onMove);
    this.removeEventListener("pointerup", this._onUp);
    this.removeEventListener("pointercancel", this._onUp);
    this.removeEventListener("pointerleave", this._onLeave);
    this._dropVideo();
    this._gl?.getExtension("WEBGL_lose_context")?.loseContext();
    this._gl = null;
    this._running = false;
    this._init = false;
  }
}

if (!customElements.get("fogged-glass")) customElements.define("fogged-glass", FoggedGlass);
export default FoggedGlass;
