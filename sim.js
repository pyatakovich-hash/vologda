/**
 * Режим стройки: зонирование, рост зданий, свои дороги, снос и застройка, бюджет и жители,
 * а ещё фото фасадов с Викисклада (Wikidata → Wikimedia Commons → атлас 8×8 на стенах зданий).
 * Механики — по мотивам градостроительных симуляторов; оформление своё, неоновое.
 */
import * as THREE from './vendor/three.module.js';
import { NEON, isWater } from './vice.js';

const proj4 = window.proj4;

// ---------- Константы ----------
const ZC = 10, ZHALF = 4000, ZN = Math.ceil(2 * ZHALF / ZC); // сетка зон: клетка 10 м
const ZONE = {
  1: { name: 'Жилая зона', short: 'Ж', color: '#3dff9a', palette: ['#ffb15e', '#ff7eb3', '#9b5cff', '#e9dcff', '#7dffb2', '#ffd36b'] },
  2: { name: 'Коммерция', short: 'К', color: '#1fe5ff', palette: ['#1fe5ff', '#6fd3ff', '#b3f4ff', '#ff2d95'] },
  3: { name: 'Промзона', short: 'П', color: '#ffe45c', palette: ['#c9b27c', '#9a8f7a', '#b8a24a', '#8a7f9a'] },
};
const CATALOG = {
  khrush: { name: 'Хрущёвка', done: 'построена', zone: 1, w: 12, d: 48, floors: 5, res: 80, cost: 250000 },
  panel: { name: 'Панелька', done: 'построена', zone: 1, w: 13, d: 64, floors: 9, res: 216, cost: 600000 },
  shop: { name: 'Магазин у дома', done: 'построен', zone: 2, w: 16, d: 16, floors: 1, jobs: 12, cost: 120000 },
  plant: { name: 'Завод', done: 'построен', zone: 3, w: 40, d: 30, floors: 2, jobs: 150, cost: 400000 },
  park: { name: 'Парк', done: 'разбит', zone: 0, w: 30, d: 30, floors: 0, cost: 80000 },
};
const ROAD_COST = 400, DEMOLISH_COST = 30000, REFUND = 0.5, BRUSH = 18;
const BASE = { pop: 300000, cJobs: 60000, iJobs: 50000, other: 80000 };
const MONTHS = ['январь', 'февраль', 'март', 'апрель', 'май', 'июнь', 'июль', 'август', 'сентябрь', 'октябрь', 'ноябрь', 'декабрь'];
const fmt = n => Math.round(n).toLocaleString('ru');

// ---------- Материал выросших зданий: окна, витрины, профлист ----------
function growMaterial(uniforms, kind) {
  return new THREE.ShaderMaterial({
    glslVersion: THREE.GLSL3,
    uniforms: { uFogColor: uniforms.uFogColor, uFog: uniforms.uFog, uKind: { value: kind } },
    vertexShader: /* glsl */`
      out vec3 vWorld;
      out vec3 vColor;
      out float vBase;
      void main() {
        vec4 w = modelMatrix * instanceMatrix * vec4(position, 1.0);
        vWorld = w.xyz;
        #ifdef USE_INSTANCING_COLOR
          vColor = instanceColor;
        #else
          vColor = vec3(1.0);
        #endif
        vBase = (modelMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0)).y;
        gl_Position = projectionMatrix * viewMatrix * w;
      }`,
    fragmentShader: /* glsl */`
      precision highp float;
      uniform vec3 uFogColor;
      uniform vec2 uFog;
      uniform float uKind;
      in vec3 vWorld;
      in vec3 vColor;
      in float vBase;
      out vec4 outColor;
      float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
      void main() {
        vec3 n = normalize(cross(dFdx(vWorld), dFdy(vWorld)));
        float sun = max(dot(n, normalize(vec3(-0.55, 0.55, 0.62))), 0.0);
        vec3 c = vColor * (n.y > 0.9 ? 1.04 : 0.66 + 0.34 * sun);
        float hy = vWorld.y - vBase;
        if (abs(n.y) < 0.3 && hy > 0.6) {
          vec2 t = normalize(vec2(-n.z, n.x));
          float u = dot(vWorld.xz, t);
          if (uKind < 1.5) {
            float fu = fract(u / 3.2), fv = fract(hy / 2.9);
            float win = step(0.25, fu) * step(fu, 0.72) * step(0.3, fv) * step(fv, 0.78);
            float h = hash(floor(vec2(u / 3.2, hy / 2.9)));
            vec3 lit = h > 0.93 ? vec3(1.0, 0.3, 0.7) : vec3(1.0, 0.8, 0.5);
            c = mix(c * 0.75, mix(vec3(0.07, 0.04, 0.13), lit, step(0.45, h)), win);
          } else if (uKind < 2.5) {
            float fu = fract(u / 6.0);
            float shop = step(hy, 3.0) * step(0.5, hy) * step(0.1, fu) * step(fu, 0.92);
            c = mix(c * 0.8, vec3(1.0, 0.86, 0.62), shop);
            c = mix(c, vec3(0.2, 0.95, 1.0) * 1.3, step(abs(hy - 3.5), 0.22));
          } else {
            c *= 0.84 + 0.16 * step(0.5, fract(u / 0.9));
            float win = step(abs(hy - 4.2), 0.5) * step(0.2, fract(u / 5.0)) * step(fract(u / 5.0), 0.8);
            c = mix(c, vec3(0.95, 0.88, 0.5), win * 0.8);
          }
        }
        float d = length(vWorld - cameraPosition);
        c = mix(c, uFogColor, smoothstep(uFog.x, uFog.y, d));
        outColor = vec4(c, 1.0);
      }`,
  });
}

