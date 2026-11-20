"""Истории, граф и квесты для Вологды из выгрузки Wikidata/Википедии (pipeline/wikidata_browser.js → wd_dump.txt).

Записи разделены «¶», поля — «|»:
  B|gid|bag|year|flag|height|bits|x|z                       — дом карты, к которому привязаны объекты
  I|q|gid|kind|label|desc|title|year|file|artist|license|her — объект Wikidata на доме (title: '=' как label, '+' label + ' (Вологда)')
  R|q|prop|t|label|desc|human|born|died                     — связь объекта (P84, P825, …) или обратная (P69, P108, …)
  X|q|extract                                               — начало статьи Википедии

Пишет: data/wiki.json, data/graph.json, data/quests.json, notes и счётчики в data/layers.json,
а в data/attrs.bin — номер Wikidata, ссылку на wiki.json и биты слоёв (наследие, стили, храмы, дерево, статья).
"""
import json
import re
import struct
import sys
from collections import defaultdict
from pathlib import Path
from urllib.parse import quote

ROOT = Path(__file__).resolve().parent.parent
WEB = ROOT / 'web' if (ROOT / 'web').exists() else ROOT
DATA = WEB / 'data'
DUMP = Path(sys.argv[1]) if len(sys.argv) > 1 else ROOT / 'pipeline' / 'wd_dump.txt'

# Не дома: город, районы, река, фонд — их координаты случайно легли на чьи-то крыши.
DROP = {'1957', '1658617', '27538319', '37901008', '39198441', '14943321', '4087920'}
CHURCH = re.compile(r'(?i)(^|[\s(«])(церковь|церкви|храм|собор|часовня|колокольня|монастырь)([\s)»,]|$)')
GENERIC = re.compile(r'(?i)^(жилой дом|флигель|банк|лавка|церковь|жилой дом с лавкой|службы.*)$')

# ---------------------------------------------------------------- чтение выгрузки
B, I, R, X = {}, {}, [], {}
for rec in DUMP.read_text(encoding='utf-8').split('¶'):
    f = rec.split('|')
    if f[0] == 'B':
        gid = int(f[1])
        B[gid] = dict(gid=gid, bag=f[2], year=int(f[3]), flag=int(f[4]), h=float(f[5]),
                      bits={int(b) for b in f[6].split(',') if b}, x=float(f[7]), z=float(f[8]))
    elif f[0] == 'I':
        q, gid = f[1], int(f[2])
        if q in DROP:
            continue
        label = f[4]
        title = label if f[6] == '=' else label + ' (Вологда)' if f[6] == '+' else f[6]
        I[q] = dict(q=q, gid=gid, kind=f[3], label=label, desc=f[5], title=title, year=int(f[7]) if f[7] else None,
                    file=f[8], artist=f[9], license=f[10], her=f[11])
    elif f[0] == 'R':
        if f[1] in DROP:
            continue
        num = lambda s: int(s) if s and s != 'NaN' else None
        R.append(dict(q=f[1], p=f[2], t=f[3], label=f[4], desc=f[5], human=f[6] == '1', born=num(f[7]), died=num(f[8])))
    elif f[0] == 'X':
        X[f[1]] = f[2]
print(f'дома {len(B)}, объекты {len(I)}, связи {len(R)}, статьи {len(X)}')

def show(label):
    """Подпись без хвоста « (Вологда)» и с заглавной буквы."""
    s = re.sub(r'\s*\(Вологда\)\s*$', '', label).strip()
    return s[:1].upper() + s[1:]

def sentences(text, n=2, limit=320):
    parts = re.split(r'(?<=[.!?])\s+(?=[А-ЯЁA-Z«])', text.strip())
    out = ''
    for p in parts[:n]:
        if out and len(out) + len(p) > limit:
            break
        out = (out + ' ' + p).strip()
    return out or text[:limit]

def wiki_url(title):
    return 'https://ru.wikipedia.org/wiki/' + quote(title.replace(' ', '_'))

def wd_url(q):
    return f'https://www.wikidata.org/wiki/Q{q}'

def is_church(it):
    text = it['label'] + ' ' + it['desc']
    return bool(CHURCH.search(it['label'])) and not re.search(r'(?i)мечеть|католич|могила|жилой дом', text)

