// Сбор историй для слоёв, прогулки и графа: Wikidata + Википедия, сопоставление с домами карты по координатам.
// Запускается в странице карты (нужны window.__dbg.sim и vice): результат — window.__wd.
// Потом данные записываются в data/wiki.json, data/graph.json, notes в data/layers.json и биты в data/attrs.bin.
(async () => {
  const D = window.__dbg, N = D.config.stats.buildings;
  const [lat0, lon0] = D.toLatLon(0, 0);
  const WD = 'https://query.wikidata.org/sparql';
  const sparql = async q => {
    const r = await fetch(WD, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/sparql-results+json' },
      body: 'query=' + encodeURIComponent(q) });
    if (!r.ok) throw new Error('WDQS ' + r.status);
    return (await r.json()).results.bindings;
  };
  const qid = u => u && u.value.replace('http://www.wikidata.org/entity/', '');
  const val = b => b?.value;
  const log = [];

  // 1) Всё с координатами в радиусе 9 км.
  const around = await sparql(`SELECT ?item ?lat ?lon ?p31 WHERE {
    SERVICE wikibase:around { ?item wdt:P625 ?loc . bd:serviceParam wikibase:center "Point(${lon0} ${lat0})"^^geo:wktLiteral . bd:serviceParam wikibase:radius "9" . }
    BIND(geof:latitude(?loc) AS ?lat) BIND(geof:longitude(?loc) AS ?lon)
    OPTIONAL { ?item wdt:P31 ?p31 } }`);
  const items = new Map();
  for (const b of around) {
    const q = qid(b.item);
    const it = items.get(q) || { q, lat: +b.lat.value, lon: +b.lon.value, p31: new Set() };
    if (b.p31) it.p31.add(qid(b.p31));
    items.set(q, it);
  }
  log.push(`рядом: ${items.size}`);
  // Не здания: улицы, площади, реки, парки, мосты, районы, памятники-скульптуры, остановки, кладбища и т. п.
  const NOT = new Set(['Q79007', 'Q174782', 'Q4022', 'Q22698', 'Q12280', 'Q486972', 'Q532', 'Q123705', 'Q15284', 'Q23397', 'Q4989906',
    'Q953806', 'Q39614', 'Q2085381', 'Q1248784', 'Q34442', 'Q3957', 'Q5084', 'Q2514025', 'Q179049', 'Q860861', 'Q2143825',
    'Q11446', 'Q7543083', 'Q1076486', 'Q12284', 'Q14350', 'Q47521', 'Q165', 'Q1934969', 'Q1048835', 'Q2221906']);
  const PLAQUE = 'Q721747';
  // 2) Сопоставление с домами: точка внутри контура (по сетке столкновений) и ближайший центр дома.
  const match = new Map(); // gid -> [q...]
  for (const it of items.values()) {
    if ([...it.p31].some(c => NOT.has(c))) continue;
    const [x, z] = D.fromLatLon(it.lat, it.lon);
    it.x = x; it.z = z;
    const inside = D.vice.blocked(x, z);
    const g = D.sim.nearestBuilding(x, z, inside ? 70 : 18);
    if (g < 0) continue;
    it.gid = g;
    (match.get(g) || match.set(g, []).get(g)).push(it.q);
  }
  log.push(`совпало с домами: ${[...items.values()].filter(i => i.gid >= 0).length} объектов на ${match.size} домах`);
  const Q = [...items.values()].filter(i => i.gid >= 0).map(i => i.q);

  // 3) Подробности пачками по 150.
  const chunks = (a, n) => Array.from({ length: Math.ceil(a.length / n) }, (_, i) => a.slice(i * n, i * n + n));
  const info = new Map(), rel = [];
  for (const part of chunks(Q, 150)) {
    const V = part.map(q => 'wd:' + q).join(' ');
    for (const b of await sparql(`SELECT ?item ?label ?desc ?article ?inc ?img ?her ?herL WHERE { VALUES ?item { ${V} }
      OPTIONAL { ?item rdfs:label ?label FILTER(LANG(?label) = "ru") }
      OPTIONAL { ?item schema:description ?desc FILTER(LANG(?desc) = "ru") }
      OPTIONAL { ?article schema:about ?item ; schema:isPartOf <https://ru.wikipedia.org/> }
      OPTIONAL { ?item wdt:P571 ?inc }
      OPTIONAL { ?item wdt:P18 ?img }
      OPTIONAL { ?item wdt:P1435 ?her . OPTIONAL { ?her rdfs:label ?herL FILTER(LANG(?herL) = "ru") } } }`)) {
      const q = qid(b.item), o = info.get(q) || { q, her: new Set() };
      o.label ??= val(b.label); o.desc ??= val(b.desc); o.article ??= val(b.article); o.img ??= val(b.img);
      if (b.inc && !o.year) o.year = parseInt(b.inc.value.replace(/^\+/, ''), 10) || undefined;
      if (b.her) o.her.add(qid(b.her) + '|' + (val(b.herL) || ''));
      info.set(q, o);
    }
    for (const b of await sparql(`SELECT ?item ?prop ?t ?tL ?tD ?human ?born ?died WHERE { VALUES ?item { ${V} }
      VALUES ?prop { wdt:P84 wdt:P825 wdt:P138 wdt:P112 wdt:P88 wdt:P361 wdt:P137 wdt:P127 wdt:P149 wdt:P547 }
      ?item ?prop ?t . FILTER(isIRI(?t))
      OPTIONAL { ?t rdfs:label ?tL FILTER(LANG(?tL) = "ru") }
      OPTIONAL { ?t schema:description ?tD FILTER(LANG(?tD) = "ru") }
      OPTIONAL { ?t wdt:P31 wd:Q5 . BIND(1 AS ?human) }
      OPTIONAL { ?t wdt:P569 ?born } OPTIONAL { ?t wdt:P570 ?died } }`)) {
      rel.push({ q: qid(b.item), p: b.prop.value.split('/').pop(), t: qid(b.t), label: val(b.tL), desc: val(b.tD), human: !!b.human,
        born: b.born ? parseInt(b.born.value.replace(/^\+/, ''), 10) : undefined, died: b.died ? parseInt(b.died.value.replace(/^\+/, ''), 10) : undefined });
    }
  }
  log.push(`подробности: ${info.size}, связей: ${rel.length}`);

  // 4) Вступления статей Википедии (по 20 за запрос).
  const titleOf = u => decodeURIComponent(u.split('/wiki/')[1]).replace(/_/g, ' ');
  const arts = [...info.values()].filter(o => o.article);
  for (const part of chunks(arts, 20)) {
    const u = 'https://ru.wikipedia.org/w/api.php?action=query&format=json&origin=*&prop=extracts&exintro=1&explaintext=1&exlimit=20&redirects=1&titles='
      + encodeURIComponent(part.map(o => titleOf(o.article)).join('|'));
    const j = await fetch(u).then(r => r.json()).catch(() => null);
    if (!j?.query) continue;
    const norm = new Map();
    for (const n of [...(j.query.normalized || []), ...(j.query.redirects || [])]) norm.set(n.to, n.from);
    for (const p of Object.values(j.query.pages || {})) {
      let t = p.title;
      while (norm.has(t)) t = norm.get(t);
      const o = part.find(o => titleOf(o.article) === t || titleOf(o.article) === p.title);
      if (o && p.extract) o.extract = p.extract;
    }
  }
  log.push(`статей с текстом: ${[...info.values()].filter(o => o.extract).length}`);

  // 5) Фото: миниатюра и лицензия с Викисклада (по 50).
  const imgs = [...info.values()].filter(o => o.img);
  const fileOf = u => decodeURIComponent(u.split('/Special:FilePath/')[1] || '').replace(/_/g, ' ');
  for (const part of chunks(imgs, 50)) {
    const u = 'https://commons.wikimedia.org/w/api.php?action=query&format=json&origin=*&prop=imageinfo&iiprop=url|extmetadata&iiurlwidth=480&titles='
      + encodeURIComponent(part.map(o => 'File:' + fileOf(o.img)).join('|'));
    const j = await fetch(u).then(r => r.json()).catch(() => null);
    if (!j?.query) continue;
    const norm = new Map((j.query.normalized || []).map(n => [n.to, n.from]));
    for (const p of Object.values(j.query.pages || {})) {
      const ii = p.imageinfo?.[0];
      if (!ii) continue;
      const from = norm.get(p.title) || p.title;
      const o = part.find(o => 'File:' + fileOf(o.img) === from || 'File:' + fileOf(o.img) === p.title);
      if (!o) continue;
      const m = ii.extmetadata || {};
      const strip = s => (s || '').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
      o.image = { thumb: ii.thumburl, page: ii.descriptionurl, artist: strip(m.Artist?.value).slice(0, 80) || undefined,
        license: strip(m.LicenseShortName?.value) || undefined, licenseUrl: m.LicenseUrl?.value || undefined };
    }
  }
  log.push(`фото: ${[...info.values()].filter(o => o.image).length}`);

  // Результат — сырой: склейка по домам и раскладка по слоям делается уже в пайплайне.
  const out = {
    items: [...items.values()].filter(i => i.gid >= 0).map(i => ({ q: i.q, gid: i.gid, x: Math.round(i.x), z: Math.round(i.z), p31: [...i.p31], plaque: i.p31.has(PLAQUE) })),
    info: [...info.values()].map(o => ({ ...o, her: [...o.her] })),
    rel,
    centroids: Object.fromEntries([...match.keys()].map(g => [g, D.sim.centroid(g).map(v => Math.round(v * 10) / 10)])),
    buildings: Object.fromEntries([...match.keys()].map(g => { const b = D.building(g); return [g, { bag: b.bag, year: b.year, h: b.height, groups: b.groups.map(x => x.bit) }]; })),
  };
  window.__wd = out;
  window.__wdLog = log;
  return log;
})();
