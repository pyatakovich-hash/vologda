/** Подложка CARTO Dark Matter без подписей (raster tiles) в локальной UTM-рамке сцены. */
import * as THREE from './vendor/three.module.js';

const proj4 = window.proj4;
if (!proj4) throw new Error('proj4.js must load before basemap');
proj4.defs('EPSG:32637', '+proj=utm +zone=37 +datum=WGS84 +units=m +no_defs');
proj4.defs('EPSG:3857', '+proj=merc +a=6378137 +b=6378137 +lat_ts=0 +lon_0=0 +x_0=0 +y_0=0 +k=1 +units=m +nadgrids=@null +wktext +no_defs');

// https://carto.com/basemaps — стиль dark_nolabels, тайлы @2x (512 px) для чёткости.
// Без ключа CARTO рисует на тайлах водяной знак «API key required».
// Бесплатный ключ: https://dashboard.basemaps.carto.com (приходит на почту). Вставь его сюда:
export const CARTO_KEY = 'cb1_5cuu_1_2f4e7617ff93502bd97f9381';
const TILE_URL = 'https://basemaps.cartocdn.com/rastertiles/dark_nolabels/{z}/{x}/{y}@2x.png' + (CARTO_KEY ? `?key=${CARTO_KEY}` : '');

function tileBounds3857(z, x, y) {
  const n = 2 ** z;
  const s = 40075016.68557848 / n;
  const minx = -20037508.342789244 + x * s;
  const maxx = minx + s;
  const maxy = 20037508.342789244 - y * s;
  const miny = maxy - s;
  return { minx, miny, maxx, maxy };
}

function toLocal(x3857, y3857, origin) {
  const [e, n] = proj4('EPSG:3857', 'EPSG:32637', [x3857, y3857]);
  return [e - origin[0], origin[1] - n];
}

function lon2tile(lon, z) {
  return Math.floor(((lon + 180) / 360) * 2 ** z);
}

function lat2tile(lat, z) {
  const latRad = (lat * Math.PI) / 180;
  return Math.floor(((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * 2 ** z);
}

async function loadTileTexture(loader, z, x, y) {
  const url = TILE_URL.replace('{z}', z).replace('{x}', x).replace('{y}', y);
  return new Promise((resolve, reject) => {
    loader.load(url, resolve, undefined, reject);
  });
}

function makeTileMesh(b, texture, origin) {
  const x0 = toLocal(b.minx, b.miny, origin);
  const x1 = toLocal(b.maxx, b.miny, origin);
  const x2 = toLocal(b.maxx, b.maxy, origin);
  const x3 = toLocal(b.minx, b.maxy, origin);
  const geom = new THREE.BufferGeometry();
  const y = -0.1;
  const pos = new Float32Array([
    x0[0], y, x0[1], x1[0], y, x1[1], x2[0], y, x2[1],
    x0[0], y, x0[1], x2[0], y, x2[1], x3[0], y, x3[1],
  ]);
  const uv = new Float32Array([0, 0, 1, 0, 1, 1, 0, 0, 1, 1, 0, 1]);
  geom.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geom.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  geom.computeVertexNormals();
  texture.colorSpace = THREE.SRGBColorSpace;
  const mat = new THREE.MeshBasicMaterial({ map: texture, depthWrite: false, toneMapped: false });
  return new THREE.Mesh(geom, mat);
}

/** @param {THREE.Group} flat — группа земли/воды */
export async function initBasemap(flat, config, zoom = 13) {
  const bbox = config.bbox;
  const origin = config.origin;
  if (!bbox || bbox.length !== 4) return;
  const [west, south, east, north] = bbox;
  const x0 = lon2tile(west, zoom);
  const x1 = lon2tile(east, zoom);
  const y0 = lat2tile(north, zoom);
  const y1 = lat2tile(south, zoom);

  const group = new THREE.Group();
  group.name = 'basemap';
  flat.add(group);

  const loader = new THREE.TextureLoader();
  loader.crossOrigin = 'anonymous';
  const jobs = [];
  for (let x = x0; x <= x1; x++) {
    for (let y = y0; y <= y1; y++) jobs.push({ x, y });
  }

  let ok = 0;
  // CDN CARTO держит параллельные запросы, грузим все тайлы сразу.
  await Promise.all(jobs.map(async ({ x, y }) => {
    try {
      const tex = await loadTileTexture(loader, zoom, x, y);
      tex.anisotropy = 4;
      group.add(makeTileMesh(tileBounds3857(zoom, x, y), tex, origin));
      ok++;
    } catch {
      /* пропускаем недоступные тайлы */
    }
  }));
  console.log(`basemap: ${ok}/${jobs.length} tiles @ z${zoom}`);
  return group;
}