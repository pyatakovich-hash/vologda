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

const CACHE_KEY = 'vologda-vice-roads-v2';
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
// Кузов красится цветом экземпляра; фары и стоп-сигналы — отдельный меш со своим светом.
function carGeometry() {
  const parts = [
    shadedBox(4.6, 0.75, 2.0, 0, 0.75, 0),             // нижняя часть кузова
    shadedBox(4.4, 0.3, 1.94, 0.05, 1.27, 0, 0.92),    // пояс
    shadedBox(2.2, 0.62, 1.78, -0.35, 1.72, 0, 0.9),   // крыша и стойки
    shadedBox(2.0, 0.5, 1.82, -0.35, 1.7, 0, 0.22),    // стёкла
    shadedBox(0.25, 0.2, 2.06, 2.3, 0.55, 0, 0.35),    // передний бампер
    shadedBox(0.25, 0.2, 2.06, -2.3, 0.55, 0, 0.35),   // задний бампер
  ];
  for (const x of [1.45, -1.45]) for (const z of [0.95, -0.95]) parts.push(shadedBox(0.82, 0.82, 0.32, x, 0.41, z, 0.09)); // колёса
  const g = merge(parts);
  g.scale(CAR_SCALE, CAR_SCALE, CAR_SCALE);
  return g;
}
function carLightsGeometry() {
  const parts = [];
  for (const z of [0.62, -0.62]) {
    parts.push(shadedBox(0.08, 0.22, 0.42, 2.33, 0.95, z, 1.6, [1, 0.97, 0.85])); // фары
    parts.push(shadedBox(0.08, 0.2, 0.46, -2.33, 0.98, z, 1.6, [1, 0.08, 0.15])); // стоп-сигналы
  }
  const g = merge(parts);
  g.scale(CAR_SCALE, CAR_SCALE, CAR_SCALE);
  return g;
}
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
function readMVT(buf) {
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

  const ways = [];
  await Promise.all(jobs.map(async ([x, y]) => {
    let layers;
    try {
      const url = template.replace('{z}', z).replace('{x}', x).replace('{y}', y);
      layers = readMVT(await fetch(url).then(r => r.arrayBuffer()));
    } catch { return; }
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
        ways.push({ p, n: ids, f: car ? 0 : 1 });
      }
    }
  }));
  if (!ways.length) return null;
  try { localStorage.setItem(CACHE_KEY, JSON.stringify(ways)); } catch { /* слишком большой кэш — не страшно */ }
  return ways;
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

// ---------- Сборка ----------
export function tintBasemap(group) {
  group?.traverse(m => m.material?.color?.setRGB(2.6, 1.4, 3.6));
}