LICENSES = {
    'CC BY-SA 4.0': 'https://creativecommons.org/licenses/by-sa/4.0/', 'CC BY-SA 3.0': 'https://creativecommons.org/licenses/by-sa/3.0/',
    'CC BY 3.0': 'https://creativecommons.org/licenses/by/3.0/', 'CC BY 4.0': 'https://creativecommons.org/licenses/by/4.0/',
    'CC0': 'https://creativecommons.org/publicdomain/zero/1.0/',
}
def image(it):
    if not it['file']:
        return None
    f = it['file'].replace(' ', '_')
    im = {'thumb': f'https://commons.wikimedia.org/wiki/Special:FilePath/{quote(f)}?width=480',
          'page': f'https://commons.wikimedia.org/wiki/File:{quote(f)}'}
    artist = re.sub(r'(?i)^user:|unknown author.*|no machine-readable author.*|the author of this image is.*', '', it['artist']).strip(' …')
    if artist:
        im['artist'] = artist
    if it['license']:
        im['license'] = it['license']
        if it['license'] in LICENSES:
            im['licenseUrl'] = LICENSES[it['license']]
    return im

# ---------------------------------------------------------------- объекты по домам и главный объект дома
by_gid = defaultdict(list)
for it in I.values():
    by_gid[it['gid']].append(it)
rel_by_q = defaultdict(list)
for r in R:
    rel_by_q[r['q']].append(r)

def score(it):
    s = 0
    s += 4 if it['q'] in X else 0
    s += 2 if it['title'] else 0
    s += 1 if it['file'] else 0
    s += 1 if it['desc'] else 0
    s += 2 if not GENERIC.match(show(it['label'])) else 0
    s += {'F': 1.5, 'R': 1, 'L': 0.5, 'V': 0.5, 'H': 0.5}.get(it['her'], 0)
    s += 1 if is_church(it) else 0
    s -= 1 if re.match(r'(?i)(корпус|стена|башня|флигель|службы)', it['label']) else 0
    return s

primary = {gid: max(items, key=score) for gid, items in by_gid.items() if gid in B}

def nice_name(gid):
    """Подпись дома: «Жилой дом» получает год, а дом, известный по событию, — адрес."""
    it = primary[gid]
    if it['label'] == 'Гибель Николая Рубцова':
        return 'Дом на улице Александра Яшина, 3'
    name = show(it['label'])
    year = it['year'] or (B[gid]['year'] if B[gid]['flag'] != 5 else None)
    if GENERIC.match(name) and year:
        name = f'{name} {year} года'
    return name

STYLE_BITS = [  # стиль из Wikidata → бит слоя «Архитектурные стили»
    (r'классицизм|ампир', 1), (r'неоготик|эклектик|историзм|псевдорус|неорус', 2), (r'модерн', 3),
    (r'конструктив|сталинск|советск', 4), (r'барокко|узорочье', 14),
]
HER_BIT = {'F': 7, 'R': 8, 'L': 9, 'V': 9, 'H': 9}
HER_TEXT = {'F': 'Объект культурного наследия федерального значения.', 'R': 'Объект культурного наследия регионального значения.',
            'L': 'Объект культурного наследия местного значения.', 'V': 'Выявленный объект культурного наследия.',
            'H': 'Объект культурного наследия.'}

def styles_of(gid):
    out = []
    for it in by_gid[gid]:
        for r in rel_by_q[it['q']]:
            if r['p'] == '149' and r['label'] not in out:
                out.append(r['label'])
    return out

def best_her(gid):
    order = 'FRLVH'
    hs = [it['her'] for it in by_gid[gid] if it['her']]
    return min(hs, key=order.index) if hs else ''

def wooden(gid):
    return any(re.search(r'(?i)деревян', it['label'] + ' ' + it['desc'] + ' ' + X.get(it['q'], '')[:200]) for it in by_gid[gid])

