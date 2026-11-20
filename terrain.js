/**
 * Рельеф Вологды из открытых тайлов высот Terrarium (AWS Open Data, Mapzen; без ключа).
 * Сетка высот в локальной рамке сцены (метры от центра, x — восток, z — юг),
 * с вертикальным преувеличением: город почти плоский (перепад ~15–25 м).
 */
import * as THREE from './vendor/three.module.js';

const proj4 = window.proj4;
proj4.defs('EPSG:32637', '+proj=utm +zone=37 +datum=WGS84 +units=m +no_defs');
const TILE = 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png';

export async function loadTerrain(config, { half = 4600, n = 384, zoom = 13 } = {}) {
  const origin = config.origin;
  const cell = (2 * half) / (n - 1), min = -half;
  const toLonLat = (x, z) => proj4('EPSG:32637', 'EPSG:4326', [origin[0] + x, origin[1] - z]);

  // Тайлы, покрывающие квадрат сетки.
  const corners = [[-half, -half], [half, -half], [half, half], [-half, half]].map(([x, z]) => toLonLat(x, z));
  const n2 = 2 ** zoom;
  const tx = lon => (lon + 180) / 360 * n2;
  const ty = lat => { const r = lat * Math.PI / 180; return (1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2 * n2; };
  const x0 = Math.floor(Math.min(...corners.map(c => tx(c[0])))), x1 = Math.floor(Math.max(...corners.map(c => tx(c[0]))));
  const y0 = Math.floor(Math.min(...corners.map(c => ty(c[1])))), y1 = Math.floor(Math.max(...corners.map(c => ty(c[1]))));
  const W = (x1 - x0 + 1) * 256, Hh = (y1 - y0 + 1) * 256;
  const canvas = new OffscreenCanvas(W, Hh), ctx = canvas.getContext('2d', { willReadFrequently: true });
  const jobs = [];
  for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) {
    jobs.push(fetch(TILE.replace('{z}', zoom).replace('{x}', x).replace('{y}', y))
      .then(r => { if (!r.ok) throw new Error(r.status); return r.blob(); })
      .then(createImageBitmap)
      .then(bmp => ctx.drawImage(bmp, (x - x0) * 256, (y - y0) * 256)));
  }
  await Promise.all(jobs);
  const px = ctx.getImageData(0, 0, W, Hh).data;
  const elevAt = (fx, fy) => { // билинейно по пикселям мозаики
    const ix = Math.max(0, Math.min(W - 2, Math.floor(fx))), iy = Math.max(0, Math.min(Hh - 2, Math.floor(fy)));
    const ax = fx - ix, ay = fy - iy;
    const e = (i, j) => { const k = ((iy + j) * W + ix + i) * 4; return px[k] * 256 + px[k + 1] + px[k + 2] / 256 - 32768; };
    return (e(0, 0) * (1 - ax) + e(1, 0) * ax) * (1 - ay) + (e(0, 1) * (1 - ax) + e(1, 1) * ax) * ay;
  };

  const raw = new Float32Array(n * n);
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
    const [lon, lat] = toLonLat(min + i * cell, min + j * cell);
    raw[j * n + i] = elevAt((tx(lon) - x0) * 256, (ty(lat) - y0) * 256);
  }
  // Ноль — уровень центра (Софийский собор), чтобы камера и подписи остались на месте.
  const c = Math.floor(n / 2), base = raw[c * n + c];
  let lo = Infinity, hi = -Infinity;
  for (const v of raw) { lo = Math.min(lo, v); hi = Math.max(hi, v); }
  const exag = Math.max(3, Math.min(6, 70 / Math.max(1, hi - lo)));
  const grid = new Float32Array(n * n);
  for (let k = 0; k < grid.length; k++) grid[k] = (raw[k] - base) * exag;

  const H = (x, z) => {
    const gx = Math.max(0, Math.min(n - 1.001, (x - min) / cell)), gz = Math.max(0, Math.min(n - 1.001, (z - min) / cell));
    const i = Math.floor(gx), j = Math.floor(gz), fx = gx - i, fz = gz - j, k = j * n + i;
    return (grid[k] * (1 - fx) + grid[k + 1] * fx) * (1 - fz) + (grid[k + n] * (1 - fx) + grid[k + n + 1] * fx) * fz;
  };
  const texture = new THREE.DataTexture(grid, n, n, THREE.RedFormat, THREE.FloatType);
  texture.needsUpdate = true;
  console.log(`terrain: ${lo.toFixed(1)}–${hi.toFixed(1)} м над морем, преувеличение ×${exag.toFixed(1)}`);
  // Невидимая поверхность рельефа (только глубина), на 10 м ниже земли: прячет всё, что за холмом,
  // но не перекрывает дороги, воду в долине и набережные (берега при преувеличении ×3 поднимаются круто).
  const pos = new Float32Array(n * n * 3), idx = new Uint32Array((n - 1) * (n - 1) * 6);
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) { const k = j * n + i; pos.set([min + i * cell, grid[k] - 10, min + j * cell], k * 3); }
  let q = 0;
  for (let j = 0; j < n - 1; j++) for (let i = 0; i < n - 1; i++) { const a = j * n + i; idx.set([a, a + n, a + 1, a + 1, a + n, a + n + 1], q); q += 6; }
  const og = new THREE.BufferGeometry();
  og.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  og.setIndex(new THREE.BufferAttribute(idx, 1));
  const occluder = new THREE.Mesh(og, new THREE.MeshBasicMaterial({ colorWrite: false, side: THREE.DoubleSide }));
  occluder.renderOrder = -4;
  occluder.frustumCulled = false;
  return { H, texture, rect: new THREE.Vector4(min, min, cell, n), exag, lo, hi, base, occluder };
}