export function initVice(scene, config, camera, controls, getMeshes = () => []) {
  const sky = { dusk: gradientTexture(SKY_DUSK), drive: gradientTexture(SKY_NIGHT_DRIVE) };
  scene.background = sky.dusk;

  const group = new THREE.Group();
  group.name = 'vice';
  scene.add(group);

  const basic = () => new THREE.MeshBasicMaterial({ vertexColors: true });
  const additive = color => new THREE.MeshBasicMaterial({ map: glowTex, color, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false });
  const glowTex = radialTexture();
  const cars = new THREE.InstancedMesh(carGeometry(), basic(), N_CARS);
  const lights = new THREE.InstancedMesh(carLightsGeometry(), basic(), N_CARS);
  const glow = new THREE.InstancedMesh(new THREE.PlaneGeometry(16, 9).rotateX(-Math.PI / 2), additive(0xffffff), N_CARS);
  glow.material.opacity = 0.85;
  const shirts = new THREE.InstancedMesh(shirtGeometry(), basic(), N_PEOPLE);
  const bodies = new THREE.InstancedMesh(personBaseGeometry(), basic(), N_PEOPLE);
  const c = new THREE.Color();
  for (let i = 0; i < N_CARS; i++) {
    cars.setColorAt(i, c.set(CAR_COLORS[i % CAR_COLORS.length]));
    glow.setColorAt(i, c.set(GLOW_COLORS[i % GLOW_COLORS.length]));
  }
  for (let i = 0; i < N_PEOPLE; i++) shirts.setColorAt(i, c.set(SHIRTS[i % SHIRTS.length]));
  for (const m of [cars, lights, glow, shirts, bodies]) { m.count = 0; m.frustumCulled = false; group.add(m); }
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
      o.position.set(sp.x, 0, sp.z);
      o.rotation.set(0, sp.ang, 0);
      o.scale.setScalar(k % 2 ? 1 : 0.9 + Math.random() * 0.3);
      o.updateMatrix();
      if (k % 2 === 0 && li < lampsN) {
        poles.setMatrixAt(li, o.matrix);
        heads.setMatrixAt(li, o.matrix);
        const col = [NEON.pink, NEON.cyan, NEON.purple][li % 3];
        heads.setColorAt(li, c.set(col));
        pools.setColorAt(li, c.set(col));
        o.position.set(sp.x + Math.cos(sp.ang) * 2.4, 0.18, sp.z - Math.sin(sp.ang) * 2.4);
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

  let net = null, agents = [], last = 0, drive = false, propsDone = false, lastShout = 0;
  fetchRoads(config.origin).then(ways => {
    if (!ways || !ways.length) { console.warn('vice: улицы не загрузились, машин не будет'); return; }
    net = buildNetwork(ways);
    agents = [
      ...Array.from({ length: N_CARS }, () => spawn(net, true)),
      ...Array.from({ length: N_PEOPLE }, () => spawn(net, false)),
    ];
    cars.count = lights.count = glow.count = N_CARS;
    shirts.count = bodies.count = N_PEOPLE;
    console.log(`vice: ${ways.length} улиц, ${N_CARS} машин, ${N_PEOPLE} пешеходов`);
  });
  const SHOUTS = ['Эй! Тут вообще-то тротуар!', 'Права купил, что ли?!', 'Масло своё вези аккуратнее!', 'Я в «Кружево FM» позвоню!', 'Совсем уже, 1147 год на дворе!'];

  const o = new THREE.Object3D();
  function update(now) {
    const t = now / 1000, dt = Math.min(0.1, last ? t - last : 0);
    last = t;
    if (!net) return;
    if (!propsDone && document.getElementById('loading')?.hidden) { propsDone = true; buildGrid(); placeProps(); }
    if (game.driving) driveStep(dt, t);
    const boost = drive ? 3 : 1, px = pos.x, pz = pos.y, pspeed = game.driving ? vel.length() : 0;
    for (let k = 0; k < agents.length; k++) {
      const a = agents[k];
      if (a.stun > 0) a.stun -= dt;
      const p = advance(net, a, a.stun > 0 ? 0 : a.speed * dt * (a.car ? boost : 1));
      if (a.car) {
        a.x = p.x; a.z = p.z;
        o.position.set(p.x, 0, p.z);
        o.rotation.set(0, p.ang, 0);
        o.scale.setScalar(1);
        o.updateMatrix();
        cars.setMatrixAt(k, o.matrix);
        lights.setMatrixAt(k, o.matrix);
        o.position.y = 0.25;
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
        o.position.set(x + (a.ex || 0), y, z + (a.ez || 0));
        o.rotation.set(0, p.ang + (a.jump > 0 ? (1 - a.jump / 0.7) * 6.28 : 0), 0);
        o.scale.setScalar(1);
        o.updateMatrix();
        shirts.setMatrixAt(k - N_CARS, o.matrix);
        bodies.setMatrixAt(k - N_CARS, o.matrix);
      }
    }
    for (const m of [cars, lights, glow, shirts, bodies]) m.instanceMatrix.needsUpdate = true;
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
  const PROBES = [[5.2, 2.1], [5.2, -2.1], [-5.2, 2.1], [-5.2, -2.1], [0, 2.2], [0, -2.2], [5.4, 0]];
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
      camera.position.set(pos.x - Math.cos(ang) * 40, 25, pos.y + Math.sin(ang) * 40);
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
    player.position.set(pos.x, 0, pos.y);
    player.rotation.set(0, ang, 0);
    pglow.position.set(pos.x, 0.3, pos.y);
    pglow.rotation.set(0, ang, 0);
    pglow.material.opacity = 0.6 + Math.min(0.4, Math.abs(vl) / 10);
    // Камера сзади и сверху, догоняет плавно; на скорости отъезжает.
    const back = 34 + Math.abs(vf) * 0.35;
    const k = 1 - Math.exp(-5 * dt);
    camera.position.x += (pos.x - nfx * back - camera.position.x) * k;
    camera.position.y += (14 + Math.abs(vf) * 0.12 - camera.position.y) * k;
    camera.position.z += (pos.y - nfz * back - camera.position.z) * k;
    shake *= Math.exp(-6 * dt);
    camera.position.x += (Math.random() - 0.5) * shake;
    camera.position.y += (Math.random() - 0.5) * shake;
    camera.lookAt(pos.x + nfx * 14, 2, pos.y + nfz * 14);
    controls.target.set(pos.x, 0, pos.y);

    // Задание
    beam.visible = mission.stage !== 'wait';
    if (mission.stage === 'wait') return;
    const target = mission.stage === 'pickup' ? mission.pickup : mission.kremlin;
    beam.position.set(target.x, 210, target.z);
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