# ---------------------------------------------------------------- wiki.json + биты домов
wiki, wk, qs, newbits = [], {}, {}, defaultdict(set)
for gid, it in sorted(primary.items()):
    b = B[gid]
    name = nice_name(gid)
    arch = sorted({r['label'] for x in by_gid[gid] for r in rel_by_q[x['q']] if r['p'] == '84'})
    st = styles_of(gid)
    facts = []
    for x in by_gid[gid]:
        for r in rel_by_q[x['q']]:
            if r['p'] == '112' and r['human']:
                facts.append(f'Основан по воле: {r["label"]}.')
            if r['p'] == '138' and r['human']:
                facts.append(f'Назван в честь: {r["label"]}.')
    others = [show(x['label']) for x in by_gid[gid] if x is not it and not GENERIC.match(show(x['label']))]
    if others and len(others) <= 3:
        facts.append('Здесь же: ' + ', '.join(dict.fromkeys(others)) + '.')
    alumni = sorted({r['label'] for x in by_gid[gid] for r in rel_by_q[x['q']] if r['p'] in ('69', '108')})
    if alumni:
        facts.append(('Здесь учились и работали: ' + ', '.join(alumni[:3]) + (f' и ещё {len(alumni) - 3}' if len(alumni) > 3 else '') + '.'))
    her = best_her(gid)
    entry = {'label': name}
    im = image(it) or next((image(x) for x in by_gid[gid] if x['file']), None)
    if im:
        entry['image'] = im
    if it['title']:
        entry['wiki'] = {'url': wiki_url(it['title']), 'lang': 'ru'}
        if it['q'] in X:
            entry['wiki']['extract'] = X[it['q']]
    if arch:
        entry['architects'] = arch
    if st:
        entry['styles'] = st
    fact = ' '.join(dict.fromkeys(facts)) or (HER_TEXT[her] if her else '') or (it['desc'][:1].upper() + it['desc'][1:] if it['desc'] else '')
    if it['label'] == 'Гибель Николая Рубцова':
        fact = 'Здесь жил и погиб поэт Николай Рубцов (1936–1971).'
    if fact:
        entry['fact'] = fact
    qs[gid] = int(it['q'])
    wk[gid] = len(wiki)
    wiki.append(entry)
    # биты слоёв
    if her:
        newbits[gid].add(HER_BIT[her])
    for s in st:
        for pat, bit in STYLE_BITS:
            if re.search(pat, s, re.I):
                newbits[gid].add(bit)
    if wooden(gid):
        newbits[gid] |= {0, 6}
    if any(is_church(x) for x in by_gid[gid]):
        newbits[gid].add(10)
    if any(x['title'] for x in by_gid[gid]):
        newbits[gid].add(13)
print(f'wiki.json: {len(wiki)} записей')

# ---------------------------------------------------------------- attrs.bin
attrs = bytearray((DATA / 'attrs.bin').read_bytes())
city = json.loads((DATA / 'city.json').read_text(encoding='utf-8'))
STRIDE = city['attrStride']
N = len(attrs) // STRIDE
for gid, idx in wk.items():
    o = gid * STRIDE
    struct.pack_into('<I', attrs, o + 16, qs[gid])
    struct.pack_into('<i', attrs, o + 28, idx)
    lay0 = struct.unpack_from('<I', attrs, o + 20)[0]
    for bit in newbits[gid]:
        lay0 |= 1 << bit
    struct.pack_into('<I', attrs, o + 20, lay0)
(DATA / 'attrs.bin').write_bytes(bytes(attrs))

def bldg(g):
    o = g * STRIDE
    lay0, lay1 = struct.unpack_from('<II', attrs, o + 20)
    return dict(bag=str(int(struct.unpack_from('<d', attrs, o)[0])), year=struct.unpack_from('<h', attrs, o + 12)[0],
                flag=attrs[o + 11], lay0=lay0, lay1=lay1)

# ---------------------------------------------------------------- слои: счётчики, годы, истории
layers = json.loads((DATA / 'layers.json').read_text(encoding='utf-8'))
styles_layer = next(L for L in layers if L['id'] == 'styles')
if not any(g['bit'] == 14 for g in styles_layer['groups']):
    styles_layer['groups'].insert(1, {'key': 'baroque', 'label': 'Узорочье и барокко', 'bit': 14, 'count': 0, 'years': {}})
styles_layer['text'] = ('Вологда — это узорочье и барокко храмов, классицизм купеческих особняков, деревянные дома с резьбой, '
                        'модерн начала XX века. Стиль указан по Wikidata и деревянным памятникам; остальные дома окрашены по эпохе.')