function vcolor(g, rgb) {
  g = g.index ? g.toNonIndexed() : g;
  const n = g.attributes.normal, col = new Float32Array(n.count * 3);
  for (let i = 0; i < n.count; i++) { const k = 0.6 + 0.4 * Math.max(0, n.getY(i)) + 0.1 * n.getX(i); col.set([rgb[0] * k, rgb[1] * k, rgb[2] * k], i * 3); }
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  return g;
}
function mergeColored(parts) {
  const pos = [], col = [];
  for (const p of parts) { for (const v of p.attributes.position.array) pos.push(v); for (const v of p.attributes.color.array) col.push(v); }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  return g;
}

export function initSim({ scene, camera, controls, canvas, uniforms, pick, building, getMeshes, config, vice }) {
  const group = new THREE.Group();
  group.name = 'sim';
  group.userData.noPick = true;
  scene.add(group);
  const H = (x, z) => vice.H(x, z);
  const o = new THREE.Object3D(), col = new THREE.Color();

  // ---------- Состояние ----------
  const S = {
    active: false, started: false, tool: null, money: 2000000, month: 2026 * 12 + 10,
    addRes: 0, lostRes: 0, addC: 0, addI: 0, lostJobs: 0, parks: 0, roadLen: 0,
    tax: { r: 9, c: 9, i: 9 }, happy: 72, demand: { r: 0.6, c: 0.5, i: 0.4 }, balance: 0, rot: 0,
  };
  const zone = new Uint8Array(ZN * ZN), occ = new Uint8Array(ZN * ZN), road = new Uint8Array(ZN * ZN), served = new Uint8Array(ZN * ZN);
  const zoned = new Set();
  const zi = (x, z) => { const ix = Math.floor((x + ZHALF) / ZC), iz = Math.floor((z + ZHALF) / ZC); return ix < 0 || iz < 0 || ix >= ZN || iz >= ZN ? -1 : iz * ZN + ix; };
  const zc = ci => [(ci % ZN + 0.5) * ZC - ZHALF, (Math.floor(ci / ZN) + 0.5) * ZC - ZHALF];

  // ---------- Дороги в сетке зон: где асфальт и какие клетки «у дороги» ----------
  function markRoads(ways) {
    for (const w of ways) {
      if (w.f) continue;
      const half = w.k === 2 ? 7.5 : 4.5;
      for (let i = 2; i < w.p.length; i += 2) {
        const ax = w.p[i - 2], az = w.p[i - 1], bx = w.p[i], bz = w.p[i + 1], L = Math.hypot(bx - ax, bz - az), k = Math.max(1, Math.ceil(L / 3));
        for (let j = 0; j <= k; j++) {
          const x = ax + (bx - ax) * j / k, z = az + (bz - az) * j / k;
          for (const dx of [-half, 0, half]) for (const dz of [-half, 0, half]) { const c = zi(x + dx, z + dz); if (c >= 0) road[c] = 1; }
          const ci = zi(x, z);
          if (ci < 0) continue;
          const ix = ci % ZN, iz = Math.floor(ci / ZN);
          for (let a = -3; a <= 3; a++) for (let b = -3; b <= 3; b++) { const xx = ix + a, zz = iz + b; if (xx >= 0 && zz >= 0 && xx < ZN && zz < ZN) served[zz * ZN + xx] = 1; }
        }
      }
    }
  }
  const freeCell = ci => {
    if (ci < 0 || road[ci] || occ[ci]) return false;
    const [x, z] = zc(ci);
    if (isWater(x, z)) return false;
    for (const [dx, dz] of [[0, 0], [-3, -3], [3, -3], [-3, 3], [3, 3]]) if (vice.blocked(x + dx, z + dz)) return false;
    return true;
  };

  // ---------- Слой зон (полупрозрачные клетки) ----------
  const MAXZ = 40000;
  const zoneMesh = new THREE.InstancedMesh(new THREE.PlaneGeometry(ZC * 0.92, ZC * 0.92).rotateX(-Math.PI / 2),
    new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.5, depthWrite: false }), MAXZ);
  zoneMesh.count = 0; zoneMesh.frustumCulled = false; zoneMesh.renderOrder = 2;
  zoneMesh.setColorAt(0, col.set('#fff'));
  group.add(zoneMesh);
  let zoneDirty = false;
  function redrawZones() {
    let k = 0;
    for (const ci of zoned) {
      if (k >= MAXZ) break;
      if (occ[ci]) continue;
      const [x, z] = zc(ci);
      o.position.set(x, H(x, z) + 0.35, z); o.rotation.set(0, 0, 0); o.scale.setScalar(1); o.updateMatrix();
      zoneMesh.setMatrixAt(k, o.matrix);
      zoneMesh.setColorAt(k, col.set(ZONE[zone[ci]].color));
      k++;
    }
    zoneMesh.count = k;
    zoneMesh.instanceMatrix.needsUpdate = true;
    if (zoneMesh.instanceColor) zoneMesh.instanceColor.needsUpdate = true;
    zoneDirty = false;
  }
  function paintZone(x, z, type) {
    const ci0 = zi(x, z);
    if (ci0 < 0) return;
    const r = Math.ceil(BRUSH / ZC), ix0 = ci0 % ZN, iz0 = Math.floor(ci0 / ZN);
    for (let a = -r; a <= r; a++) for (let b = -r; b <= r; b++) {
      if ((a * a + b * b) * ZC * ZC > BRUSH * BRUSH) continue;
      const ix = ix0 + a, iz = iz0 + b;
      if (ix < 0 || iz < 0 || ix >= ZN || iz >= ZN) continue;
      const ci = iz * ZN + ix;
      if (type === 0) { if (zone[ci] && !occ[ci]) { zone[ci] = 0; zoned.delete(ci); zoneDirty = true; } continue; }
      if (!freeCell(ci)) continue;
      if (zone[ci] !== type) { zone[ci] = type; zoned.add(ci); zoneDirty = true; }
    }
  }

  // ---------- Здания игрока (выросшие и поставленные) ----------
  const MAXB = 4000;
  const box = new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0);
  const bMesh = {};
  for (const k of [1, 2, 3]) {
    const m = new THREE.InstancedMesh(box, growMaterial(uniforms, k), MAXB);
    m.setColorAt(0, col.set('#fff'));
    m.count = 0; m.frustumCulled = false;
    group.add(m);
    bMesh[k] = { mesh: m, list: [] };
  }
  const chimneyMesh = new THREE.InstancedMesh(mergeColored([
    vcolor(new THREE.CylinderGeometry(1.1, 1.6, 18, 10).translate(0, 9, 0), [0.55, 0.5, 0.6]),
    vcolor(new THREE.CylinderGeometry(1.15, 1.15, 1.6, 10).translate(0, 15, 0), [1.0, 0.25, 0.4]),
  ]), new THREE.MeshBasicMaterial({ vertexColors: true }), MAXB);
  chimneyMesh.count = 0; chimneyMesh.frustumCulled = false; group.add(chimneyMesh);
  const chimneys = [];
  // Парк: газон и деревья.
  const parkMesh = new THREE.InstancedMesh(mergeColored([
    vcolor(new THREE.BoxGeometry(30, 0.3, 30).translate(0, 0.15, 0), [0.12, 0.55, 0.32]),
    ...[[-8, -8], [8, -6], [-6, 9], [9, 8], [0, 0]].flatMap(([x, z]) => [
      vcolor(new THREE.CylinderGeometry(0.4, 0.5, 3, 6).translate(x, 1.8, z), [0.45, 0.3, 0.25]),
      vcolor(new THREE.ConeGeometry(3, 7, 8).translate(x, 6, z), [0.15, 0.75, 0.5]),
    ]),
  ]), new THREE.MeshBasicMaterial({ vertexColors: true }), 500);
  parkMesh.count = 0; parkMesh.frustumCulled = false; group.add(parkMesh);
  const parks = [];

  function setInstance(b) {
    const k = bMesh[b.kind];
    const grow = Math.min(1, (performance.now() - b.born) / 1800);
    o.position.set(b.x, b.y, b.z); o.rotation.set(0, b.rot, 0);
    o.scale.set(b.w, Math.max(0.3, b.h * grow), b.d); o.updateMatrix();
    k.mesh.setMatrixAt(b.inst, o.matrix);
    k.mesh.instanceMatrix.needsUpdate = true;
    return grow < 1;
  }
  const growing = new Set();
  function occupy(b, v) {
    const w = b.rot ? b.d : b.w, d = b.rot ? b.w : b.d;
    for (let x = b.x - w / 2 + 2; x < b.x + w / 2; x += ZC / 2) for (let z = b.z - d / 2 + 2; z < b.z + d / 2; z += ZC / 2) { const c = zi(x, z); if (c >= 0) occ[c] = v; }
    vice.setCells(b.x - w / 2, b.z - d / 2, b.x + w / 2, b.z + d / 2, v ? 1 : 0); // в дом теперь нельзя въехать
    zoneDirty = true;
  }
  function addBuilding(spec) {
    const k = bMesh[spec.kind];
    if (k.list.length >= MAXB) return null;
    const b = { ...spec, y: H(spec.x, spec.z), inst: k.list.length, born: performance.now() };
    k.list.push(b);
    k.mesh.count = k.list.length;
    k.mesh.setColorAt(b.inst, col.set(b.color));
    k.mesh.instanceColor.needsUpdate = true;
    growing.add(b);
    setInstance(b);
    occupy(b, 1);
    if (b.kind === 3 && b.chimney) {
      b.ch = chimneys.length;
      chimneys.push(b);
      o.position.set(b.x + (b.rot ? b.d : b.w) * 0.3, b.y + b.h, b.z + (b.rot ? b.w : b.d) * 0.25); o.rotation.set(0, 0, 0); o.scale.setScalar(1); o.updateMatrix();
      chimneyMesh.setMatrixAt(b.ch, o.matrix); chimneyMesh.count = chimneys.length; chimneyMesh.instanceMatrix.needsUpdate = true;
    }
    if (b.kind === 1) S.addRes += b.res || 0;
    if (b.kind === 2) S.addC += b.jobs || 0;
    if (b.kind === 3) S.addI += b.jobs || 0;
    return b;
  }
  function removeBuilding(b) {
    const k = bMesh[b.kind], last = k.list.pop();
    if (last !== b) { last.inst = b.inst; k.list[b.inst] = last; setInstance(last); k.mesh.setColorAt(last.inst, col.set(last.color)); k.mesh.instanceColor.needsUpdate = true; }
    k.mesh.count = k.list.length;
    growing.delete(b);
    occupy(b, 0);
    if (b.ch !== undefined) { o.position.set(0, -1e4, 0); o.scale.setScalar(0); o.updateMatrix(); chimneyMesh.setMatrixAt(b.ch, o.matrix); chimneyMesh.instanceMatrix.needsUpdate = true; }
    if (b.kind === 1) S.addRes -= b.res || 0;
    if (b.kind === 2) S.addC -= b.jobs || 0;
    if (b.kind === 3) S.addI -= b.jobs || 0;
  }
  function addPark(x, z, rot) {
    const p = { x, z, rot, i: parks.length, w: 30, d: 30 };
    parks.push(p);
    o.position.set(x, H(x, z), z); o.rotation.set(0, rot, 0); o.scale.setScalar(1); o.updateMatrix();
    parkMesh.setMatrixAt(p.i, o.matrix); parkMesh.count = parks.length; parkMesh.instanceMatrix.needsUpdate = true;
    vice.setCells(x - 15, z - 15, x + 15, z + 15, 0);
    for (let xx = x - 13; xx < x + 15; xx += 5) for (let zz = z - 13; zz < z + 15; zz += 5) { const c = zi(xx, zz); if (c >= 0) occ[c] = 1; }
    S.parks++;
    zoneDirty = true;
  }

  // ---------- Рост зданий в зонах ----------
  function tryGrow(type) {
    if (!zoned.size) return;
    const cells = [...zoned].filter(ci => zone[ci] === type && !occ[ci] && served[ci]);
    if (!cells.length) return;
    for (let attempt = 0; attempt < 6; attempt++) {
      const ci = cells[Math.floor(Math.random() * cells.length)], ix = ci % ZN, iz = Math.floor(ci / ZN);
      if (ix + 1 >= ZN || iz + 1 >= ZN) continue;
      const lot = [ci, ci + 1, ci + ZN, ci + ZN + 1];
      if (!lot.every(c => zone[c] === type && !occ[c] && freeCell(c))) continue;
      const [x0, z0] = zc(ci), x = x0 + ZC / 2, z = z0 + ZC / 2;
      const pal = ZONE[type].palette, color = pal[Math.floor(Math.random() * pal.length)];
      if (type === 1) {
        const floors = S.happy > 70 && Math.random() < 0.25 ? 9 : 2 + Math.floor(Math.random() * 4);
        addBuilding({ kind: 1, x, z, w: 16, d: 16, h: floors * 3, rot: 0, res: floors * 8, color });
      } else if (type === 2) {
        const floors = 1 + Math.floor(Math.random() * 3);
        addBuilding({ kind: 2, x, z, w: 16, d: 16, h: floors * 3.6, rot: 0, jobs: floors * 6, color });
      } else {
        addBuilding({ kind: 3, x, z, w: 18, d: 18, h: 6 + Math.random() * 4, rot: 0, jobs: 30, color, chimney: Math.random() < 0.5 });
      }
      return;
    }
  }

  // ---------- Бюджет, спрос, счастье ----------
  function economy() {
    const res = BASE.pop + S.addRes - S.lostRes;
    const cJobs = BASE.cJobs + S.addC, iJobs = BASE.iJobs + S.addI - S.lostJobs;
    const t = S.tax;
    const income = res * t.r / 100 * 12 + cJobs * t.c / 100 * 30 + iJobs * t.i / 100 * 30;
    const expense = 520000 + S.roadLen * 30 + S.parks * 3000;
    S.balance = income - expense;
    const workers = res * 0.62;
    const clamp = v => Math.max(-1, Math.min(1, v));
    S.demand.r = clamp(((cJobs + iJobs + BASE.other) - workers) / 20000 + 0.45 - (t.r - 9) * 0.07 + (S.happy - 60) / 80);
    S.demand.c = clamp((res * 0.21 - cJobs) / 12000 + 0.35 - (t.c - 9) * 0.07);
    S.demand.i = clamp((cJobs * 0.85 - iJobs) / 8000 + 0.3 - (t.i - 9) * 0.07);
    // Загрязнение: жилые дома в 150 м от промзоны.
    let smog = 0;
    for (const f of bMesh[3].list) for (const h of bMesh[1].list) if (Math.abs(f.x - h.x) < 150 && Math.abs(f.z - h.z) < 150) smog++;
    const avgTax = (t.r + t.c + t.i) / 3;
    S.happy = Math.max(5, Math.min(99, 72 - (avgTax - 9) * 4 + S.parks * 1.5 - smog * 0.4 - (S.money < 0 ? 10 : 0) - Math.max(0, S.demand.c) * 6));
    return { res, cJobs, iJobs };
  }
  function monthTick() {
    const { res } = economy();
    if (S.happy < 40) S.lostRes += Math.round(res * 0.002 * (40 - S.happy) / 20); // недовольные уезжают — раз в месяц
    if (S.happy > 80 && S.lostRes > 0) S.lostRes = Math.max(0, S.lostRes - Math.round(res * 0.001)); // довольные возвращаются
    S.money += S.balance;
    S.month++;
    renderHud();
  }

  // ---------- Центры зданий (для фото и сноса) ----------
  let centroids = null;
  function computeCentroids() {
    const n = config.stats.buildings, acc = new Float64Array(n * 3);
    for (const m of getMeshes()) {
      const p = m.geometry.attributes.position.array, b = m.geometry.attributes.bld.array;
      const data = (m.userData.draw || m.material).uniforms.uAttr.value.image.data, sc = m.scale.x, ox = m.position.x, oz = m.position.z;
      for (let v = 0; v < b.length; v++) {
        const gid = data[b[v] * 8 + 3];
        acc[gid * 3] += p[v * 3] * sc + ox; acc[gid * 3 + 1] += p[v * 3 + 2] * sc + oz; acc[gid * 3 + 2]++;
      }
    }
    centroids = new Float32Array(n * 2);
    for (let g = 0; g < n; g++) { const c = acc[g * 3 + 2] || 1; centroids[g * 2] = acc[g * 3] / c; centroids[g * 2 + 1] = acc[g * 3 + 1] / c; }
  }
  function demolishOriginal(gid) {
    const data = uniforms.uBld.value.image.data;
    if (data[gid * 4] === 255) return false;
    data[gid * 4] = 255;
    uniforms.uBld.value.needsUpdate = true;
    // Освобождаем клетки сетки столкновений по треугольникам этого дома.
    const G = vice.grid;
    let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
    for (const m of getMeshes()) {
      const p = m.geometry.attributes.position.array, b = m.geometry.attributes.bld.array;
      const attr = (m.userData.draw || m.material).uniforms.uAttr.value.image.data, sc = m.scale.x, ox = m.position.x, oz = m.position.z;
      for (let v = 0; v < b.length; v++) {
        if (attr[b[v] * 8 + 3] !== gid) continue;
        const x = p[v * 3] * sc + ox, z = p[v * 3 + 2] * sc + oz;
        x0 = Math.min(x0, x); x1 = Math.max(x1, x); z0 = Math.min(z0, z); z1 = Math.max(z1, z);
      }
    }
    if (x0 < x1 && G.cells) vice.setCells(x0, z0, x1, z1, 0);
    const cx = centroids ? centroids[gid * 2] : (x0 + x1) / 2, cz = centroids ? centroids[gid * 2 + 1] : (z0 + z1) / 2;
    vice.hideLandmarksNear(cx, cz, Math.max(12, Math.hypot(x1 - x0, z1 - z0) / 2 + 6));
    const bd = building(gid), floors = Math.max(1, Math.round(bd.height / 3));
    if (bd.groups.some(g => g.bit === 11)) S.lostRes += floors * 18; else S.lostJobs += floors * 6;
    return true;
  }

  // ---------- Фото с Викисклада ----------
  async function loadPhotos() {
    const KEY = 'vologda-photos-v2', N = 8, CELL = 512;
    let list = null;
    try { list = JSON.parse(localStorage.getItem(KEY) || 'null'); } catch { /* нет хранилища */ }
    if (!list) {
      const [lon0, lat0] = proj4('EPSG:32637', 'EPSG:4326', config.origin);
      const q = `SELECT ?item ?itemLabel ?coord ?image WHERE {
        SERVICE wikibase:around { ?item wdt:P625 ?coord . bd:serviceParam wikibase:center "Point(${lon0} ${lat0})"^^geo:wktLiteral . bd:serviceParam wikibase:radius "4.5" . }
        ?item wdt:P18 ?image .
        SERVICE wikibase:label { bd:serviceParam wikibase:language "ru,en". } } LIMIT 3000`;
      const r = await fetch('https://query.wikidata.org/sparql?format=json&query=' + encodeURIComponent(q), { headers: { Accept: 'application/sparql-results+json' } });
      const rows = (await r.json()).results.bindings;
      // Ближайшее здание в 25 м; улицы, памятники, реки и т. п. пропускаем.
      const skip = /улиц|проспект|площад|набережн|мост|сквер|парк|памятник|бюст|скульптур|стела|река|озер|район|кладбищ|переулок|бульвар|остров|сад\b/i;
      const hash = new Map();
      for (let g = 0; g < centroids.length / 2; g++) { const k = `${Math.floor(centroids[g * 2] / 50)},${Math.floor(centroids[g * 2 + 1] / 50)}`; if (!hash.has(k)) hash.set(k, []); hash.get(k).push(g); }
      const seen = new Set(), picks = [];
      for (const row of rows) {
        if (skip.test(row.itemLabel?.value || '')) continue;
        const m = /Point\(([-\d.]+) ([-\d.]+)\)/.exec(row.coord.value);
        if (!m) continue;
        const [e, nn] = proj4('EPSG:4326', 'EPSG:32637', [+m[1], +m[2]]), x = e - config.origin[0], z = config.origin[1] - nn;
        let best = -1, bd = 18;
        for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) for (const g of hash.get(`${Math.floor(x / 50) + a},${Math.floor(z / 50) + b}`) || []) {
          const d = Math.hypot(centroids[g * 2] - x, centroids[g * 2 + 1] - z);
          if (d < bd) { bd = d; best = g; }
        }
        if (best < 0 || seen.has(best)) continue;
        seen.add(best);
        picks.push({ gid: best, file: decodeURIComponent(row.image.value.split('/').pop()), d: Math.hypot(x, z), label: row.itemLabel?.value });
      }
      picks.sort((a, b) => a.d - b.d);
      list = picks.slice(0, N * N);
      // Ссылки на превью (512 px) через API Викисклада, по 40 файлов за запрос.
      for (let i = 0; i < list.length; i += 40) {
        const part = list.slice(i, i + 40), titles = part.map(p => 'File:' + p.file).join('|');
        const j = await fetch('https://commons.wikimedia.org/w/api.php?action=query&format=json&origin=*&prop=imageinfo&iiprop=url&iiurlwidth=512&titles=' + encodeURIComponent(titles)).then(r => r.json());
        const byTitle = new Map(Object.values(j.query?.pages || {}).map(pg => [pg.title, pg.imageinfo?.[0]?.thumburl]));
        const norm = new Map((j.query?.normalized || []).map(n => [n.from, n.to]));
        for (const p of part) { const t = 'File:' + p.file; p.url = byTitle.get(norm.get(t) || t) || byTitle.get(t.replace(/_/g, ' ')); }
      }
      list = list.filter(p => p.url);
      try { localStorage.setItem(KEY, JSON.stringify(list)); } catch { /* не страшно */ }
    }
    const atlas = document.createElement('canvas');
    atlas.width = atlas.height = N * CELL;
    const ctx = atlas.getContext('2d');
    ctx.fillStyle = '#20103a'; ctx.fillRect(0, 0, atlas.width, atlas.height);
    const data = uniforms.uBld.value.image.data;
    let ok = 0;
    await Promise.all(list.map((p, slot) => new Promise(done => {
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.onload = () => {
        const s = Math.min(img.width, img.height * 1.4), sx = (img.width - s) / 2, sh = s / 1.4, sy = Math.max(0, (img.height - sh) * 0.45);
        ctx.drawImage(img, sx, sy, s, sh, (slot % N) * CELL, Math.floor(slot / N) * CELL, CELL, CELL);
        data[p.gid * 4 + 1] = slot + 1;
        ok++;
        done();
      };
      img.onerror = done;
      img.src = p.url;
    })));
    const tex = new THREE.CanvasTexture(atlas);
    tex.colorSpace = THREE.NoColorSpace;
    tex.anisotropy = 4;
    uniforms.uAtlas.value = tex;
    uniforms.uAtlasN.value = N;
    uniforms.uBld.value.needsUpdate = true;
    console.log(`sim: фото Викисклада на ${ok} зданиях`);
    S.photos = list;
  }

  // ---------- Интерфейс ----------
  const hud = document.createElement('div');
  hud.className = 'sim-hud';
  hud.innerHTML = `<div class="sim-date"></div><div class="sim-money"><b></b><small></small></div>
    <div class="sim-row"><span>Жители</span><b class="sim-pop"></b></div>
    <div class="sim-row"><span>Счастье</span><b class="sim-happy"></b></div>
    <div class="sim-rci" title="Спрос: жильё, коммерция, промышленность">${[1, 2, 3].map(k => `<div><i style="--c:${ZONE[k].color}"><s></s></i><span>${ZONE[k].short}</span></div>`).join('')}</div>`;
  document.body.append(hud);
  const TOOLS = [
    ['road', '1', 'Дорога', `${ROAD_COST} ₽/м · клик — точка, двойной клик или Enter — достроить`],
    ['z1', '2', 'Жилая', 'Кисть: красьте свободную землю у дорог, дома вырастут сами'],
    ['z2', '3', 'Коммерция', 'Кисть: магазины и офисы'],
    ['z3', '4', 'Промзона', 'Кисть: склады и заводы; рядом с жильём портят настроение'],
    ['khrush', '5', 'Хрущёвка', `${fmt(CATALOG.khrush.cost)} ₽ · R — повернуть`],
    ['panel', '6', 'Панелька', `${fmt(CATALOG.panel.cost)} ₽ · R — повернуть`],
    ['shop', '7', 'Магазин', `${fmt(CATALOG.shop.cost)} ₽`],
    ['plant', '8', 'Завод', `${fmt(CATALOG.plant.cost)} ₽ · R — повернуть`],
    ['park', '9', 'Парк', `${fmt(CATALOG.park.cost)} ₽ · повышает счастье`],
    ['bulldoze', 'X', 'Снос', `Снос старого здания — ${fmt(DEMOLISH_COST)} ₽; своё — возврат половины; по зоне — стереть зону`],
  ];
  const bar = document.createElement('div');
  bar.className = 'sim-bar';
  bar.innerHTML = TOOLS.map(([id, key, label]) => `<button data-tool="${id}"><kbd>${key}</kbd>${label}</button>`).join('')
    + `<button data-tool="tax"><kbd>T</kbd>Налоги</button>`;
  document.body.append(bar);
  const tax = document.createElement('div');
  tax.className = 'sim-tax';
  tax.hidden = true;
  tax.innerHTML = [['r', 'Жильё'], ['c', 'Коммерция'], ['i', 'Промышленность']].map(([k, l]) =>
    `<label>${l}<input type="range" min="1" max="29" value="9" data-tax="${k}"><output>9%</output></label>`).join('');
  document.body.append(tax);
  const hint = document.createElement('p');
  hint.className = 'sim-hint';
  document.body.append(hint);
  const btn = document.createElement('button');
  btn.className = 'build-btn';
  btn.textContent = 'Стройка (B)';
  document.body.append(btn);

  function renderHud() {
    const { res } = economy();
    const m = S.month;
    hud.querySelector('.sim-date').textContent = `${MONTHS[m % 12]} ${Math.floor(m / 12)}`;
    hud.querySelector('.sim-money b').textContent = `₽ ${fmt(S.money)}`;
    hud.querySelector('.sim-money b').classList.toggle('neg', S.money < 0);
    hud.querySelector('.sim-money small').textContent = `${S.balance >= 0 ? '+' : '−'}${fmt(Math.abs(S.balance))} ₽/мес`;
    hud.querySelector('.sim-pop').textContent = fmt(res);
    hud.querySelector('.sim-happy').textContent = `${Math.round(S.happy)}%`;
    const d = [S.demand.r, S.demand.c, S.demand.i];
    hud.querySelectorAll('.sim-rci s').forEach((el, i) => { el.style.height = `${Math.abs(d[i]) * 50}%`; el.classList.toggle('neg', d[i] < 0); });
  }
  function say(text, bad) { hint.textContent = text; hint.classList.toggle('bad', !!bad); }
  function selectTool(id) {
    if (id === 'tax') { tax.hidden = !tax.hidden; return; }
    S.tool = S.tool === id ? null : id;
    roadPts.length = 0;
    bar.querySelectorAll('button[data-tool]').forEach(b => b.setAttribute('aria-pressed', b.dataset.tool === S.tool));
    const t = TOOLS.find(t => t[0] === S.tool);
    say(t ? `${t[2]}: ${t[3]}` : 'Выберите инструмент. Правая кнопка — сдвинуть карту, колесо — масштаб.');
    updateGhost();
  }
  bar.addEventListener('click', e => { const b = e.target.closest('button[data-tool]'); if (b) selectTool(b.dataset.tool); });
  tax.addEventListener('input', e => {
    const k = e.target.dataset.tax;
    if (!k) return;
    S.tax[k] = +e.target.value;
    e.target.nextElementSibling.textContent = `${e.target.value}%`;
    renderHud();
  });

  // ---------- Призраки: кисть, контур постройки, линия дороги ----------
  const ring = new THREE.Mesh(new THREE.RingGeometry(BRUSH - 1.2, BRUSH, 48).rotateX(-Math.PI / 2),
    new THREE.MeshBasicMaterial({ color: '#ffffff', transparent: true, opacity: 0.9, depthTest: false }));
  ring.renderOrder = 10; ring.visible = false; group.add(ring);
  const ghost = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0),
    new THREE.MeshBasicMaterial({ color: '#3dff9a', transparent: true, opacity: 0.45, depthWrite: false }));
  ghost.renderOrder = 9; ghost.visible = false; group.add(ghost);
  const roadLine = new THREE.Line(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ color: NEON.cyan, depthTest: false }));
  roadLine.renderOrder = 10; roadLine.visible = false; group.add(roadLine);
  const roadPts = [];
  let cursor = null;

  const spec = id => CATALOG[id];
  const fits = (x, z, w, d) => {
    for (let a = x - w / 2 + 1; a <= x + w / 2 - 1; a += 3) for (let b = z - d / 2 + 1; b <= z + d / 2 - 1; b += 3) {
      if (vice.blocked(a, b) || isWater(a, b)) return false;
      const c = zi(a, b);
      if (c < 0 || occ[c] || road[c]) return false;
    }
    return true;
  };
  function updateGhost() {
    ring.visible = ghost.visible = roadLine.visible = false;
    if (!S.active || !cursor) return;
    const t = S.tool;
    if (t === 'z1' || t === 'z2' || t === 'z3' || t === 'bulldoze') {
      ring.visible = true;
      ring.position.set(cursor.x, H(cursor.x, cursor.z) + 0.6, cursor.z);
      ring.material.color.set(t === 'bulldoze' ? '#ff3355' : ZONE[+t[1]].color);
    } else if (spec(t)) {
      const s = spec(t), w = S.rot ? s.d : s.w, d = S.rot ? s.w : s.d;
      ghost.visible = true;
      ghost.position.set(cursor.x, H(cursor.x, cursor.z), cursor.z);
      ghost.scale.set(w, Math.max(1, s.floors * 3), d);
      ghost.material.color.set(fits(cursor.x, cursor.z, w, d) && S.money >= s.cost ? '#3dff9a' : '#ff3355');
    } else if (t === 'road' && roadPts.length) {
      const pts = [];
      for (let i = 0; i < roadPts.length; i += 2) pts.push(new THREE.Vector3(roadPts[i], H(roadPts[i], roadPts[i + 1]) + 1.5, roadPts[i + 1]));
      pts.push(new THREE.Vector3(cursor.x, H(cursor.x, cursor.z) + 1.5, cursor.z));
      roadLine.geometry.setFromPoints(pts);
      roadLine.visible = true;
      let len = 0;
      for (let i = 1; i < pts.length; i++) len += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].z - pts[i - 1].z);
      say(`Дорога: ${Math.round(len)} м · ${fmt(len * ROAD_COST)} ₽ · двойной клик или Enter — достроить, Esc — отмена`);
    }
  }

  // ---------- Действия ----------
  const raycaster = new THREE.Raycaster(), ndc = new THREE.Vector2();
  function groundAt(e) {
    const r = canvas.getBoundingClientRect();
    ndc.set((e.clientX - r.left) / r.width * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    camera.updateMatrixWorld();
    raycaster.setFromCamera(ndc, camera);
    const or = raycaster.ray.origin, d = raycaster.ray.direction;
    if (d.y > -1e-4) return null;
    let t = -or.y / d.y;
    for (let k = 0; k < 5; k++) t = (H(or.x + d.x * t, or.z + d.z * t) - or.y) / d.y;
    return { x: or.x + d.x * t, z: or.z + d.z * t };
  }
  function snapRoad(x, z) {
    const net = vice.getNet();
    let best = null, bd = 15;
    for (const w of net?.ways || []) {
      if (w.f) continue;
      for (let i = 0; i < w.p.length; i += 2) { const d = Math.hypot(w.p[i] - x, w.p[i + 1] - z); if (d < bd) { bd = d; best = [w.p[i], w.p[i + 1]]; } }
    }
    return best || [x, z];
  }
  function finishRoad() {
    const pts = [];
    for (let i = 0; i < roadPts.length; i += 2) if (!pts.length || Math.hypot(roadPts[i] - pts[pts.length - 2], roadPts[i + 1] - pts[pts.length - 1]) > 3) pts.push(roadPts[i], roadPts[i + 1]);
    roadPts.length = 0;
    if (pts.length < 4) { updateGhost(); return; }
    let len = 0;
    for (let i = 2; i < pts.length; i += 2) len += Math.hypot(pts[i] - pts[i - 2], pts[i + 1] - pts[i - 1]);
    const cost = len * ROAD_COST;
    if (S.money < cost) { say(`Не хватает денег: дорога стоит ${fmt(cost)} ₽`, true); updateGhost(); return; }
    const w = vice.addWay(pts);
    if (!w) return;
    S.money -= cost; S.roadLen += len;
    markRoads([w]);
    say(`Построено ${Math.round(len)} м дороги за ${fmt(cost)} ₽. Машины уже едут.`);
    renderHud(); updateGhost();
  }
  function bulldoze(p, e) {
    for (const k of [1, 2, 3]) for (const b of bMesh[k].list) {
      const w = b.rot ? b.d : b.w, d = b.rot ? b.w : b.d;
      if (Math.abs(p.x - b.x) <= w / 2 && Math.abs(p.z - b.z) <= d / 2) {
        removeBuilding(b);
        const back = (b.cost || 40000) * REFUND;
        S.money += back;
        say(`Снесено. Возврат ${fmt(back)} ₽.`);
        renderHud();
        return;
      }
    }
    const ci = zi(p.x, p.z);
    if (ci >= 0 && zone[ci] && !occ[ci]) { paintZone(p.x, p.z, 0); say('Зона стёрта.'); return; }
    const gid = pick(e.clientX, e.clientY);
    if (gid < 0) { say('Здесь нечего сносить.'); return; }
    if (S.money < DEMOLISH_COST) { say(`Снос стоит ${fmt(DEMOLISH_COST)} ₽ — не хватает денег`, true); return; }
    if (demolishOriginal(gid)) { S.money -= DEMOLISH_COST; say(`Здание снесено за ${fmt(DEMOLISH_COST)} ₽. Участок можно застроить или отдать под зону.`); renderHud(); }
  }
  function place(id, p) {
    const s = spec(id), w = S.rot ? s.d : s.w, d = S.rot ? s.w : s.d;
    if (S.money < s.cost) { say(`Не хватает денег: ${s.name} стоит ${fmt(s.cost)} ₽`, true); return; }
    if (!fits(p.x, p.z, w, d)) { say('Здесь занято: дом, дорога или вода.', true); return; }
    S.money -= s.cost;
    if (id === 'park') addPark(p.x, p.z, S.rot ? Math.PI / 2 : 0);
    else addBuilding({ kind: s.zone, x: p.x, z: p.z, w: s.w, d: s.d, h: s.floors * (s.zone === 2 ? 3.6 : 3), rot: S.rot ? Math.PI / 2 : 0, res: s.res, jobs: s.jobs, cost: s.cost,
      color: ZONE[s.zone].palette[Math.floor(Math.random() * ZONE[s.zone].palette.length)], chimney: s.zone === 3 });
    say(`${s.name} ${s.done} за ${fmt(s.cost)} ₽.`);
    renderHud();
  }
  let painting = false;
  function act(e, phase) {
    const p = groundAt(e);
    if (!p) return;
    const t = S.tool;
    if (t === 'z1' || t === 'z2' || t === 'z3') { if (phase !== 'up') { painting = true; paintZone(p.x, p.z, +t[1]); } return; }
    if (phase !== 'down') return;
    if (t === 'road') { const [x, z] = snapRoad(p.x, p.z); roadPts.push(x, z); updateGhost(); }
    else if (t === 'bulldoze') bulldoze(p, e);
    else if (spec(t)) place(t, p);
  }

  // Ввод: левая кнопка в режиме стройки — инструмент (карта не вращается), правая — сдвиг, колесо — масштаб.
  canvas.addEventListener('pointerdown', e => {
    if (!S.active || e.button !== 0) return;
    e.stopImmediatePropagation();
    act(e, 'down');
  }, true);
  canvas.addEventListener('pointermove', e => {
    if (!S.active) return;
    cursor = groundAt(e);
    if (painting && e.buttons & 1) act(e, 'drag');
    updateGhost();
  }, true);
  canvas.addEventListener('pointerup', e => {
    if (!S.active || e.button !== 0) return;
    e.stopImmediatePropagation();
    painting = false;
  }, true);
  canvas.addEventListener('dblclick', e => { if (S.active && S.tool === 'road') { e.stopImmediatePropagation(); finishRoad(); } }, true);

  function setActive(on) {
    S.active = on;
    document.body.classList.toggle('building', on);
    btn.textContent = on ? 'Выйти из стройки (B)' : 'Стройка (B)';
    controls.mouseButtons.LEFT = on ? null : THREE.MOUSE.ROTATE;
    if (on) {
      vice.exitDrive();
      if (!S.started) { S.started = true; renderHud(); }
      selectTool(S.tool);
    } else { S.tool = null; roadPts.length = 0; tax.hidden = true; updateGhost(); }
  }
  btn.onclick = () => setActive(!S.active);
  addEventListener('keydown', e => {
    if (e.target.closest?.('input, textarea, [contenteditable]')) return;
    const k = e.key.toLowerCase();
    if ((k === 'b' || k === 'и') && !vice.driving()) { setActive(!S.active); return; }
    if (!S.active) return;
    if (k === 'escape') { if (roadPts.length) { roadPts.length = 0; updateGhost(); say('Дорога отменена.'); } else selectTool(null); return; }
    if (k === 'enter' && S.tool === 'road') { finishRoad(); return; }
    if (k === 'r' || k === 'к') { S.rot = S.rot ? 0 : 1; updateGhost(); return; }
    if (k === 't' || k === 'е') { selectTool('tax'); return; }
    if (k === 'x' || k === 'ч') { selectTool('bulldoze'); return; }
    const t = TOOLS.find(t => t[1] === e.key);
    if (t) selectTool(t[0]);
  });

  // ---------- Цикл ----------
  let lastMonth = 0, lastGrow = 0, ready = false;
  function update(now) {
    if (!ready && vice.ready()) {
      ready = true;
      markRoads(vice.getNet().ways);
      computeCentroids();
      loadPhotos().catch(err => console.warn('sim: фото с Викисклада не загрузились', err));
    }
    for (const b of growing) if (!setInstance(b)) growing.delete(b);
    if (zoneDirty) redrawZones();
    if (!S.started || !ready) return;
    if (now - lastGrow > 1500) {
      lastGrow = now;
      for (const [type, dem] of [[1, S.demand.r], [2, S.demand.c], [3, S.demand.i]]) {
        const tries = dem > 0.15 ? Math.ceil(dem * 3) : 0;
        for (let k = 0; k < tries; k++) tryGrow(type);
      }
    }
    if (now - lastMonth > 4000) { lastMonth = now; monthTick(); }
  }

  return { group, update, active: () => S.active, state: S };
}
