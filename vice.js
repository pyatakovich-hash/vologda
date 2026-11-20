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
const PERSON_SCALE = 2.6;
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
function shadedBox(w, h, d, x, y, z, tone = 1) {
  const g = new THREE.BoxGeometry(w, h, d).toNonIndexed();
  g.translate(x, y, z);
  const n = g.attributes.normal, colors = new Float32Array(n.count * 3);
  for (let i = 0; i < n.count; i++) {
    const k = tone * (0.62 + 0.38 * n.getY(i) + 0.12 * n.getX(i) - 0.06 * n.getZ(i));
    colors.set([k, k, k], i * 3);
  }
  g.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  g.deleteAttribute('uv');
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
function carGeometry() {
  const s = CAR_SCALE;
  const g = merge([
    shadedBox(4.6, 1.1, 2.0, 0, 0.9, 0),            // кузов
    shadedBox(2.3, 0.7, 1.8, -0.35, 1.8, 0, 0.28),  // тёмная кабина
    shadedBox(0.12, 0.28, 1.7, 2.32, 1.0, 0, 4),    // фары
  ]);
  g.scale(s, s, s);
  return g;
}
function personGeometry() {
  const s = PERSON_SCALE;
  const g = merge([
    shadedBox(0.5, 0.8, 0.32, 0, 0.4, 0, 0.35),   // ноги
    shadedBox(0.6, 0.7, 0.38, 0, 1.15, 0),        // рубашка
    shadedBox(0.34, 0.34, 0.34, 0, 1.7, 0, 0.9),  // голова
  ]);
  g.scale(s, s, s);
  return g;
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
  return { x: x0 + (x1 - x0) * t - fz * a.off, z: z0 + (z1 - z0) * t + fx * a.off, ang: Math.atan2(-fz, fx) };
}

// ---------- Пасхалка: «Ночной заезд» и радио «Кружево FM» ----------
const midi = m => 440 * 2 ** ((m - 69) / 12);
const CHORDS = [[57, 60, 64], [53, 57, 60], [48, 52, 55], [55, 59, 62]]; // ля минор — фа — до — соль
let ac = null, master = null, synthTimer = 0, nextBar = 0, bar = 0;
function note(type, f, t, d, v) {
  const o = ac.createOscillator(), g = ac.createGain();
  o.type = type; o.frequency.value = f;
  g.gain.setValueAtTime(0.0001, t);
  g.gain.linearRampToValueAtTime(v, t + 0.01);
  g.gain.exponentialRampToValueAtTime(0.0001, t + d);
  o.connect(g).connect(master);
  o.start(t); o.stop(t + d + 0.05);
}
function scheduleBar(t0) {
  const ch = CHORDS[bar++ % 4];
  for (let s = 0; s < 16; s++) {
    const t = t0 + s * 0.125;
    if (s % 2 === 0) note('sawtooth', midi(ch[0] - 24), t, 0.22, 0.5);
    note('square', midi(ch[[0, 1, 2, 1][s % 4]] + 12), t, 0.11, 0.1);
    if (s % 4 === 0) note('triangle', midi(ch[2] + 24), t, 0.5, 0.06);
  }
}
function startSynth() {
  try {
    ac ??= new AudioContext();
    ac.resume();
    master = ac.createGain();
    master.gain.value = 0.07;
    const lp = ac.createBiquadFilter();
    lp.type = 'lowpass'; lp.frequency.value = 2400;
    master.connect(lp).connect(ac.destination);
    nextBar = ac.currentTime + 0.05;
    const tick = () => { while (nextBar < ac.currentTime + 2.5) { scheduleBar(nextBar); nextBar += 2; } };
    tick();
    synthTimer = setInterval(tick, 500);
  } catch { /* без звука */ }
}
function stopSynth() {
  clearInterval(synthTimer);
  if (ac && master) master.gain.setTargetAtTime(0, ac.currentTime, 0.15);
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

export function initVice(scene, config) {
  const sky = { dusk: gradientTexture(SKY_DUSK), drive: gradientTexture(SKY_NIGHT_DRIVE) };
  scene.background = sky.dusk;

  const group = new THREE.Group();
  group.name = 'vice';
  scene.add(group);

  const cars = new THREE.InstancedMesh(carGeometry(), new THREE.MeshBasicMaterial({ vertexColors: true }), N_CARS);
  const glow = new THREE.InstancedMesh(
    new THREE.PlaneGeometry(16, 9).rotateX(-Math.PI / 2),
    new THREE.MeshBasicMaterial({ map: radialTexture(), transparent: true, opacity: 0.85, blending: THREE.AdditiveBlending, depthWrite: false }),
    N_CARS);
  const people = new THREE.InstancedMesh(personGeometry(), new THREE.MeshBasicMaterial({ vertexColors: true }), N_PEOPLE);
  const c = new THREE.Color();
  for (let i = 0; i < N_CARS; i++) {
    cars.setColorAt(i, c.set(CAR_COLORS[i % CAR_COLORS.length]));
    glow.setColorAt(i, c.set(GLOW_COLORS[i % GLOW_COLORS.length]));
  }
  for (let i = 0; i < N_PEOPLE; i++) people.setColorAt(i, c.set(SHIRTS[i % SHIRTS.length]));
  for (const m of [cars, glow, people]) { m.count = 0; m.frustumCulled = false; group.add(m); }
  glow.renderOrder = 1;

  let net = null, agents = [], last = 0, drive = false;
  fetchRoads(config.origin).then(ways => {
    if (!ways || !ways.length) { console.warn('vice: улицы не загрузились, машин не будет'); return; }
    net = buildNetwork(ways);
    agents = [
      ...Array.from({ length: N_CARS }, () => spawn(net, true)),
      ...Array.from({ length: N_PEOPLE }, () => spawn(net, false)),
    ];
    cars.count = glow.count = N_CARS;
    people.count = N_PEOPLE;
    console.log(`vice: ${ways.length} улиц, ${N_CARS} машин, ${N_PEOPLE} пешеходов`);
  });

  const o = new THREE.Object3D();
  function update(now) {
    const t = now / 1000, dt = Math.min(0.1, last ? t - last : 0);
    last = t;
    if (!net) return;
    const boost = drive ? 3 : 1;
    for (let k = 0; k < agents.length; k++) {
      const a = agents[k];
      const p = advance(net, a, a.speed * dt * (a.car ? boost : 1));
      if (a.car) {
        o.position.set(p.x, 0, p.z);
        o.rotation.set(0, p.ang, 0);
        o.scale.setScalar(1);
        o.updateMatrix();
        cars.setMatrixAt(k, o.matrix);
        o.position.y = 0.25;
        o.scale.setScalar(drive ? 1.7 : 1);
        o.updateMatrix();
        glow.setMatrixAt(k, o.matrix);
      } else {
        o.position.set(p.x, Math.abs(Math.sin(t * 7 + a.phase)) * 0.35, p.z);
        o.rotation.set(0, p.ang, 0);
        o.scale.setScalar(1);
        o.updateMatrix();
        people.setMatrixAt(k - N_CARS, o.matrix);
      }
    }
    cars.instanceMatrix.needsUpdate = glow.instanceMatrix.needsUpdate = people.instanceMatrix.needsUpdate = true;
  }

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
      startSynth();
      toast('<b>1147 · Ночной заезд</b><span>В эфире «Кружево FM 87,5» — синтвейв над Вологдой с 1147 года.</span><small>Набери 1147 ещё раз, чтобы заглушить мотор.</small>');
    } else {
      stopSynth();
      toast('<b>Заезд окончен</b><span>Вологда снова спит.</span>');
    }
  });

  return { group, update };
}