styles_layer['caveat'] = 'Стиль известен примерно у полусотни зданий — у тех, что описаны в Wikidata.'
styles_layer['source'] = {'label': 'Wikidata, Википедия', 'url': 'https://www.wikidata.org'}
all_b = [bldg(g) for g in range(N)]
for L in layers:
    total = set()
    for g in L['groups']:
        bit = g['bit']
        years = defaultdict(int)
        cnt = 0
        for i, b in enumerate(all_b):
            on = (b['lay0'] >> bit) & 1 if bit < 32 else (b['lay1'] >> (bit - 32)) & 1
            if on:
                cnt += 1
                total.add(i)
                if b['flag'] != 5:
                    years[str(b['year'])] += 1
        g['count'], g['years'] = cnt, dict(sorted(years.items()))
    L['count'] = len(total)
    L['groups'] = [g for g in L['groups'] if g['count'] > 0]  # пустые группы не нужны в легенде

ROMAN = ['', 'I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X', 'XI', 'XII', 'XIII', 'XIV', 'XV', 'XVI', 'XVII', 'XVIII', 'XIX', 'XX', 'XXI']
def when(year):
    """Год из Wikidata: 1301 — это обычно «XIV век» с точностью до века, 1700 — «около 1700 года»."""
    if year % 100 == 1:
        return f'{ROMAN[year // 100 + 1]} век'
    if year % 100 == 0:
        return f'около {year} года'
    return f'{year} год'

def at(gid):
    return [round(B[gid]['x'], 1), round(B[gid]['z'], 1)]

def source(it):
    return wiki_url(it['title']) if it['title'] else wd_url(it['q'])

def story_main(gid):
    it = primary[gid]
    if it['q'] in X:
        return sentences(X[it['q']], 2, 330)
    return (it['desc'][:1].upper() + it['desc'][1:] + '.') if it['desc'] else ''

notes = {L['id']: {} for L in layers}
for gid, it in primary.items():
    b, bits, bag = B[gid], newbits[gid] | B[gid]['bits'], B[gid]['bag']
    name, src, main = nice_name(gid), source(it), story_main(gid)
    year = it['year'] or (b['year'] if b['flag'] != 5 else None)
    her = best_her(gid)
    if 13 in bits and it['title'] and main:
        notes['wiki'][bag] = {'at': at(gid), 'name': name, 'story': main, 'source': src}
    if her:
        s = HER_TEXT[her] + (f' Время постройки — {when(year)}.' if year and year < 2000 else '')
        notes['heritage'][bag] = {'at': at(gid), 'name': name, 'story': s if not main else s + ' ' + sentences(main, 1, 200), 'source': src}
    st = styles_of(gid)
    if st:
        arch = sorted({r['label'] for x in by_gid[gid] for r in rel_by_q[x['q']] if r['p'] == '84'})
        s = 'Стиль: ' + ', '.join(st) + '.' + (f' Архитектор — {", ".join(arch)}.' if arch else '')
        notes['styles'][bag] = {'at': at(gid), 'name': name, 'story': s, 'source': src}
    if 6 in bits:
        s = sentences(main, 1, 240) if main else f'Деревянный дом{f" {year} года" if year else ""}.' + (' ' + HER_TEXT[her] if her else '')
        notes['wooden'][bag] = {'at': at(gid), 'name': name, 'story': s, 'source': src}
    if 10 in bits and any(is_church(x) for x in by_gid[gid]):
        ded = [r['label'] for x in by_gid[gid] for r in rel_by_q[x['q']] if r['p'] == '825']
        s = (f'Освящён во имя: {", ".join(dict.fromkeys(ded))}. ' if ded else '') + (sentences(main, 1, 240) if main else '')
        notes['faiths'][bag] = {'at': at(gid), 'name': name, 'story': s.strip() or f'Храм{f" {year} года" if year else ""}.', 'source': src}
for L in layers:
    L['notes'] = notes.get(L['id'], {})
(DATA / 'layers.json').write_text(json.dumps(layers, ensure_ascii=False, separators=(',', ':')), encoding='utf-8')
print('истории по слоям:', {k: len(v) for k, v in notes.items()})

# ---------------------------------------------------------------- граф
FEAST = re.compile(r'(?i)воскресени|рождеств|покров|успени|преображени|сретени|введени|воздвижени|благовещени|вознесени|троиц')
ORG = re.compile(r'(?i)кремль|монастыр|ансамбль|усадьба|комплекс|музей|железн')
nodes, places, links = {}, {}, {}

def years(r):
    a, b = r.get('born'), r.get('died')
    if a and b and b >= a:
        return f'{a}–{b}'
    return f'{a}–' if a else ''

