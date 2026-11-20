/**
 * Неоновая ночь 80-х над Вологдой: закатное небо, машины с подсветкой днища и пешеходы,
 * которые ездят и ходят по настоящим улицам OpenStreetMap — из векторных тайлов CARTO (слой roads), кэш в localStorage.
 * Пасхалка: набери на клавиатуре 1147 (год первого упоминания Вологды).
 */
import * as THREE from './vendor/three.module.js';
import { CARTO_KEY } from './basemap.js';

const proj4 = window.proj4;
proj4.defs('EPSG:32637', '+proj=utm +zone=37 +datum=WGS84 +units=m +no_defs');

export const NEON = {
  pink: '#ff2d95', cyan: '#1fe5ff', orange: '#ffb15e', purple: '#9b5cff', yellow: '#ffe45c', white: '#f6e9ff',
};
const CAR_COLORS = [NEON.pink, NEON.cyan, NEON.white, NEON.yellow, NEON.purple, NEON.orange, NEON.pink, NEON.cyan];
const GLOW_COLORS = [NEON.pink, NEON.cyan, NEON.purple];
const SHIRTS = [NEON.pink, NEON.cyan, NEON.yellow, NEON.white, NEON.orange, '#7dffb2'];

const N_CARS = 3000;
const N_PEOPLE = 5000;
const CAR_SCALE = 2.4;      // машины и люди крупнее настоящих, чтобы их было видно с обзорной высоты
const PERSON_SCALE = 1.9;
const SPAWN_RADIUS = 2600;  // м от центра: здесь машины и люди появляются, дальше просто уезжают

const CACHE_KEY = 'vologda-vice-roads-v5';
const STYLE_URL = `https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json?key=${CARTO_KEY}`;
const ROAD_ZOOM = 14;
const SNAP = 2; // м: вершины ближе этого считаются одним перекрёстком

// ---------- Небо ----------
function gradientTexture(stops) {
  const c = document.createElement('canvas');
  c.width = 2; c.height = 512;
  const ctx = c.getContext('2d');
  const g = ctx.createLinearGradient(0, 0, 0, 512);
  for (const [o, col] of stops) g.addColorStop(o, col);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 2, 512);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.NoColorSpace;
  return tex;
}
const SKY_DUSK = [[0, '#0b0420'], [0.42, '#22093f'], [0.68, '#5e1660'], [0.86, '#d8357f'], [1, '#ff9a5a']];
const SKY_NIGHT_DRIVE = [[0, '#14022e'], [0.35, '#3d0b63'], [0.6, '#a01a7d'], [0.8, '#ff2d95'], [1, '#ffd36b']];

function radialTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const ctx = c.getContext('2d');
  const g = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(0.45, 'rgba(255,255,255,.45)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 64, 64);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.NoColorSpace;
  return tex;
}