/** Посадить плитки подложки на рельеф и наложить отмывку склонов (свет с северо-запада). */
export function drapeBasemap(group, H, exag = 3) {
  EXAG = exag;
  const L = new THREE.Vector3(-0.6, 0.75, -0.3).normalize();
  group?.traverse(m => {
    if (!m.isMesh) return;
    const p = m.geometry.attributes.position, col = new Float32Array(p.count * 3);
    for (let i = 0; i < p.count; i++) {
      const x = p.getX(i), z = p.getZ(i), h = H(x, z);
      p.setY(i, h - 0.1);
      const nx = H(x - 15, z) - H(x + 15, z), nz = H(x, z - 15) - H(x, z + 15);
      const nrm = new THREE.Vector3(nx, 30, nz).normalize();
      const s = 0.45 + 0.75 * Math.max(0, nrm.dot(L));
      col.set([s, s, s], i * 3);
    }
    p.needsUpdate = true;
    m.geometry.setAttribute('color', new THREE.BufferAttribute(col, 3));
    m.geometry.computeBoundingSphere();
    m.material.vertexColors = true;
    m.material.onBeforeCompile = contours;
    m.material.needsUpdate = true;
  });
}

// Неоновые горизонтали: тонкие — каждые 2 м настоящей высоты, яркие — каждые 10 м; низины синее, холмы розовее.
let EXAG = 3;
function contours(shader) {
  shader.uniforms.uStep = { value: 2 * EXAG };
  shader.vertexShader = 'varying float vH;\n' + shader.vertexShader.replace('#include <begin_vertex>', '#include <begin_vertex>\n  vH = transformed.y;');
  shader.fragmentShader = 'varying float vH;\nuniform float uStep;\n' + shader.fragmentShader.replace(/}\s*$/, `
  float f = vH / uStep;
  float thin = 1.0 - min(abs(fract(f - 0.5) - 0.5) / max(fwidth(f), 1e-4), 1.0);
  float g = vH / (uStep * 5.0);
  float bold = 1.0 - min(abs(fract(g - 0.5) - 0.5) / max(fwidth(g), 1e-4) / 1.6, 1.0);
  float t = clamp((vH + 40.0) / 160.0, 0.0, 1.0);
  vec3 tint = mix(vec3(0.05, 0.12, 0.35), vec3(0.45, 0.06, 0.35), t);
  gl_FragColor.rgb += tint * 0.35 + mix(vec3(0.12, 0.9, 1.0), vec3(1.0, 0.18, 0.6), t) * (thin * 0.22 + bold * 0.6);
}`);
}