def place(gid):
    pid = f'b{gid}'
    if pid not in places:
        it, b = primary[gid], B[gid]
        p = {'name': nice_name(gid), 'year': it['year'] or b['year'], 'bags': [b['bag']], 'x': round(b['x']), 'z': round(b['z'])}
        im = image(it)
        if im:
            p['photo'] = im['thumb']
        places[pid] = p
    return pid

def link(eid, gid, text, src):
    pid = place(gid)
    key = (eid, pid)
    L = links.setdefault(key, {'e': eid, 'p': pid, 'texts': []})
    if all(t['text'] != text for t in L['texts']):
        L['texts'].append({'text': text, 'source': src})

def node(eid, typ, label, ys='', desc=''):
    if eid not in nodes:
        nodes[eid] = {'id': eid, 'type': typ, 'label': label}
        if ys:
            nodes[eid]['years'] = ys
        if desc:
            nodes[eid]['desc'] = desc.rstrip('…').rstrip(',')

for r in R:
    it = I.get(r['q'])
    if not it or it['gid'] not in primary:
        continue
    gid, src, nm = it['gid'], source(it), show(it['label'])
    eid = 'Q' + r['t']
    p = r['p']
    if p == '84':
        node(eid, 'architect', r['label'], years(r), r['desc'])
        link(eid, gid, f'{nm}: архитектор — {r["label"]}.', src)
    elif p == '825':
        if r['human']:
            node(eid, 'person', r['label'], years(r), r['desc'])
            link(eid, gid, f'{nm} освящён во имя: {r["label"]}.', src)
        elif FEAST.search(r['label']):
            node(eid, 'event', r['label'], '', r['desc'])
            link(eid, gid, f'{nm} посвящён празднику: {r["label"]}.', src)
    elif p in ('112', '88'):
        if r['human']:
            node(eid, 'person', r['label'], years(r), r['desc'])
            link(eid, gid, f'{nm}: {"основатель" if p == "112" else "заказчик"} — {r["label"]}.', src)
    elif p == '138' and r['human']:
        node(eid, 'person', r['label'], years(r), r['desc'])
        link(eid, gid, f'{nm} назван в честь: {r["label"]}.', src)
    elif p in ('69', '108', '551', '937'):
        node(eid, 'person', r['label'], years(r), r['desc'])
        what = {'69': 'Место учёбы', '108': 'Место работы', '551': 'Место жительства', '937': 'Место работы'}[p]
        link(eid, gid, f'{what}: {nm}.', wd_url(r['t']))
    elif r['label'] == 'Ансамбль зданий':
        continue
    elif p in ('361', '137', '127') and ORG.search(r['label']) and r['t'] not in I:
        node(eid, 'organisation', show(r['label']), '', r['desc'])
        link(eid, gid, f'{nm} входит в {show(r["label"])}.' if p == '361' else f'{nm}: {"управляет" if p == "137" else "владелец"} — {show(r["label"])}.', src)
    elif p == '361' and ORG.search(r['label']) and r['t'] in I and r['t'] != r['q']:
        node(eid, 'organisation', show(r['label']), '', '')
        link(eid, gid, f'{nm} входит в {show(r["label"])}.', src)

# Люди и события, которые названы прямо в названиях памятников (Wikidata) и в статьях.
def by_label(pattern):
    return next((it for it in I.values() if re.search(pattern, it['label'])), None)