// ---------- Геометрия: коробки с «запечённым» светом по нормалям ----------
function shadedBox(w, h, d, x, y, z, tone = 1, rgb = [1, 1, 1]) {
  const g = new THREE.BoxGeometry(w, h, d).toNonIndexed();
  g.translate(x, y, z);
  const n = g.attributes.normal, colors = new Float32Array(n.count * 3);
  for (let i = 0; i < n.count; i++) {
    const k = tone * (0.62 + 0.38 * n.getY(i) + 0.12 * n.getX(i) - 0.06 * n.getZ(i));
    colors.set([k * rgb[0], k * rgb[1], k * rgb[2]], i * 3);
  }
  g.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  g.deleteAttribute('uv');
  return g;
}
function tilted(g, rx, ry, rz, x, y, z) {
  g.rotateX(rx); g.rotateY(ry); g.rotateZ(rz); g.translate(x, y, z);
  return g;
}
function merge(parts) {
  const pos = [], nor = [], col = [];
  for (const p of parts) {
    pos.push(...p.attributes.position.array);
    nor.push(...p.attributes.normal.array);
    col.push(...p.attributes.color.array);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  return g;
}
// ---------- Советский автопарк: низкополигональные «Жигули», «Нива», «Волга», «Москвич», «буханка», «Ока», ПАЗик ----------
// Кузов красится цветом экземпляра; фары и стоп-сигналы — отдельный меш со своим светом.
const GLASS = 0.2, DARK = 0.12;
function wheels(L, z, d, xs) {
  return xs.flatMap(x => [z, -z].map(zz => shadedBox(d, d, 0.3, x, d / 2, zz, 0.09)));
}
function sedan({ L, W, low, lowY, cab, cabX, cabY, cabH, wheel, wx, grille = DARK, extra = [] }) {
  return [
    shadedBox(L, low, W, 0, lowY, 0),
    shadedBox(L - 0.2, 0.16, W - 0.04, 0, lowY + low / 2 + 0.08, 0, 0.9),
    shadedBox(cab, cabH, W - 0.12, cabX, lowY + low / 2 + 0.16 + cabH / 2, 0, 0.95),
    shadedBox(cab - 0.15, cabH - 0.12, W - 0.08, cabX, lowY + low / 2 + 0.14 + cabH / 2, 0, GLASS),
    shadedBox(0.06, 0.2, W * 0.66, L / 2 + 0.01, lowY + 0.08, 0, grille),
    shadedBox(0.16, 0.13, W + 0.06, L / 2 + 0.02, lowY - low / 2 + 0.1, 0, 1.15, [0.85, 0.85, 0.92]),
    shadedBox(0.16, 0.13, W + 0.06, -L / 2 - 0.02, lowY - low / 2 + 0.1, 0, 1.15, [0.85, 0.85, 0.92]),
    ...wheels(L, W / 2 - 0.02, wheel, wx),
    ...extra,
  ];
}
function lightsGeo(L, W, yF, yR) {
  const parts = [];
  for (const z of [W * 0.34, -W * 0.34]) {
    parts.push(shadedBox(0.08, 0.2, 0.34, L / 2 + 0.03, yF, z, 1.6, [1, 0.97, 0.85]));
    parts.push(shadedBox(0.08, 0.18, 0.4, -L / 2 - 0.03, yR, z, 1.6, [1, 0.08, 0.15]));
  }
  return parts;
}
const SOVIET = ['#e9e4d4', '#8c1c2c', '#2e5f94', '#c8b27a', '#4a2c5a', '#2a7a64', '#d9d2c0', '#6b1f1f', '#1f2a3a', NEON.pink, NEON.cyan];
const CAR_TYPES = [
  { name: 'Жигули', weight: 0.34, colors: SOVIET, L: 4.1,
    parts: () => sedan({ L: 4.1, W: 1.62, low: 0.62, lowY: 0.66, cab: 1.95, cabX: -0.2, cabY: 0, cabH: 0.5, wheel: 0.66, wx: [1.25, -1.25] }),
    lights: () => lightsGeo(4.1, 1.62, 0.8, 0.85) },
  { name: 'Нива', weight: 0.14, colors: ['#e9e4d4', '#2a7a64', '#c8b27a', '#8c1c2c', '#3a5a2a', '#2e5f94'], L: 3.74,
    parts: () => sedan({ L: 3.74, W: 1.68, low: 0.78, lowY: 0.82, cab: 2.25, cabX: -0.5, cabY: 0, cabH: 0.55, wheel: 0.8, wx: [1.12, -1.12], grille: 0.2 }),
    lights: () => lightsGeo(3.74, 1.68, 0.98, 1.0) },
  { name: 'Волга', weight: 0.14, colors: ['#1f2a3a', '#e9e4d4', '#f0c419', '#2e5f94', '#4a2c5a', '#6b1f1f'], L: 4.73,
    parts: () => sedan({ L: 4.73, W: 1.8, low: 0.62, lowY: 0.64, cab: 2.25, cabX: -0.15, cabY: 0, cabH: 0.5, wheel: 0.7, wx: [1.42, -1.42], grille: 1.2 }),
    lights: () => lightsGeo(4.73, 1.8, 0.78, 0.8) },
  { name: 'Москвич', weight: 0.12, colors: SOVIET, L: 4.1,
    parts: () => sedan({ L: 4.1, W: 1.55, low: 0.64, lowY: 0.66, cab: 2.0, cabX: -0.3, cabY: 0, cabH: 0.5, wheel: 0.64, wx: [1.22, -1.22] }),
    lights: () => lightsGeo(4.1, 1.55, 0.82, 0.86) },
  { name: 'УАЗ «буханка»', weight: 0.1, colors: ['#6f7d3b', '#d8d2c2', '#2e5f94', '#5a6a2e'], L: 4.36,
    parts: () => [
      shadedBox(4.36, 1.55, 1.94, 0, 1.18, 0),
      shadedBox(4.2, 0.14, 1.8, 0, 2.0, 0, 1.05),
      shadedBox(0.06, 0.55, 1.7, 2.19, 1.62, 0, GLASS),
      shadedBox(2.9, 0.45, 1.98, -0.45, 1.62, 0, GLASS),
      shadedBox(0.14, 0.16, 2.0, 2.22, 0.5, 0, DARK),
      ...wheels(4.36, 0.86, 0.8, [1.3, -1.3]),
    ],
    lights: () => lightsGeo(4.36, 1.94, 1.0, 1.05) },
  { name: 'Ока', weight: 0.08, colors: ['#ff8a2a', '#3fb4e0', '#e94a7a', '#e9e4d4', '#8fd14f'], L: 3.2,
    parts: () => sedan({ L: 3.2, W: 1.42, low: 0.6, lowY: 0.58, cab: 1.75, cabX: -0.2, cabY: 0, cabH: 0.5, wheel: 0.56, wx: [0.98, -0.98] }),
    lights: () => lightsGeo(3.2, 1.42, 0.72, 0.76) },
  { name: 'ПАЗ', weight: 0.08, colors: ['#f0c419', '#e9e4d4', '#e46a1f', '#2e5f94'], L: 7.0,
    parts: () => [
      shadedBox(7.0, 1.95, 2.4, 0, 1.38, 0),
      shadedBox(6.8, 0.14, 2.3, 0, 2.42, 0, 1.05),
      shadedBox(5.9, 0.75, 2.44, -0.3, 1.85, 0, GLASS),
      shadedBox(0.06, 1.0, 2.2, 3.51, 1.75, 0, GLASS),
      shadedBox(6.95, 0.16, 2.42, 0, 1.2, 0, 0.7),
      shadedBox(0.16, 0.2, 2.44, 3.52, 0.5, 0, DARK),
      ...wheels(7.0, 1.06, 0.95, [2.4, -2.4]),
    ],
    lights: () => lightsGeo(7.0, 2.4, 0.9, 1.0) },
];
function scaled(parts) {
  const g = merge(parts);
  g.scale(CAR_SCALE, CAR_SCALE, CAR_SCALE);
  return g;
}
function carGeometry(t = 0) { return scaled(CAR_TYPES[t].parts()); }
function carLightsGeometry(t = 0) { return scaled(CAR_TYPES[t].lights()); }
// Рубашка и руки красятся цветом экземпляра; джинсы, лицо и волосы — свои.
function shirtGeometry() {
  const g = merge([
    shadedBox(0.3, 0.68, 0.48, 0, 1.18, 0),
    shadedBox(0.16, 0.62, 0.14, 0, 1.12, 0.33, 0.9),
    shadedBox(0.16, 0.62, 0.14, 0, 1.12, -0.33, 0.9),
  ]);
  g.scale(PERSON_SCALE, PERSON_SCALE, PERSON_SCALE);
  return g;
}
function personBaseGeometry() {
  const g = merge([
    shadedBox(0.22, 0.84, 0.17, 0, 0.42, 0.12, 1, [0.22, 0.28, 0.55]),
    shadedBox(0.22, 0.84, 0.17, 0, 0.42, -0.12, 1, [0.22, 0.28, 0.55]),
    shadedBox(0.3, 0.32, 0.28, 0, 1.68, 0, 1, [1, 0.8, 0.66]),      // лицо
    shadedBox(0.33, 0.1, 0.31, -0.01, 1.87, 0, 1, [0.16, 0.1, 0.08]), // волосы
    shadedBox(0.07, 0.07, 0.34, 0.16, 1.72, 0, 1, [0.05, 0.05, 0.08]), // тёмные очки
  ]);
  g.scale(PERSON_SCALE, PERSON_SCALE, PERSON_SCALE);
  return g;
}
// Фонарь: столб, вынос, неоновый плафон (плафон — отдельный меш цвета экземпляра).
function lampPoleGeometry() {
  return merge([
    shadedBox(0.3, 9, 0.3, 0, 4.5, 0, 0.35, [0.5, 0.45, 0.65]),
    shadedBox(2.6, 0.22, 0.22, 1.2, 8.9, 0, 0.35, [0.5, 0.45, 0.65]),
  ]);
}
function lampHeadGeometry() { return shadedBox(1.1, 0.35, 0.6, 2.4, 8.7, 0, 1.4); }
// Пальма: наклонный ствол из сегментов и поникшие листья.
function palmTrunkGeometry() {
  const parts = [];
  for (let i = 0; i < 7; i++) parts.push(shadedBox(0.55 - i * 0.03, 1.45, 0.55 - i * 0.03, i * i * 0.025, 0.7 + i * 1.4, 0, 0.75, [0.62, 0.42, 0.38]));
  return merge(parts);
}
function palmLeavesGeometry() {
  const parts = [];
  for (let k = 0; k < 7; k++) {
    const a = k / 7 * Math.PI * 2;
    parts.push(tilted(shadedBox(4.2, 0.08, 0.9, 2.0, 0, 0, 1, [0.25, 0.95, 0.7]), 0, 0, -0.45, 0, 0, 0)
      .rotateY(a).translate(1.0, 10.1, 0));
  }
  return merge(parts);
}

// ---------- Улицы: мини-декодер Mapbox Vector Tile (protobuf) ----------
export function readMVT(buf) {
  const u8 = new Uint8Array(buf);
  let pos = 0;
  const varint = () => { let r = 0, s = 0, b; do { b = u8[pos++]; r += (b & 0x7f) * 2 ** s; s += 7; } while (b & 0x80); return r; };
  const skip = wt => { if (wt === 0) varint(); else if (wt === 1) pos += 8; else if (wt === 2) pos += varint(); else if (wt === 5) pos += 4; };
  const str = (a, b) => new TextDecoder().decode(u8.subarray(a, b));
  const packed = end => { const out = []; while (pos < end) out.push(varint()); return out; };
  const layers = [];
  while (pos < u8.length) {
    const tag = varint();
    if (tag >> 3 !== 3) { skip(tag & 7); continue; }
    const lend = pos + varint();
    const L = { name: '', extent: 4096, keys: [], values: [], features: [] };
    while (pos < lend) {
      const t = varint(), f = t >> 3;
      if (f === 1) { const n = varint(); L.name = str(pos, pos + n); pos += n; }
      else if (f === 3) { const n = varint(); L.keys.push(str(pos, pos + n)); pos += n; }
      else if (f === 5) L.extent = varint();
      else if (f === 4) {
        const vend = pos + varint(); let v = null;
        while (pos < vend) {
          const vt = varint(), vf = vt >> 3;
          if (vf === 1) { const n = varint(); v = str(pos, pos + n); pos += n; }
          else if (vf === 7) v = !!varint();
          else skip(vt & 7);
        }
        L.values.push(v);
      } else if (f === 2) {
        const fend = pos + varint(); const F = { tags: [], type: 0, geom: [] };
        while (pos < fend) {
          const ft = varint(), ff = ft >> 3;
          if (ff === 2) { const n = varint(); F.tags = packed(pos + n); }
          else if (ff === 3) F.type = varint();
          else if (ff === 4) { const n = varint(); F.geom = packed(pos + n); }
          else skip(ft & 7);
        }
        L.features.push(F);
      } else skip(t & 7);
    }
    layers.push(L);
  }
  return layers;
}
// Линии фичи в координатах тайла.
function lines(geom) {
  const out = []; let x = 0, y = 0, cur = null, i = 0;
  const zz = n => (n >> 1) ^ -(n & 1);
  while (i < geom.length) {
    const ci = geom[i++], cmd = ci & 7, cnt = ci >> 3;
    if (cmd === 7) continue;
    for (let k = 0; k < cnt; k++) {
      x += zz(geom[i++]); y += zz(geom[i++]);
      if (cmd === 1) { cur = [x, y]; out.push(cur); } else cur.push(x, y);
    }
  }
  return out;
}

async function fetchRoads(origin) {
  try {
    const cached = localStorage.getItem(CACHE_KEY);
    if (cached) return JSON.parse(cached);
  } catch { /* localStorage недоступен */ }

  let template;
  try {
    const style = await fetch(STYLE_URL).then(r => r.json());
    template = Object.values(style.sources).find(s => s.type === 'vector')?.tiles?.[0];
  } catch { /* нет сети или ключа */ }
  if (!template) return null;

  // Окно ±3,5 км вокруг центра (Софийский собор).
  const [lon0, lat0] = proj4('EPSG:32637', 'EPSG:4326', origin);
  const z = ROAD_ZOOM, n2 = 2 ** z;
  const tx = lon => Math.floor((lon + 180) / 360 * n2);
  const ty = lat => { const r = lat * Math.PI / 180; return Math.floor((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2 * n2); };
  const x0 = tx(lon0 - 0.062), x1 = tx(lon0 + 0.062), y0 = ty(lat0 + 0.032), y1 = ty(lat0 - 0.032);
  const jobs = [];
  for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) jobs.push([x, y]);

  const ways = [], water = [], rivers = [], shops = new Map();
  await Promise.all(jobs.map(async ([x, y]) => {
    let layers;
    try {
      const url = template.replace('{z}', z).replace('{x}', x).replace('{y}', y);
      layers = readMVT(await fetch(url).then(r => r.arrayBuffer()));
    } catch { return; }
    const toLocal = (L, tx, ty) => {
      const lon = (x + tx / L.extent) / n2 * 360 - 180;
      const lat = Math.atan(Math.sinh(Math.PI * (1 - 2 * (y + ty / L.extent) / n2))) * 180 / Math.PI;
      const [e, n] = proj4('EPSG:4326', 'EPSG:32637', [lon, lat]);
      return [Math.round((e - origin[0]) * 10) / 10, Math.round((origin[1] - n) * 10) / 10];
    };
    const tagsOf = (L, F) => { const t = {}; for (let i = 0; i < F.tags.length; i += 2) t[L.keys[F.tags[i]]] = L.values[F.tags[i + 1]]; return t; };
    // Вода: полигоны; рёбра по краю тайла (обрезка) — не берег, набережную на них не строим.
    const W = layers.find(l => l.name === 'water');
    for (const F of W ? W.features : []) {
      if (F.type === 2) { // реки и каналы приходят линиями: русло строим лентой нужной ширины
        const kind = tagsOf(W, F).kind;
        const width = kind === 'river' ? 88 : kind === 'canal' ? 14 : kind === 'stream' ? 7 : 0;
        if (!width) continue;
        for (const ln of lines(F.geom)) {
          if (ln.length < 4) continue;
          const p = [];
          for (let i = 0; i < ln.length; i += 2) p.push(...toLocal(W, ln[i], ln[i + 1]));
          rivers.push({ p, w: width });
        }
        continue;
      }
      if (F.type !== 3) continue;
      let poly = null;
      for (const ring of lines(F.geom)) {
        if (ring.length < 6) continue;
        let area = 0;
        for (let i = 0; i < ring.length; i += 2) { const j = (i + 2) % ring.length; area += ring[i] * ring[j + 1] - ring[j] * ring[i + 1]; }
        const pts = [], edges = [];
        for (let i = 0; i < ring.length; i += 2) pts.push(...toLocal(W, ring[i], ring[i + 1]));
        for (let i = 0; i < ring.length; i += 2) {
          const j = (i + 2) % ring.length, ax = ring[i], ay = ring[i + 1], bx = ring[j], by = ring[j + 1], e = W.extent;
          const cut = (ax <= 0 && bx <= 0) || (ax >= e && bx >= e) || (ay <= 0 && by <= 0) || (ay >= e && by >= e);
          if (!cut) edges.push(pts[i], pts[i + 1], pts[j], pts[j + 1]);
        }
        if (area > 0 || !poly) { poly = { outer: pts, holes: [], edges }; water.push(poly); }
        else { poly.holes.push(pts); poly.edges.push(...edges); }
      }
    }
    // Магазины: супермаркеты и магазины у дома с названием.
    const P = layers.find(l => l.name === 'pois');
    for (const F of P ? P.features : []) {
      const t = tagsOf(P, F);
      if (!t.name || !/^(supermarket|convenience|alcohol|department_store|mall|deli|greengrocer|butcher)$/.test(t.kind || '')) continue;
      const pt = lines(F.geom)[0];
      if (!pt) continue;
      const [px, pz] = toLocal(P, pt[0], pt[1]);
      shops.set(`${t.name}|${Math.round(px / 20)}|${Math.round(pz / 20)}`, { name: t.name, kind: t.kind, x: px, z: pz });
    }
    const L = layers.find(l => l.name === 'roads');
    if (!L) return;
    for (const F of L.features) {
      if (F.type !== 2) continue;
      const tags = {};
      for (let i = 0; i < F.tags.length; i += 2) tags[L.keys[F.tags[i]]] = L.values[F.tags[i + 1]];
      const kind = tags.kind, detail = tags.kind_detail || '';
      const car = ['highway', 'major_road', 'minor_road'].includes(kind) && detail !== 'service';
      const foot = kind === 'path' && !/^(track|pier|steps|cycleway|bridleway)$/.test(detail);
      if (!car && !foot) continue;
      for (const ln of lines(F.geom)) {
        if (ln.length < 4) continue;
        const p = [], ids = [];
        for (let i = 0; i < ln.length; i += 2) {
          const lon = (x + ln[i] / L.extent) / n2 * 360 - 180;
          const lat = Math.atan(Math.sinh(Math.PI * (1 - 2 * (y + ln[i + 1] / L.extent) / n2))) * 180 / Math.PI;
          const [e, n] = proj4('EPSG:4326', 'EPSG:32637', [lon, lat]);
          const px = Math.round((e - origin[0]) * 10) / 10, pz = Math.round((origin[1] - n) * 10) / 10;
          p.push(px, pz);
          ids.push(`${Math.round(px / SNAP)},${Math.round(pz / SNAP)}`);
        }
        ways.push({ p, n: ids, f: car ? 0 : 1, k: !car ? 0 : kind === 'minor_road' ? 1 : 2 });
      }
    }
  }));
  if (!ways.length) return null;
  const data = { ways, water, rivers, shops: [...shops.values()] };
  try { localStorage.setItem(CACHE_KEY, JSON.stringify(data)); } catch { /* слишком большой кэш — не страшно */ }
  return data;
}

function buildNetwork(ways) {
  const nodes = new Map();
  ways.forEach((w, wi) => {
    let len = 0;
    for (let i = 2; i < w.p.length; i += 2) len += Math.hypot(w.p[i] - w.p[i - 2], w.p[i + 1] - w.p[i - 1]);
    w.len = len;
    w.n.forEach((id, k) => {
      if (!nodes.has(id)) nodes.set(id, []);
      nodes.get(id).push([wi, k]);
    });
  });
  const pickWeighted = filter => {
    const pool = ways.map((w, i) => [i, filter(w) ? w.len : 0]);
    const total = pool.reduce((s, [, l]) => s + l, 0);
    return () => {
      let r = Math.random() * total;
      for (const [i, l] of pool) { if ((r -= l) <= 0) return i; }
      return pool[0][0];
    };
  };
  const near = w => Math.hypot(w.p[0], w.p[1]) < SPAWN_RADIUS;
  return { ways, nodes, randomCarWay: pickWeighted(w => !w.f && near(w)), randomAnyWay: pickWeighted(near) };
}

// Агент стоит на вершине i своей линии и идёт к вершине i + dir.
function spawn(net, car) {
  const wi = car ? net.randomCarWay() : net.randomAnyWay();
  const w = net.ways[wi], nv = w.p.length / 2;
  const dir = Math.random() < 0.5 ? 1 : -1;
  const i = dir > 0 ? Math.floor(Math.random() * (nv - 1)) : 1 + Math.floor(Math.random() * (nv - 1));
  return {
    w: wi, i, dir, d: Math.random() * segLen(w, i, i + dir),
    speed: car ? 9 + Math.random() * 9 : 1.6 + Math.random() * 1.2,
    off: car ? 2.6 : (Math.random() < 0.5 ? -1 : 1) * (w.f ? 0.8 : 6 + Math.random() * 2), // по тротуару, на пешеходных — по середине
    phase: Math.random() * 10, car,
  };
}
function segLen(w, i, j) {
  return Math.hypot(w.p[2 * j] - w.p[2 * i], w.p[2 * j + 1] - w.p[2 * i + 1]) || 0.01;
}
function advance(net, a, dist) {
  let w = net.ways[a.w];
  a.d += dist;
  let L = segLen(w, a.i, a.i + a.dir);
  let guard = 0;
  while (a.d >= L && guard++ < 20) {
    a.d -= L;
    a.i += a.dir;
    const nv = w.p.length / 2;
    const atEnd = a.i + a.dir < 0 || a.i + a.dir >= nv;
    const options = (net.nodes.get(w.n[a.i]) || []).filter(([wi]) => wi !== a.w && (!a.car || !net.ways[wi].f));
    if (options.length && (atEnd || Math.random() < 0.35)) {
      const [wi, k] = options[Math.floor(Math.random() * options.length)];
      const w2 = net.ways[wi], nv2 = w2.p.length / 2;
      a.w = wi; a.i = k; w = w2;
      a.dir = k === 0 ? 1 : k === nv2 - 1 ? -1 : (Math.random() < 0.5 ? 1 : -1);
    } else if (atEnd) {
      a.dir = -a.dir; // тупик: разворот
    }
    L = segLen(w, a.i, a.i + a.dir);
  }
  const x0 = w.p[2 * a.i], z0 = w.p[2 * a.i + 1];
  const x1 = w.p[2 * (a.i + a.dir)], z1 = w.p[2 * (a.i + a.dir) + 1];
  const t = Math.min(1, a.d / L), fx = (x1 - x0) / L, fz = (z1 - z0) / L;
  // Правостороннее движение: смещение вправо от направления (вправо от «на север» — это восток).
  return { x: x0 + (x1 - x0) * t - fz * a.off, z: z0 + (z1 - z0) * t + fx * a.off, ang: Math.atan2(-fz, fx), fx, fz };
}

// ---------- Радио: синтезатор на Web Audio + ведущий через синтез речи ----------
const midi = m => 440 * 2 ** ((m - 69) / 12);
const STATIONS = [
  { name: 'Кружево FM 87,5', genre: 'синтвейв', style: 'synth', chords: [[57, 60, 64], [53, 57, 60], [48, 52, 55], [55, 59, 62]] },
  { name: 'Масло FM 91,2', genre: 'итало-диско', style: 'italo', chords: [[60, 64, 67], [57, 60, 64], [53, 57, 60], [55, 59, 62]] },
  { name: 'Вологда Говорит 72,1', genre: 'разговорное радио', style: 'talk', chords: [[50, 57, 62], [48, 55, 60]] },
];
const ADS = [
  'Вологодское масло. Масло, которое тебя понимает.',
  'Кружевные бронежилеты фабрики «Снежинка». Защищают. И украшают.',
  'Автосалон «Кремлёвский дрифт»: подержанные «Жигули» цвета фламинго. Кредит под залог валенок.',
  'Пробки на Советском проспекте: стоят все, кроме вас. Вы стоите больше.',
  'Погода: над Вологдой вечный закат. Синоптики не знают почему и не хотят знать.',
  'Новости: на Соборной горке снова видели пальму. Мэрия всё отрицает.',
  'Прокат кассет «Видеокремль»: новые боевики каждую пятницу. Вернуть до тысяча сто сорок седьмого года.',
  'Курьерская служба «Бочка»: довезём масло, пока оно не растаяло. Или вернём сливки.',
];
let ac = null, master = null, synthTimer = 0, nextBar = 0, bar = 0, station = 0, adTimer = 0, adIdx = 0;
function note(type, f, t, d, v, slide) {
  const o = ac.createOscillator(), g = ac.createGain();
  o.type = type; o.frequency.setValueAtTime(f, t);
  if (slide) o.frequency.exponentialRampToValueAtTime(slide, t + d);
  g.gain.setValueAtTime(0.0001, t);
  g.gain.linearRampToValueAtTime(v, t + 0.008);
  g.gain.exponentialRampToValueAtTime(0.0001, t + d);
  o.connect(g).connect(master);
  o.start(t); o.stop(t + d + 0.05);
}
function scheduleBar(t0) {
  const st = STATIONS[station], ch = st.chords[bar++ % st.chords.length];
  if (st.style === 'talk') { // тихая подложка под голос
    for (const m of ch) note('triangle', midi(m), t0, 2.1, 0.05);
    return;
  }
  for (let s = 0; s < 16; s++) {
    const t = t0 + s * 0.125;
    if (st.style === 'synth') {
      if (s % 2 === 0) note('sawtooth', midi(ch[0] - 24), t, 0.22, 0.5);
      note('square', midi(ch[[0, 1, 2, 1][s % 4]] + 12), t, 0.11, 0.1);
      if (s % 4 === 0) note('triangle', midi(ch[2] + 24), t, 0.5, 0.06);
    } else {
      if (s % 4 === 0) note('sine', 140, t, 0.25, 0.9, 40);                       // бочка
      note('sawtooth', midi(ch[0] - 24 + (s % 2 ? 12 : 0)), t, 0.1, 0.35);        // октавный бас
      if (s % 2 === 0) note('square', midi(ch[(s / 2) % 3] + 24), t, 0.09, 0.07); // арпеджио
      if (s % 8 === 4) note('triangle', 1800, t, 0.06, 0.12, 900);                // «хлопок»
    }
  }
}
function speak(text) {
  try {
    const u = new SpeechSynthesisUtterance(text);
    u.lang = 'ru-RU'; u.rate = 1.05; u.pitch = 0.85;
    const v = speechSynthesis.getVoices().find(v => v.lang.startsWith('ru'));
    if (v) u.voice = v;
    speechSynthesis.speak(u);
  } catch { /* без голоса — только субтитры */ }
}
function subtitle(text) {
  let el = document.querySelector('.radio-sub');
  if (!el) { el = document.createElement('div'); el.className = 'radio-sub'; document.body.append(el); }
  el.textContent = text;
  el.classList.remove('out'); void el.offsetWidth; el.classList.add('show');
  clearTimeout(el._t); el._t = setTimeout(() => el.classList.add('out'), 7000);
}
function playAd() {
  const text = ADS[adIdx++ % ADS.length];
  subtitle(`📻 ${STATIONS[station].name}: ${text}`);
  if (STATIONS[station].style === 'talk') speak(text);
}
function startSynth(i = station) {
  stopSynth();
  station = i;
  try {
    ac ??= new AudioContext();
    ac.resume();
    master = ac.createGain();
    master.gain.value = 0.07;
    const lp = ac.createBiquadFilter();
    lp.type = 'lowpass'; lp.frequency.value = 2600;
    master.connect(lp).connect(ac.destination);
    nextBar = ac.currentTime + 0.05;
    const tick = () => { while (nextBar < ac.currentTime + 2.5) { scheduleBar(nextBar); nextBar += 2; } };
    tick();
    synthTimer = setInterval(tick, 500);
  } catch { /* без звука */ }
  const st = STATIONS[station];
  stationBanner(st.name, st.genre);
  setTimeout(playAd, st.style === 'talk' ? 1200 : 9000);
  adTimer = setInterval(playAd, st.style === 'talk' ? 12000 : 30000);
}
function stopSynth() {
  clearInterval(synthTimer); clearInterval(adTimer);
  try { speechSynthesis.cancel(); } catch { /* нет синтеза речи */ }
  if (ac && master) master.gain.setTargetAtTime(0, ac.currentTime, 0.15);
  master = null;
}
function stationBanner(name, genre) {
  document.querySelector('.radio-name')?.remove();
  const el = document.createElement('div');
  el.className = 'radio-name';
  el.innerHTML = `<b>${name}</b><span>${genre}</span>`;
  document.body.append(el);
  setTimeout(() => el.remove(), 2800);
}

function toast(html) {
  document.querySelector('.vice-toast')?.remove();
  const el = document.createElement('div');
  el.className = 'vice-toast';
  el.innerHTML = html;
  document.body.append(el);
  setTimeout(() => el.classList.add('out'), 6500);
  setTimeout(() => el.remove(), 7500);
}

// ---------- Дороги: асфальт, неоновые бровки, прерывистая осевая ----------
function roadGeometry(ways, H = () => 0) {
  const pos = [], col = [], idx = [];
  const quad = (ax, az, bx, bz, half, y, rgb, ext = 0) => {
    const L = Math.hypot(bx - ax, bz - az);
    if (L < 0.01) return;
    const fx = (bx - ax) / L, fz = (bz - az) / L, rx = -fz * half, rz = fx * half;
    const sx = ax - fx * ext, sz = az - fz * ext, ex = bx + fx * ext, ez = bz + fz * ext;
    const i = pos.length / 3;
    pos.push(sx + rx, y + H(sx + rx, sz + rz), sz + rz, sx - rx, y + H(sx - rx, sz - rz), sz - rz,
      ex - rx, y + H(ex - rx, ez - rz), ez - rz, ex + rx, y + H(ex + rx, ez + rz), ez + rz);
    for (let k = 0; k < 4; k++) col.push(...rgb);
    idx.push(i, i + 2, i + 1, i, i + 3, i + 2);
  };
  const ASPHALT = [0.17, 0.12, 0.26], WALK = [0.3, 0.17, 0.34];
  const EDGE = [[0.12, 0.9, 1.0], [1.0, 0.18, 0.58]], DASH = [1.0, 0.89, 0.36];
  for (const w of ways) {
    const width = w.k === 2 ? 15 : w.k === 1 ? 8.5 : 2.6;
    // Длинные отрезки режем по 25 м, чтобы лента повторяла рельеф.
    const pts = [w.p[0], w.p[1]];
    for (let i = 2; i < w.p.length; i += 2) {
      const ax = w.p[i - 2], az = w.p[i - 1], bx = w.p[i], bz = w.p[i + 1], parts = Math.max(1, Math.ceil(Math.hypot(bx - ax, bz - az) / 25));
      for (let k = 1; k <= parts; k++) pts.push(ax + (bx - ax) * k / parts, az + (bz - az) * k / parts);
    }
    for (let i = 2; i < pts.length; i += 2) {
      const ax = pts[i - 2], az = pts[i - 1], bx = pts[i], bz = pts[i + 1];
      quad(ax, az, bx, bz, width / 2, w.k ? 0.04 : 0.03, w.k ? ASPHALT : WALK, width / 2);
      if (!w.k) continue;
      const L = Math.hypot(bx - ax, bz - az), fx = (bx - ax) / L, fz = (bz - az) / L, rx = -fz, rz = fx;
      const off = width / 2 - 0.6, edge = EDGE[w.k === 2 ? 0 : 1];
      quad(ax + rx * off, az + rz * off, bx + rx * off, bz + rz * off, 0.4, 0.07, edge);
      quad(ax - rx * off, az - rz * off, bx - rx * off, bz - rz * off, 0.4, 0.07, edge);
      if (w.k === 2) for (let d = 1; d + 3 < L; d += 9) quad(ax + fx * d, az + fz * d, ax + fx * (d + 4), az + fz * (d + 4), 0.3, 0.08, DASH);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.setIndex(idx);
  return g;
}

// ---------- Купол-луковица с барабаном и крестом ----------
function shadeByNormal(g, rgb, tone = 1) {
  g = g.index ? g.toNonIndexed() : g;
  g.computeVertexNormals();
  const n = g.attributes.normal, colors = new Float32Array(n.count * 3);
  for (let i = 0; i < n.count; i++) {
    const k = tone * (0.55 + 0.45 * Math.max(0, n.getY(i) * 0.6 + n.getX(i) * 0.5 + 0.3));
    colors.set([k * rgb[0], k * rgb[1], k * rgb[2]], i * 3);
  }
  g.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  g.deleteAttribute('uv');
  return g;
}
function domeGeometry() {
  const onion = [[0, 0], [0.56, 0], [0.66, 0.18], [0.8, 0.5], [0.82, 0.78], [0.68, 1.08], [0.42, 1.36], [0.18, 1.6], [0.06, 1.85], [0, 2.0]]
    .map(([x, y]) => new THREE.Vector2(x, y));
  const drum = shadeByNormal(new THREE.CylinderGeometry(0.55, 0.6, 1.1, 16).translate(0, 0.55, 0), [0.95, 0.93, 0.88]);
  const dome = shadeByNormal(new THREE.LatheGeometry(onion, 20).translate(0, 1.1, 0), [1.0, 0.78, 0.28], 1.15);
  const cross = merge([
    shadedBox(0.06, 0.9, 0.06, 0, 3.5, 0, 1.2, [1, 0.85, 0.4]),
    shadedBox(0.42, 0.06, 0.06, 0, 3.65, 0, 1.2, [1, 0.85, 0.4]),
  ]);
  return merge([drum, dome, cross]);
}

// ---------- Неоновые вывески на крышах ----------
const SIGNS = ['МАСЛО', 'КРУЖЕВО', '1147', 'ВОЛОГДА', 'ДИСКО', 'ВИДЕОПРОКАТ', 'ТАКСИ', 'КИНО', 'ОТЕЛЬ «ЗАКАТ»', 'БАР «ПРИСТАНЬ»', 'КАФЕ «ЛЁН»', 'КАССЕТЫ', 'ПЕЛЬМЕНИ', 'ГАЛАНТЕРЕЯ'];
function signTexture(text, color) {
  const c = document.createElement('canvas');
  c.width = 1024; c.height = 256;
  const ctx = c.getContext('2d');
  ctx.font = '400 150px Lobster, cursive';
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.shadowColor = color; ctx.shadowBlur = 40;
  ctx.fillStyle = color;
  ctx.fillText(text, 512, 132, 980);
  ctx.shadowBlur = 0; ctx.fillStyle = '#ffffff'; ctx.globalAlpha = 0.85;
  ctx.fillText(text, 512, 132, 980);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.NoColorSpace;
  tex.anisotropy = 4;
  return tex;
}

// ---------- Вода и набережные ----------
// Зеркало воды ложится на рельеф на 1,2 м ниже берега; набережная — гранитная стенка с неоновым ограждением.
function waterGeometry(polys, H) {
  const pos = [], idx = [];
  for (const P of polys) {
    const ring = pts => { const v = []; for (let i = 0; i < pts.length; i += 2) v.push(new THREE.Vector2(pts[i], pts[i + 1])); return v; };
    const outer = ring(P.outer), holes = P.holes.map(ring);
    let tris;
    try { tris = THREE.ShapeUtils.triangulateShape(outer, holes); } catch { continue; }
    const all = outer.concat(...holes), base = pos.length / 3;
    for (const v of all) pos.push(v.x, H(v.x, v.y) - 1.2, v.y);
    for (const t of tris) idx.push(base + t[0], base + t[1], base + t[2]);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  return g;
}
function embankmentGeometry(polys, H, rivers = [], nearRoad = () => false) {
  const pos = [], col = [], idx = [];
  const quad = (a, b, c2, d, rgb) => {
    const i = pos.length / 3;
    pos.push(...a, ...b, ...c2, ...d);
    for (let k = 0; k < 4; k++) col.push(...rgb);
    idx.push(i, i + 1, i + 2, i, i + 2, i + 3);
  };
  // Русло в OSM часто разбито на несколько полигонов: общие рёбра — это стыки, а не берег.
  const key = (ax, az, bx, bz) => { const a = `${Math.round(ax)},${Math.round(az)}`, b = `${Math.round(bx)},${Math.round(bz)}`; return a < b ? a + '|' + b : b + '|' + a; };
  const seen = new Map();
  for (const P of polys) for (let k = 0; k < P.edges.length; k += 4) { const kk = key(P.edges[k], P.edges[k + 1], P.edges[k + 2], P.edges[k + 3]); seen.set(kk, (seen.get(kk) || 0) + 1); }
  // Маска воды (клетка 4 м, чётно-нечётная заливка): ребро, у которого вода с обеих сторон, — стык, а не берег.
  const C = 4, HALF = 4800, N = Math.ceil(2 * HALF / C), mask = new Uint8Array(N * N);
  for (const P of polys) {
    const rings = [P.outer, ...P.holes];
    if (!P.outer.length) continue;
    let z0 = Infinity, z1 = -Infinity;
    for (let i = 1; i < P.outer.length; i += 2) { z0 = Math.min(z0, P.outer[i]); z1 = Math.max(z1, P.outer[i]); }
    for (let iz = Math.max(0, Math.floor((z0 + HALF) / C)); iz <= Math.min(N - 1, Math.floor((z1 + HALF) / C)); iz++) {
      const z = (iz + 0.5) * C - HALF, xs = [];
      for (const r of rings) for (let i = 0, j = r.length - 2; i < r.length; j = i, i += 2)
        if ((r[i + 1] > z) !== (r[j + 1] > z)) xs.push(r[i] + (z - r[i + 1]) * (r[j] - r[i]) / (r[j + 1] - r[i + 1]));
      xs.sort((a, b) => a - b);
      for (let k = 0; k + 1 < xs.length; k += 2)
        for (let ix = Math.max(0, Math.ceil((xs[k] + HALF) / C - 0.5)); ix <= Math.min(N - 1, Math.floor((xs[k + 1] + HALF) / C - 0.5)); ix++) mask[iz * N + ix] = 1;
    }
  }
  for (const R of rivers) { // русла тоже вода: стык пруда и реки — не берег
    const c = densify(R.p, C);
    for (let i = 0; i < c.length; i += 2) for (let dx = -R.w / 2; dx <= R.w / 2; dx += C) for (let dz = -R.w / 2; dz <= R.w / 2; dz += C) {
      if (dx * dx + dz * dz > R.w * R.w / 4) continue;
      const ix = Math.floor((c[i] + dx + HALF) / C), iz = Math.floor((c[i + 1] + dz + HALF) / C);
      if (ix >= 0 && iz >= 0 && ix < N && iz < N) mask[iz * N + ix] = 1;
    }
  }
  const wet = (x, z) => { const ix = Math.floor((x + HALF) / C), iz = Math.floor((z + HALF) / C); return ix >= 0 && iz >= 0 && ix < N && iz < N && mask[iz * N + ix] === 1; };
  for (const P of polys) {
    const e = P.edges;
    for (let k = 0; k < e.length; k += 4) {
      const ax = e[k], az = e[k + 1], bx = e[k + 2], bz = e[k + 3], L = Math.hypot(bx - ax, bz - az);
      if (L < 0.5 || seen.get(key(ax, az, bx, bz)) > 1) continue;
      const mx = (ax + bx) / 2, mz = (az + bz) / 2, nx0 = -(bz - az) / L * 6, nz0 = (bx - ax) / L * 6;
      if (wet(mx + nx0, mz + nz0) && wet(mx - nx0, mz - nz0)) continue;
      if (nearRoad(mx, mz)) continue; // мост: стенку не ставим поперёк дороги
      const parts = Math.ceil(L / 15), nx = -(bz - az) / L, nz = (bx - ax) / L;
      const shade = 0.75 + 0.25 * Math.abs(nx * 0.6 + nz * 0.8);
      const granite = [0.42 * shade, 0.36 * shade, 0.5 * shade], cap = [0.62, 0.56, 0.7];
      const rail = Math.abs(nx) > Math.abs(nz) ? [0.12, 0.9, 1.0] : [1.0, 0.18, 0.58];
      for (let j = 0; j < parts; j++) {
        const x0 = ax + (bx - ax) * j / parts, z0 = az + (bz - az) * j / parts;
        const x1 = ax + (bx - ax) * (j + 1) / parts, z1 = az + (bz - az) * (j + 1) / parts;
        const h0 = H(x0, z0), h1 = H(x1, z1);
        quad([x0, h0 - 2.4, z0], [x1, h1 - 2.4, z1], [x1, h1 + 1.0, z1], [x0, h0 + 1.0, z0], granite);         // стенка
        quad([x0 - nx * 1.6, h0 + 1.0, z0 - nz * 1.6], [x1 - nx * 1.6, h1 + 1.0, z1 - nz * 1.6],
             [x1 + nx * 1.6, h1 + 1.0, z1 + nz * 1.6], [x0 + nx * 1.6, h0 + 1.0, z0 + nz * 1.6], cap);           // парапет
        quad([x0, h0 + 1.0, z0], [x1, h1 + 1.0, z1], [x1, h1 + 1.9, z1], [x0, h0 + 1.9, z0], rail);            // ограждение
      }
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.setIndex(idx);
  return g;
}
// Русло по линии реки: смещаем полилинию на ±w/2 по усреднённым нормалям (без щелей на изгибах).
function offsetLine(p, d) {
  const out = [], n = p.length / 2;
  for (let i = 0; i < n; i++) {
    const a = Math.max(0, i - 1), b = Math.min(n - 1, i + 1);
    let fx = p[2 * b] - p[2 * a], fz = p[2 * b + 1] - p[2 * a + 1];
    const L = Math.hypot(fx, fz) || 1; fx /= L; fz /= L;
    out.push(p[2 * i] - fz * d, p[2 * i + 1] + fx * d);
  }
  return out;
}
function densify(p, step) {
  const out = [p[0], p[1]];
  for (let i = 2; i < p.length; i += 2) {
    const ax = p[i - 2], az = p[i - 1], bx = p[i], bz = p[i + 1], k = Math.max(1, Math.ceil(Math.hypot(bx - ax, bz - az) / step));
    for (let j = 1; j <= k; j++) out.push(ax + (bx - ax) * j / k, az + (bz - az) * j / k);
  }
  return out;
}
function mergeGeoms(gs) {
  const pos = [], idx = [];
  for (const g of gs) {
    const base = pos.length / 3;
    for (const v of g.attributes.position.array) pos.push(v);
    for (const i of g.index ? g.index.array : []) idx.push(base + i);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  return g;
}
function riverWaterGeometry(rivers, H) {
  const pos = [], idx = [];
  for (const R of rivers) {
    const c = densify(R.p, 20), l = offsetLine(c, R.w / 2), r = offsetLine(c, -R.w / 2);
    const base = pos.length / 3, n = c.length / 2;
    for (let i = 0; i < n; i++) {
      pos.push(l[2 * i], H(c[2 * i], c[2 * i + 1]) - 1.2, l[2 * i + 1], r[2 * i], H(c[2 * i], c[2 * i + 1]) - 1.2, r[2 * i + 1]);
      if (i) { const k = base + 2 * i; idx.push(k - 2, k - 1, k, k - 1, k + 1, k); }
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  return g;
}
// Берега рек как рёбра для набережной (в том же формате, что у прудов); стыки с мостами вырезаются по дорогам.
function riverBanks(rivers) {
  return rivers.map(R => {
    const c = densify(R.p, 15), edges = [];
    for (const side of [R.w / 2, -R.w / 2]) {
      const o = offsetLine(c, side);
      for (let i = 2; i < o.length; i += 2) edges.push(o[i - 2], o[i - 1], o[i], o[i + 1]);
    }
    return { outer: [], holes: [], edges };
  });
}

// Рябь с неоновыми бликами по воде.
function waterShader(sh) {
  sh.vertexShader = 'varying vec3 vP;\n' + sh.vertexShader.replace('#include <begin_vertex>', '#include <begin_vertex>\n  vP = position;');
  sh.fragmentShader = 'varying vec3 vP;\nuniform float uT;\n' + sh.fragmentShader.replace(/}\s*$/, `
  float w1 = sin(vP.x * 0.09 + uT * 0.9) * sin(vP.z * 0.13 - uT * 0.7);
  float w3 = sin(vP.x * 0.05 - uT * 0.5) * sin(vP.z * 0.07 + uT * 0.6);
  gl_FragColor.rgb += vec3(1.0, 0.2, 0.6) * smoothstep(0.86, 1.0, w1) * 0.45 + vec3(0.2, 0.95, 1.0) * smoothstep(0.9, 1.0, w3) * 0.35;
}`);
  sh.uniforms.uT = sh.uniforms.uT || { value: 0 };
}
// Вывеска: название магазина как в данных OSM, неоном; фирменные логотипы не воспроизводим.
function shopTexture(name, color) {
  const c = document.createElement('canvas');
  c.width = 1024; c.height = 256;
  const ctx = c.getContext('2d');
  ctx.fillStyle = 'rgba(12, 4, 28, 0.82)';
  ctx.fillRect(8, 24, 1008, 208);
  ctx.strokeStyle = color; ctx.lineWidth = 8; ctx.shadowColor = color; ctx.shadowBlur = 24;
  ctx.strokeRect(12, 28, 1000, 200);
  ctx.font = '800 120px Onest, Arial, sans-serif';
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillStyle = '#ffffff';
  ctx.fillText(name, 512, 132, 940);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.NoColorSpace;
  tex.anisotropy = 4;
  return tex;
}

// ---------- Сборка ----------
export function tintBasemap(group) {
  group?.traverse(m => m.material?.color?.setRGB(2.6, 1.4, 3.6));
}

export function initVice(scene, config, camera, controls, getMeshes = () => [], getBuilding = () => null, terrainP = null) {
  // Высота рельефа в точке (terrain.js); пока рельеф не загрузился — 0.
  let H = () => 0, terrainSettled = !terrainP;
  terrainP?.then(t => { if (t) H = t.H; terrainSettled = true; });
  const sky = { dusk: gradientTexture(SKY_DUSK), drive: gradientTexture(SKY_NIGHT_DRIVE) };
  scene.background = sky.dusk;

  const group = new THREE.Group();
  group.name = 'vice';
  scene.add(group);

  const basic = () => new THREE.MeshBasicMaterial({ vertexColors: true });
  const additive = color => new THREE.MeshBasicMaterial({ map: glowTex, color, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false });
  const glowTex = radialTexture();
  // Распределяем машины по моделям; у каждой модели свой меш кузова и фар.
  const typeOf = [], typeIdx = [], typeCount = CAR_TYPES.map(() => 0);
  {
    let acc = 0, t = 0;
    const cum = CAR_TYPES.map(T => (acc += T.weight));
    for (let i = 0; i < N_CARS; i++) {
      const r = (i + 0.5) / N_CARS * acc;
      t = cum.findIndex(c => r <= c);
      typeOf.push(t); typeIdx.push(typeCount[t]++);
    }
  }
  const carMeshes = CAR_TYPES.map((T, t) => new THREE.InstancedMesh(carGeometry(t), basic(), Math.max(1, typeCount[t])));
  const lightMeshes = CAR_TYPES.map((T, t) => new THREE.InstancedMesh(carLightsGeometry(t), basic(), Math.max(1, typeCount[t])));
  const glow = new THREE.InstancedMesh(new THREE.PlaneGeometry(16, 9).rotateX(-Math.PI / 2), additive(0xffffff), N_CARS);
  glow.material.opacity = 0.85;
  const shirts = new THREE.InstancedMesh(shirtGeometry(), basic(), N_PEOPLE);
  const bodies = new THREE.InstancedMesh(personBaseGeometry(), basic(), N_PEOPLE);
  const c = new THREE.Color();
  for (let i = 0; i < N_CARS; i++) {
    const T = CAR_TYPES[typeOf[i]];
    carMeshes[typeOf[i]].setColorAt(typeIdx[i], c.set(T.colors[(i * 7) % T.colors.length]));
    glow.setColorAt(i, c.set(GLOW_COLORS[i % GLOW_COLORS.length]));
  }
  for (let i = 0; i < N_PEOPLE; i++) shirts.setColorAt(i, c.set(SHIRTS[i % SHIRTS.length]));
  const moving = [...carMeshes, ...lightMeshes, glow, shirts, bodies];
  for (const m of moving) { m.count = 0; m.frustumCulled = false; group.add(m); }
  glow.renderOrder = 1;

  // ---------- Карта занятости: где стоят дома (по крышам зданий, клетка 2 м) ----------
  const G = { size: 2, half: 4000, n: 4000, cells: null };
  function buildGrid() {
    const ms = getMeshes();
    if (!ms.length) return false;
    const cells = new Uint8Array(G.n * G.n), inv = 1 / G.size;
    for (const m of ms) {
      const p = m.geometry.attributes.position.array, idx = m.geometry.index.array;
      const sc = m.scale.x, ox = m.position.x, oz = m.position.z;
      for (let t = 0; t < idx.length; t += 3) {
        const i0 = idx[t] * 3, i1 = idx[t + 1] * 3, i2 = idx[t + 2] * 3;
        const x0 = p[i0] * sc + ox, z0 = p[i0 + 2] * sc + oz, x1 = p[i1] * sc + ox, z1 = p[i1 + 2] * sc + oz, x2 = p[i2] * sc + ox, z2 = p[i2 + 2] * sc + oz;
        const area = (x1 - x0) * (z2 - z0) - (x2 - x0) * (z1 - z0);
        if (Math.abs(area) < 0.5) continue; // стены не нужны, только горизонтальные грани
        const minX = Math.max(0, Math.floor((Math.min(x0, x1, x2) + G.half) * inv)), maxX = Math.min(G.n - 1, Math.floor((Math.max(x0, x1, x2) + G.half) * inv));
        const minZ = Math.max(0, Math.floor((Math.min(z0, z1, z2) + G.half) * inv)), maxZ = Math.min(G.n - 1, Math.floor((Math.max(z0, z1, z2) + G.half) * inv));
        const sg = Math.sign(area);
        for (let iz = minZ; iz <= maxZ; iz++) {
          const cz = (iz + 0.5) * G.size - G.half;
          for (let ix = minX; ix <= maxX; ix++) {
            const cx = (ix + 0.5) * G.size - G.half;
            const e0 = ((x1 - x0) * (cz - z0) - (z1 - z0) * (cx - x0)) * sg;
            const e1 = ((x2 - x1) * (cz - z1) - (z2 - z1) * (cx - x1)) * sg;
            const e2 = ((x0 - x2) * (cz - z2) - (z0 - z2) * (cx - x2)) * sg;
            if (e0 >= -0.01 && e1 >= -0.01 && e2 >= -0.01) cells[iz * G.n + ix] = 1;
          }
        }
      }
    }
    G.cells = cells;
    return true;
  }
  const blocked = (x, z) => {
    if (!G.cells) return false;
    const ix = Math.floor((x + G.half) / G.size), iz = Math.floor((z + G.half) / G.size);
    return ix >= 0 && iz >= 0 && ix < G.n && iz < G.n && G.cells[iz * G.n + ix] === 1;
  };

  // ---------- Фонари и пальмы вдоль улиц ----------
  function placeProps() {
    const spots = [];
    for (const w of net.ways) {
      if (w.f || Math.hypot(w.p[0], w.p[1]) > SPAWN_RADIUS) continue;
      let carry = Math.random() * 60;
      for (let i = 2; i < w.p.length; i += 2) {
        const x0 = w.p[i - 2], z0 = w.p[i - 1], x1 = w.p[i], z1 = w.p[i + 1], L = Math.hypot(x1 - x0, z1 - z0);
        if (!L) continue;
        const fx = (x1 - x0) / L, fz = (z1 - z0) / L;
        for (let d = carry; d < L; d += 70) {
          const side = spots.length % 2 ? 1 : -1, x = x0 + fx * d - fz * 9 * side, z = z0 + fz * d + fx * 9 * side;
          if (!blocked(x, z) && !blocked(x + 1.5, z) && !blocked(x - 1.5, z) && !blocked(x, z + 1.5) && !blocked(x, z - 1.5))
            spots.push({ x, z, ang: Math.atan2(-fz, fx) + (side > 0 ? 0 : Math.PI) + Math.PI / 2 });
          carry = d + 70 - L;
        }
        if (carry < 0) carry = 0;
      }
    }
    const lampsN = Math.ceil(spots.length / 2), palmsN = spots.length - lampsN;
    const poles = new THREE.InstancedMesh(lampPoleGeometry(), basic(), lampsN);
    const heads = new THREE.InstancedMesh(lampHeadGeometry(), basic(), lampsN);
    const pools = new THREE.InstancedMesh(new THREE.PlaneGeometry(22, 22).rotateX(-Math.PI / 2), additive(0xffffff), lampsN);
    pools.material.opacity = 0.55;
    const trunks = new THREE.InstancedMesh(palmTrunkGeometry(), basic(), palmsN);
    const leaves = new THREE.InstancedMesh(palmLeavesGeometry(), basic(), palmsN);
    let li = 0, pi = 0;
    spots.forEach((sp, k) => {
      const gy = H(sp.x, sp.z);
      o.position.set(sp.x, gy, sp.z);
      o.rotation.set(0, sp.ang, 0);
      o.scale.setScalar(k % 2 ? 1 : 0.9 + Math.random() * 0.3);
      o.updateMatrix();
      if (k % 2 === 0 && li < lampsN) {
        poles.setMatrixAt(li, o.matrix);
        heads.setMatrixAt(li, o.matrix);
        const col = [NEON.pink, NEON.cyan, NEON.purple][li % 3];
        heads.setColorAt(li, c.set(col));
        pools.setColorAt(li, c.set(col));
        o.position.set(sp.x + Math.cos(sp.ang) * 2.4, 0, sp.z - Math.sin(sp.ang) * 2.4);
        o.position.y = H(o.position.x, o.position.z) + 0.18;
        o.updateMatrix();
        pools.setMatrixAt(li++, o.matrix);
      } else if (pi < palmsN) {
        trunks.setMatrixAt(pi, o.matrix);
        leaves.setMatrixAt(pi++, o.matrix);
      }
    });
    for (const m of [poles, heads, pools, trunks, leaves]) { m.frustumCulled = false; group.add(m); }
    console.log(`vice: ${lampsN} фонарей, ${palmsN} пальм`);
  }

  // ---------- Купола на храмах и вывески на высоких домах (по названиям из поиска) ----------
  async function placeLandmarks() {
    let names = [];
    try { names = (await fetch('data/search.json').then(r => r.json())).names || []; } catch { return; }
    const domes = [], signs = [];
    for (const [name, , x, z, , gid] of names) {
      if (!(gid >= 0) || Math.hypot(x, z) > SPAWN_RADIUS) continue;
      let b;
      try { b = getBuilding(gid); } catch { continue; }
      if (!b || !b.height) continue;
      const church = (b.groups || []).some(g => g.bit === 10) || /собор|церк|храм|часовн/i.test(name);
      if (church) {
        const R = Math.max(3.2, Math.min(8, b.height * 0.3));
        const top = b.height + H(x, z);
        domes.push([x, top, z, R]);
        if (/собор/i.test(name)) for (const [dx, dz] of [[1, 1], [1, -1], [-1, 1], [-1, -1]]) domes.push([x + dx * R * 2.2, top, z + dz * R * 2.2, R * 0.55]);
      } else if (b.height >= 15 && Math.hypot(x, z) < 2400 && signs.every(([sx, , sz]) => Math.hypot(sx - x, sz - z) > 220)) {
        signs.push([x, b.height + H(x, z), z]);
      }
    }
    if (domes.length) {
      const dm = new THREE.InstancedMesh(domeGeometry(), basic(), domes.length);
      domes.forEach(([x, y, z, R], i) => { o.position.set(x, y, z); o.rotation.set(0, 0, 0); o.scale.setScalar(R); o.updateMatrix(); dm.setMatrixAt(i, o.matrix); });
      dm.frustumCulled = false;
      group.add(dm);
    }
    await document.fonts?.load('150px Lobster').catch(() => {});
    signs.slice(0, SIGNS.length).forEach(([x, y, z], i) => {
      const color = [NEON.pink, NEON.cyan, NEON.yellow, NEON.orange, NEON.purple][i % 5];
      const m = new THREE.Mesh(new THREE.PlaneGeometry(28, 7), new THREE.MeshBasicMaterial({
        map: signTexture(SIGNS[i], color), transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide }));
      m.position.set(x, y + 4.5, z);
      m.rotation.y = Math.atan2(-x, -z); // лицом к центру города
      group.add(m);
    });
    console.log(`vice: ${domes.length} куполов, ${Math.min(signs.length, SIGNS.length)} вывесок`);
  }

  let net = null, agents = [], last = 0, drive = false, propsDone = false, lastShout = 0;
  let waterMat = null, shopData = [];
  fetchRoads(config.origin).then(data => {
    const ways = data?.ways;
    if (!ways || !ways.length) { console.warn('vice: улицы не загрузились, машин не будет'); return; }
    net = buildNetwork(ways);
    agents = [
      ...Array.from({ length: N_CARS }, () => spawn(net, true)),
      ...Array.from({ length: N_PEOPLE }, () => spawn(net, false)),
    ];
    carMeshes.forEach((m, t) => { m.count = lightMeshes[t].count = typeCount[t]; });
    glow.count = N_CARS;
    shirts.count = bodies.count = N_PEOPLE;
    shopData = data.shops || [];
    Promise.resolve(terrainP).then(() => {
      // Порядок: подложка (−3) → вода (−2) → дороги (−1): подложка не пишет глубину, поэтому не перекрывает их на склонах.
      const roads = new THREE.Mesh(roadGeometry(ways, H), new THREE.MeshBasicMaterial({ vertexColors: true, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 }));
      roads.renderOrder = -1;
      group.add(roads);
      const rivers = data.rivers || [];
      // Хэш точек дорог (клетка 12 м), чтобы прервать набережную на мостах.
      const roadCells = new Set();
      for (const w of ways) if (!w.f) { const d = densify(w.p, 6); for (let i = 0; i < d.length; i += 2) roadCells.add(`${Math.floor(d[i] / 12)},${Math.floor(d[i + 1] / 12)}`); }
      const nearRoad = (x, z) => roadCells.has(`${Math.floor(x / 12)},${Math.floor(z / 12)}`);
      const wg = mergeGeoms([waterGeometry(data.water || [], H), riverWaterGeometry(rivers, H)]);
      waterMat = new THREE.MeshBasicMaterial({ color: '#1b3f9a', side: THREE.DoubleSide, depthWrite: false });
      waterMat.onBeforeCompile = sh => { sh.uniforms.uT = { value: 0 }; waterMat.userData.shader = sh; waterShader(sh); };
      const waterMesh = new THREE.Mesh(wg, waterMat);
      waterMesh.renderOrder = -2;
      group.add(waterMesh, new THREE.Mesh(embankmentGeometry([...(data.water || []), ...riverBanks(rivers)], H, rivers, nearRoad), basic()));
      console.log(`vice: ${(data.water || []).length} водоёмов, ${rivers.length} русел, ${shopData.length} магазинов`);
    });
    console.log(`vice: ${ways.length} улиц, ${N_CARS} машин, ${N_PEOPLE} пешеходов`);
  });

  // ---------- Вывески магазинов: настоящие точки из OpenStreetMap, оформление своё ----------
  function placeShops() {
    if (!shopData.length || !net) return;
    const texCache = new Map(), signs = [];
    const near = shopData.filter(sh => Math.hypot(sh.x, sh.z) < SPAWN_RADIUS + 600).slice(0, 180);
    near.forEach((sh, i) => {
      const v = nearestVertex(sh.x, sh.z, w => !w.f);
      const rx = v ? v.w.p[2 * v.i] - sh.x : 1, rz = v ? v.w.p[2 * v.i + 1] - sh.z : 0;
      const color = [NEON.pink, NEON.cyan, NEON.yellow, NEON.orange, '#7dffb2'][i % 5];
      const key = sh.name + color;
      if (!texCache.has(key)) texCache.set(key, shopTexture(sh.name, color));
      const m = new THREE.Mesh(new THREE.PlaneGeometry(16, 4), new THREE.MeshBasicMaterial({ map: texCache.get(key), transparent: true, side: THREE.DoubleSide, depthWrite: false }));
      // Вывеска чуть ближе к дороге, лицом к ней, на высоте второго этажа.
      const d = Math.hypot(rx, rz) || 1, px = sh.x + rx / d * Math.min(6, d * 0.4), pz = sh.z + rz / d * Math.min(6, d * 0.4);
      m.position.set(px, H(px, pz) + 6.5, pz);
      m.rotation.y = Math.atan2(rx, rz);
      group.add(m);
      signs.push([px, pz, color]);
    });
    // Пятно света под каждой вывеской.
    const pools = new THREE.InstancedMesh(new THREE.PlaneGeometry(14, 14).rotateX(-Math.PI / 2), additive(0xffffff), Math.max(1, signs.length));
    pools.material.opacity = 0.5;
    signs.forEach(([x, z, col], i) => { o.position.set(x, H(x, z) + 0.2, z); o.rotation.set(0, 0, 0); o.scale.setScalar(1); o.updateMatrix(); pools.setMatrixAt(i, o.matrix); pools.setColorAt(i, c.set(col)); });
    pools.frustumCulled = false;
    group.add(pools);
  }
  const SHOUTS = ['Эй! Тут вообще-то тротуар!', 'Права купил, что ли?!', 'Масло своё вези аккуратнее!', 'Я в «Кружево FM» позвоню!', 'Совсем уже, 1147 год на дворе!'];

  const o = new THREE.Object3D();
  function update(now) {
    const t = now / 1000, dt = Math.min(0.1, last ? t - last : 0);
    last = t;
    if (!net) return;
    if (!propsDone && terrainSettled && document.getElementById('loading')?.hidden) { propsDone = true; buildGrid(); placeProps(); placeLandmarks(); placeShops(); }
    if (waterMat?.userData.shader) waterMat.userData.shader.uniforms.uT.value = t;
    if (game.driving) driveStep(dt, t);
    const boost = drive ? 3 : 1, px = pos.x, pz = pos.y, pspeed = game.driving ? vel.length() : 0;
    for (let k = 0; k < agents.length; k++) {
      const a = agents[k];
      if (a.stun > 0) a.stun -= dt;
      const p = advance(net, a, a.stun > 0 ? 0 : a.speed * dt * (a.car ? boost : 1));
      if (a.car) {
        a.x = p.x; a.z = p.z;
        const gy = H(p.x, p.z);
        o.position.set(p.x, gy, p.z);
        o.rotation.set(0, p.ang, 0);
        o.scale.setScalar(1);
        o.updateMatrix();
        carMeshes[typeOf[k]].setMatrixAt(typeIdx[k], o.matrix);
        lightMeshes[typeOf[k]].setMatrixAt(typeIdx[k], o.matrix);
        o.position.y = gy + 0.25;
        o.scale.setScalar(drive ? 1.7 : 1);
        o.updateMatrix();
        glow.setMatrixAt(k, o.matrix);
      } else {
        let x = p.x, z = p.z;
        // Не заходить в дома: на узкой улице пешеход прижимается к проезжей части.
        if (blocked(x, z)) { x += p.fz * a.off * 0.7; z -= p.fx * a.off * 0.7; }
        // Отпрыгнуть от машины игрока.
        if (pspeed > 2 && !(a.jump > 0)) {
          const dx = x + (a.ex || 0) - px, dz = z + (a.ez || 0) - pz, d2 = dx * dx + dz * dz;
          if (d2 < 100) {
            const d = Math.sqrt(d2) || 1;
            a.jump = 0.7; a.vx = dx / d * (8 + pspeed * 0.3); a.vz = dz / d * (8 + pspeed * 0.3);
            if (t - lastShout > 6 && Math.random() < 0.35) { lastShout = t; subtitle(`Пешеход: «${SHOUTS[Math.floor(Math.random() * SHOUTS.length)]}»`); }
          }
        }
        let y = Math.abs(Math.sin(t * 7 + a.phase)) * 0.25;
        if (a.jump > 0) {
          a.jump -= dt;
          a.ex = (a.ex || 0) + a.vx * dt; a.ez = (a.ez || 0) + a.vz * dt;
          y = Math.sin((1 - a.jump / 0.7) * Math.PI) * 2.6;
        } else if (a.ex) {
          a.ex *= Math.exp(-0.4 * dt); a.ez *= Math.exp(-0.4 * dt);
          if (Math.abs(a.ex) + Math.abs(a.ez) < 0.05) a.ex = a.ez = 0;
        }
        o.position.set(x + (a.ex || 0), y + H(x, z), z + (a.ez || 0));
        o.rotation.set(0, p.ang + (a.jump > 0 ? (1 - a.jump / 0.7) * 6.28 : 0), 0);
        o.scale.setScalar(1);
        o.updateMatrix();
        shirts.setMatrixAt(k - N_CARS, o.matrix);
        bodies.setMatrixAt(k - N_CARS, o.matrix);
      }
    }
    for (const m of moving) m.instanceMatrix.needsUpdate = true;
  }

  // ---------- Своя машина и задание «Масло в Кремль» ----------
  const game = { driving: false };
  const player = new THREE.Mesh(carGeometry(), new THREE.MeshBasicMaterial({ vertexColors: true, color: NEON.pink }));
  const playerLights = new THREE.Mesh(carLightsGeometry(), new THREE.MeshBasicMaterial({ vertexColors: true }));
  player.add(playerLights);
  const pglow = new THREE.Mesh(new THREE.PlaneGeometry(20, 11).rotateX(-Math.PI / 2),
    new THREE.MeshBasicMaterial({ map: glow.material.map, color: NEON.cyan, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false }));
  pglow.position.y = 0.3;
  const playerGroup = new THREE.Group();
  playerGroup.add(player, pglow);
  playerGroup.visible = false;
  const beam = new THREE.Mesh(new THREE.CylinderGeometry(7, 7, 420, 24, 1, true),
    new THREE.MeshBasicMaterial({ color: NEON.yellow, transparent: true, opacity: 0.35, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide }));
  beam.position.y = 210;
  beam.visible = false;
  group.add(playerGroup, beam);

  const keys = new Set();
  const pos = new THREE.Vector2(), vel = new THREE.Vector2();
  let ang = 0, money = 0, mission = null, shake = 0, lastBump = 0;
  // Углы машины игрока (длина ~11 м, ширина ~4,8 м) плюс середины бортов.
  const PROBES = [[4.8, 1.8], [4.8, -1.8], [-4.8, 1.8], [-4.8, -1.8], [0, 1.95], [0, -1.95], [5.0, 0]];
  function hits(x, z, a) {
    const fx = Math.cos(a), fz = -Math.sin(a);
    for (const [l, w] of PROBES) if (blocked(x + fx * l - fz * w, z + fz * l + fx * w)) return true;
    return false;
  }
  function bump(speed) {
    shake = Math.min(2.5, Math.max(shake, speed * 0.12));
    const now = performance.now();
    if (speed > 8 && now - lastBump > 1500) {
      lastBump = now;
      subtitle(['Бам!', 'Хрясь!', 'Ой, бампер…', 'Страховка «Вологда-Авто» уже едет.'][Math.floor(Math.random() * 4)]);
    }
  }
  const hud = document.createElement('div');
  hud.className = 'game-hud';
  hud.innerHTML = `<div class="g-money">₽ 0</div><div class="g-timer"></div><div class="g-goal"><i class="g-arrow">➤</i><span></span></div>
    <p class="g-help">W/S — газ и тормоз · A/D — руль · Пробел — ручник · Q/E — радио · F — выйти</p>`;
  document.body.append(hud);
  const btn = document.createElement('button');
  btn.className = 'drive-btn';
  btn.textContent = 'Сесть за руль (F)';
  btn.onclick = () => toggleDrive();
  document.body.append(btn);

  function nearestVertex(x, z, filter = () => true) {
    let best = null, bd = Infinity;
    for (const w of net.ways) {
      if (!filter(w)) continue;
      for (let i = 0; i < w.p.length; i += 2) {
        const d = (w.p[i] - x) ** 2 + (w.p[i + 1] - z) ** 2;
        if (d < bd) { bd = d; best = { w, i: i / 2 }; }
      }
    }
    return best;
  }
  function randomPickup() {
    for (let k = 0; k < 200; k++) {
      const w = net.ways[net.randomCarWay()], i = Math.floor(Math.random() * (w.p.length / 2));
      const x = w.p[2 * i], z = w.p[2 * i + 1], d = Math.hypot(x - pos.x, z - pos.y);
      if (d > 500 && d < 1300 && Math.hypot(x, z) > 500) return { x, z };
    }
    return { x: pos.x + 600, z: pos.y };
  }
  function newMission() {
    const k = nearestVertex(0, 0, w => !w.f);
    mission = { stage: 'pickup', pickup: randomPickup(), kremlin: { x: k.w.p[2 * k.i], z: k.w.p[2 * k.i + 1] }, time: 0 };
    banner('Новое задание', 'Забери бочку вологодского масла на складе (жёлтый луч)');
  }
  function banner(title, text, cls = '') {
    toast(`<b>${title}</b><span>${text}</span>`);
    document.querySelector('.vice-toast')?.classList.add('game', ...(cls ? [cls] : []));
  }
  function toggleDrive() {
    if (!net) { banner('Минутку', 'Улицы ещё грузятся'); return; }
    game.driving = !game.driving;
    document.body.classList.toggle('driving', game.driving);
    playerGroup.visible = game.driving;
    controls.enabled = !game.driving;
    btn.textContent = game.driving ? 'Выйти из машины (F)' : 'Сесть за руль (F)';
    if (game.driving) {
      if (!G.cells) buildGrid();
      const v = nearestVertex(controls.target.x, controls.target.z, w => !w.f);
      const w = v.w, j = Math.min(v.i + 1, w.p.length / 2 - 1), i = j - 1;
      pos.set(w.p[2 * i], w.p[2 * i + 1]);
      ang = Math.atan2(-(w.p[2 * j + 1] - w.p[2 * i + 1]), w.p[2 * j] - w.p[2 * i]);
      vel.set(0, 0);
      camera.position.set(pos.x - Math.cos(ang) * 40, H(pos.x, pos.y) + 25, pos.y + Math.sin(ang) * 40);
      if (!mission) newMission();
      beam.visible = true;
      startSynth(station);
    } else {
      stopSynth();
      beam.visible = false;
      controls.target.set(pos.x, 0, pos.y);
      camera.position.set(pos.x + 200, 220, pos.y + 300);
      controls.update();
    }
  }

  function driveStep(dt, t) {
    const fx = Math.cos(ang), fz = -Math.sin(ang), rx = -fz, rz = fx;
    let vf = vel.x * fx + vel.y * fz, vl = vel.x * rx + vel.y * rz;
    const up = keys.has('w') || keys.has('arrowup'), down = keys.has('s') || keys.has('arrowdown');
    const left = keys.has('a') || keys.has('arrowleft'), right = keys.has('d') || keys.has('arrowright');
    const hand = keys.has(' ');
    if (up) vf = Math.min(48, vf + 24 * dt);
    if (down) vf = vf > 0.5 ? vf - 42 * dt : Math.max(-12, vf - 12 * dt);
    vf *= Math.exp(-(up || down ? 0.15 : 0.7) * dt);
    if (hand) vf *= Math.exp(-1.1 * dt);
    const steer = (left ? 1 : 0) - (right ? 1 : 0);
    const prevAng = ang, stuck = hits(pos.x, pos.y, ang);
    ang += steer * (hand ? 3.2 : 2.1) * dt * Math.max(-1, Math.min(1, vf / 10));
    if (!stuck && hits(pos.x, pos.y, ang)) ang = prevAng; // не поворачивать «в стену»
    vl *= Math.exp(-(hand ? 1.2 : 9) * dt);
    const nfx = Math.cos(ang), nfz = -Math.sin(ang);
    vel.set(nfx * vf + -nfz * vl, nfz * vf + nfx * vl);
    // Дома: двигаемся по осям отдельно, чтобы скользить вдоль стены; лоб в стену — отскок.
    const nx = pos.x + vel.x * dt, nz = pos.y + vel.y * dt;
    if (stuck || !hits(nx, nz, ang)) pos.set(nx, nz);
    else {
      const sp = vel.length();
      if (!hits(nx, pos.y, ang)) { pos.x = nx; vel.y *= -0.25; vel.x *= 0.7; }
      else if (!hits(pos.x, nz, ang)) { pos.y = nz; vel.x *= -0.25; vel.y *= 0.7; }
      else vel.multiplyScalar(-0.3);
      bump(sp);
    }
    // Другие машины: расталкиваемся, встречная машина замирает на пару секунд.
    for (const a of agents) {
      if (!a.car || a.x === undefined) continue;
      const dx = pos.x - a.x, dz = pos.y - a.z, d2 = dx * dx + dz * dz;
      if (d2 > 64) continue;
      const d = Math.sqrt(d2) || 1, ux = dx / d, uz = dz / d, vn = vel.x * ux + vel.y * uz;
      if (vn < 0) { vel.x -= 1.5 * vn * ux; vel.y -= 1.5 * vn * uz; bump(-vn); }
      if (!hits(pos.x + ux * (8 - d), pos.y + uz * (8 - d), ang)) { pos.x += ux * (8 - d); pos.y += uz * (8 - d); }
      if (vel.length() > 2) a.stun = 1.2;
    }
    const gy = H(pos.x, pos.y);
    player.position.set(pos.x, gy, pos.y);
    // Наклон по склону: вперёд-назад и вбок.
    const slope = Math.atan2(H(pos.x + nfx * 5, pos.y + nfz * 5) - H(pos.x - nfx * 5, pos.y - nfz * 5), 10);
    const roll = Math.atan2(H(pos.x - nfz * 2.5, pos.y + nfx * 2.5) - H(pos.x + nfz * 2.5, pos.y - nfx * 2.5), 5);
    player.rotation.set(roll, ang, slope, 'YXZ');
    pglow.position.set(pos.x, gy + 0.3, pos.y);
    pglow.rotation.set(0, ang, 0);
    pglow.material.opacity = 0.6 + Math.min(0.4, Math.abs(vl) / 10);
    // Камера сзади и сверху, догоняет плавно; на скорости отъезжает.
    const back = 34 + Math.abs(vf) * 0.35;
    const k = 1 - Math.exp(-5 * dt);
    camera.position.x += (pos.x - nfx * back - camera.position.x) * k;
    camera.position.y += (gy + 14 + Math.abs(vf) * 0.12 - camera.position.y) * k;
    camera.position.z += (pos.y - nfz * back - camera.position.z) * k;
    shake *= Math.exp(-6 * dt);
    camera.position.x += (Math.random() - 0.5) * shake;
    camera.position.y += (Math.random() - 0.5) * shake;
    camera.lookAt(pos.x + nfx * 14, gy + 2, pos.y + nfz * 14);
    controls.target.set(pos.x, 0, pos.y);

    // Задание
    beam.visible = mission.stage !== 'wait';
    if (mission.stage === 'wait') return;
    const target = mission.stage === 'pickup' ? mission.pickup : mission.kremlin;
    beam.position.set(target.x, H(target.x, target.z) + 210, target.z);
    beam.material.color.set(mission.stage === 'pickup' ? NEON.yellow : NEON.pink);
    beam.material.opacity = 0.28 + 0.1 * Math.sin(t * 4);
    const dx = target.x - pos.x, dz = target.z - pos.y, dist = Math.hypot(dx, dz);
    const rel = Math.atan2(-dz, dx) - ang;
    hud.querySelector('.g-arrow').style.transform = `rotate(${-rel - Math.PI / 2}rad)`;
    hud.querySelector('.g-goal span').textContent = (mission.stage === 'pickup' ? 'Склад масла' : 'Кремль') + ` · ${Math.round(dist)} м`;
    if (mission.stage === 'deliver') {
      mission.time -= dt;
      hud.querySelector('.g-timer').textContent = `${Math.max(0, Math.ceil(mission.time))} с`;
      hud.querySelector('.g-timer').classList.toggle('hot', mission.time < 10);
      if (mission.time <= 0) {
        mission.stage = 'pickup';
        hud.querySelector('.g-timer').textContent = '';
        banner('Масло растаяло', 'Вернись на склад за новой бочкой', 'fail');
      }
    }
    if (dist < 16) {
      if (mission.stage === 'pickup') {
        mission.stage = 'deliver';
        mission.time = Math.round(Math.hypot(mission.kremlin.x - pos.x, mission.kremlin.z - pos.y) / 11 + 25);
        banner('Бочка на борту', `Довези масло в Кремль за ${mission.time} секунд (розовый луч)`);
      } else {
        const prize = 500 + Math.round(mission.time) * 20;
        money += prize;
        hud.querySelector('.g-money').textContent = `₽ ${money.toLocaleString('ru')}`;
        hud.querySelector('.g-timer').textContent = '';
        banner('Задание выполнено', `+${prize.toLocaleString('ru')} ₽ · масло доставлено в Кремль`, 'win');
        mission = { stage: 'wait' };
        setTimeout(() => { if (game.driving) newMission(); else mission = null; }, 3500);
      }
    }
  }

  addEventListener('keydown', e => {
    if (e.target.closest?.('input, textarea, [contenteditable]')) return;
    const k = e.key.toLowerCase();
    if (k === 'f' || k === 'а') { toggleDrive(); return; }
    if (!game.driving) return;
    const map = { 'ц': 'w', 'ы': 's', 'ф': 'a', 'в': 'd', 'й': 'q', 'у': 'e' };
    const kk = map[k] || k;
    if (kk === 'q' || kk === 'e') { startSynth((station + (kk === 'e' ? 1 : STATIONS.length - 1)) % STATIONS.length); return; }
    keys.add(kk);
    if ([' ', 'arrowup', 'arrowdown', 'arrowleft', 'arrowright'].includes(kk)) e.preventDefault();
  });
  addEventListener('keyup', e => {
    const k = e.key.toLowerCase(), map = { 'ц': 'w', 'ы': 's', 'ф': 'a', 'в': 'd' };
    keys.delete(map[k] || k);
  });
  addEventListener('blur', () => keys.clear());

  // Набери 1147 — включится «Ночной заезд».
  let typed = '';
  addEventListener('keydown', e => {
    if (e.target.closest?.('input, textarea, [contenteditable]')) return;
    typed = (typed + e.key).slice(-4);
    if (typed !== '1147') return;
    typed = '';
    drive = !drive;
    scene.background = drive ? sky.drive : sky.dusk;
    glow.material.opacity = drive ? 1 : 0.85;
    document.body.classList.toggle('vice-drive', drive);
    if (drive) {
      startSynth(0);
      toast('<b>1147 · Ночной заезд</b><span>В эфире «Кружево FM 87,5» — синтвейв над Вологдой с 1147 года.</span><small>Набери 1147 ещё раз, чтобы заглушить мотор.</small>');
    } else {
      stopSynth();
      toast('<b>Заезд окончен</b><span>Вологда снова спит.</span>');
    }
  });

  return { group, update, driving: () => game.driving };
}