MANUAL = [
    ('batyushkov', 'person', 'Константин Николаевич Батюшков', '1787–1855', 'русский поэт', [
        (r'Гревенса', 'В этом доме жил поэт К. Н. Батюшков (1787–1815 и 1853–1855).'),
        (r'Могила К\.Н\. Батюшкова', 'Поэт похоронен в Спасо-Прилуцком монастыре.')]),
    ('Q855', 'person', 'Иосиф Сталин', '1878–1953', 'советский государственный деятель', [
        (r'ссылку, И\.В\. Сталин', 'Здесь в 1911–1912 годах жил ссыльный И. В. Сталин; сейчас тут музей «Вологодская ссылка».')]),
    ('Q2296853', 'person', 'Николай Михайлович Романов', '1859–1919', 'великий князь, историк', [
        (r'Николай Михайлович Романов', 'В 1918 году здесь жил в ссылке великий князь Николай Михайлович.')]),
    ('Q655247', 'person', 'Николай Михайлович Рубцов', '1936–1971', 'русский советский поэт', [
        (r'Гибель Николая Рубцова', 'В ночь на 19 января 1971 года в этом доме погиб поэт Николай Рубцов.')]),
    ('Q8479', 'person', 'Пётр I', '1672–1725', 'русский царь, первый император', [
        (r'^Дом Петра I', 'Дом-музей Петра I — памятник архитектуры XVII века, филиал музея-заповедника.')]),
    ('shalamov', 'person', 'Варлам Тихонович Шаламов', '1907–1982', 'писатель, автор «Колымских рассказов»', [
        (r'^Шаламовский дом', 'Дом носит имя писателя: здесь он родился и вырос, сейчас в доме его музей.')]),
    ('panteleev', 'person', 'Александр Васильевич Пантелеев', '', 'художник', [
        (r'Пантелеева', 'Мемориальный музей художника в его мастерской.')]),
    ('ledentsov', 'person', 'Христофор Семёнович Леденцов', '1842–1907', 'купец и меценат', [
        (r'городской ломбард', 'Первый в России городской ломбард открыт в 1888 году по инициативе Х. С. Леденцова.')]),
    ('embassy1918', 'event', 'Дипломатический корпус в Вологде', '1918', 'посольства союзников в Вологде', [
        (r'Музей дипломатического корпуса', 'В 1918 году в этом особняке размещалось американское посольство.')]),
    ('rubtsov-death', 'event', 'Гибель Николая Рубцова', '1971', '', [
        (r'Гибель Николая Рубцова', 'Поэт погиб в ночь на 19 января 1971 года.')]),
]
for eid, typ, label, ys, desc, refs in MANUAL:
    for pattern, text in refs:
        it = by_label(pattern)
        if not it or it['gid'] not in primary:
            continue
        node(eid, typ, label, ys, desc)
        link(eid, it['gid'], text, source(it))

graph = {'nodes': list(nodes.values()), 'places': places, 'links': list(links.values())}
(DATA / 'graph.json').write_text(json.dumps(graph, ensure_ascii=False, separators=(',', ':')), encoding='utf-8')
print(f'граф: {len(nodes)} точек, {len(places)} зданий, {len(links)} связей',
      dict(sorted(defaultdict(int, {t: sum(1 for n in nodes.values() if n["type"] == t) for t in ("person", "architect", "event", "organisation")}).items())))

(DATA / 'wiki.json').write_text(json.dumps(wiki, ensure_ascii=False, separators=(',', ':')), encoding='utf-8')

# ---------------------------------------------------------------- квесты
def step_for(pattern, riddle, hints, layer=None):
    it = by_label(pattern)
    gid = it['gid']
    im = image(primary[gid]) or image(it)
    s = {'riddle': riddle, 'hints': hints, 'answer': {'bags': [B[gid]['bag']]},
         'found': {'name': nice_name(gid), 'story': story_main(gid) or riddle, 'source': source(primary[gid])}}
    if im:
        s['photo'] = {k: v for k, v in im.items() if k in ('thumb', 'page', 'artist', 'license')}
    if layer:
        s['layer'] = layer
    return s

def count(rule):
    n = 0
    for b in all_b:
        if b['flag'] == 5 and ('before' in rule or 'after' in rule):
            continue
        if 'before' in rule and not b['year'] < rule['before']:
            continue
        if 'after' in rule and not b['year'] > rule['after']:
            continue
        if 'bits' in rule and not all((b['lay0'] >> bit) & 1 for bit in rule['bits']):
            continue
        n += 1
    return n

quests = [
    {'id': 'domes', 'level': 1, 'title': 'Купола над рекой',
     'intro': 'Пять храмов старой Вологды. Смотрите на фото, читайте загадку и ищите здание на карте.',
     'steps': [
         step_for(r'^Софийский собор', 'Самое старое каменное здание города: его строили в 1568–1570 годах по распоряжению Ивана Грозного.',
                  ['Ищите в кремле, у самой реки.', 'Откройте слой «Храмы» — он там один из самых высоких.'], 'faiths'),
         step_for(r'^Церковь Иоанна Златоуста', 'Храм стоит на набережной и смотрит прямо на главный собор города.',
                  ['Он назван в честь святого «с золотыми устами».', 'Ищите на берегу Вологды напротив кремля.'], 'faiths'),
         step_for(r'^Церковь Димитрия Прилуцкого на Наволоке', 'Одна из первых каменных церквей Вологды, 1651 год. Внутри сохранились фрески начала XVIII века.',
                  ['Наволок — заречная сторона.', 'Церковь носит имя основателя Спасо-Прилуцкого монастыря.'], 'faiths'),
         step_for(r'^Церковь Покрова на Козлёне', 'Храм 1704–1710 годов с фресками ярославской школы в Нижнем посаде.',
                  ['Козлёна — старое имя улицы и всей округи.', 'Посвящён Покрову Богородицы.'], 'faiths'),
         step_for(r'^Церковь Варлаама Хутынского', 'Церковь 1780 года, построенная на деньги купца Узденникова.',
                  ['Названа в честь новгородского игумена.', 'Откройте слой «Храмы» и ищите за рекой, недалеко от набережной.'], 'faiths'),
     ]},
    {'id': 'wood', 'level': 2, 'title': 'Деревянная Вологда',
     'intro': 'Особняки с мезонинами, резьбой и колоннами из дерева. Найдите пять памятников деревянного зодчества.',
     'steps': [
         step_for(r'^Дом Засецких', 'Одноэтажный деревянный особняк с мезонином и портиком на Ленинградской улице, 1790-е годы.',
                  ['Памятник федерального значения.', 'Откройте слой «Деревянное наследие».'], 'wooden'),
         step_for(r'^Дом Волкова', 'Памятник деревянного зодчества начала XIX века; в усадьбе сохранились конюшня и службы.',
                  ['Он тоже на Ленинградской улице.', 'Ищите рядом с домом Засецких.'], 'wooden'),
         step_for(r'Жилой дом \(деревянный\) Пузан-Пузыревского', 'В 1918 году в этом деревянном особняке работало американское посольство.',
                  ['Сейчас здесь был музей дипломатического корпуса.', 'Ищите на правом берегу, к югу от центра.'], 'wooden'),
         step_for(r'^Дом дворянина Н\.М\. Благово-Дружинина', 'Двухэтажный особняк середины XIX века на углу улиц Мальцева и Благовещенской.',
                  ['Мальцева раньше называлась Пятницкой.', 'Это часть усадьбы Дружинина.'], 'wooden'),
         step_for(r'^Дом Соковикова', 'Деревянный особняк 1830-х годов; сейчас в нём залы детской областной библиотеки.',
                  ['Памятник федерального значения.', 'Ищите к югу от центра, в кварталах деревянной застройки.'], 'wooden'),
     ]},
]
era = [
    ({'before': 1700}, 'Найдите любой дом, построенный до 1700 года.', ['Включите раскраску по эпохам.', 'Почти все такие постройки — храмы и палаты.'], 'period'),
    ({'bits': [6]}, 'Найдите любую постройку из слоя «Деревянное наследие».', ['Откройте слой — дома загорятся цветом.', 'Больше всего их к югу от центра.'], None),
    ({'after': 1899, 'bits': [10]}, 'Найдите православный храм, построенный в XX веке или позже.', ['Откройте слой «Храмы».', 'Ищите дальше от исторического центра.'], None),
    ({'bits': [7]}, 'Найдите любой памятник федерального значения.', ['Откройте слой «Охраняемое наследие».', 'Начните с кремля.'], None),
    ({'after': 2015}, 'Найдите дом, построенный после 2015 года.', ['Включите раскраску по эпохам: нужен самый свежий цвет.', 'Новые кварталы — на окраинах.'], 'period'),
]
steps = []
for rule, riddle, hints, mode in era:
    s = {'riddle': riddle, 'hints': hints, 'answer': rule, 'count': count(rule)}
    if mode:
        s['mode'] = mode
    elif rule.get('bits'):
        s['layer'] = {6: 'wooden', 10: 'faiths', 7: 'heritage'}[rule['bits'][0]]
    steps.append(s)
quests.append({'id': 'eras', 'level': 3, 'title': 'Город эпох', 'intro': 'Пять загадок без фото: подойдёт любое здание, которое отвечает условию.', 'steps': steps})
(DATA / 'quests.json').write_text(json.dumps(quests, ensure_ascii=False, separators=(',', ':')), encoding='utf-8')
print('квесты:', [(q['title'], len(q['steps'])) for q in quests], [s.get('count') for s in steps])
