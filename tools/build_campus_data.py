"""OSM 가공 데이터(KU_Bus_Web/build/web_data.json) → KU BUS AI용 캠퍼스 데이터
- shared/campusData.js : 건물 목록, 정문/후문 하차 정류장, 건물별 도보시간(분)
- frontend/src/data/miniMap.json : 디지털 트윈 패널의 2D 정체 지도 형상(도로·건물·캠퍼스)
도보시간 추정 = (하차 정류장→출입문 직선거리 + 출입문→건물 중심 직선거리×1.3) ÷ 70 m/분, 올림. 경사는 반영하지 않음.
사용: python3 tools/build_campus_data.py ../KU_Bus_Web/build/web_data.json"""
import json, math, sys, os
src = sys.argv[1]
d = json.load(open(src, encoding='utf-8'))
root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
stops = {s['id']: s for s in d['sim']['stops']}
gates = {g['n']: g['xy'] for g in d['gates']}
dist = lambda a, b: math.hypot(a[0] - b[0], a[1] - b[1])
GATE = {
  '정문': {'stopId': 'node/357862965', 'stop': '국민대학교앞', 'gate': gates['국민대학교 정문']},
  '후문': {'stopId': 'node/357862967', 'stop': '국민대후문', 'gate': gates['국민대학교 후문']},
}
for g in GATE.values(): g['stopXY'] = stops[g['stopId']]['xy']
# 요구사항에 명시된 지정값(예: 정문-미래관 4분, 후문-미래관 2분)
SPECIFIED = {'미래관': {'정문': 4, '후문': 2}}
buildings, walk = [], {}
for b in sorted([b for b in d['buildings'] if b['campus'] and b['n']], key=lambda b: b['n']):
    name = b['n']
    buildings.append({'name': name, 'en': b['en'], 'x': round(b['c'][0], 1), 'z': round(b['c'][1], 1), 'levels': b['lv'], 'osmId': b['id']})
    row = {}
    for gk, g in GATE.items():
        m = dist(g['stopXY'], g['gate']) + 1.3 * dist(g['gate'], b['c'])
        row[gk] = max(1, math.ceil(m / 70))
    if name in SPECIFIED: row.update(SPECIFIED[name]); row['src'] = '지정'
    else: row['src'] = '추정'
    walk[name] = row
js = ['// 자동 생성: tools/build_campus_data.py — 지도 데이터 © OpenStreetMap contributors (ODbL 1.0)',
      '// 도보시간: "추정" = OSM 직선거리 기반(하차 정류장→출입문 + 출입문→건물×1.3, 분당 70 m, 올림, 경사 미반영)',
      '//           "지정" = 요구사항에 명시된 값. 실측으로 바꿔 쓰세요.',
      'export const DEFAULT_WALK_MIN = 5; // 지정 데이터가 없을 때 쓰는 기본 도보시간(분)',
      f"export const GATES = {json.dumps({k: {'stop': v['stop'], 'stopId': v['stopId']} for k, v in GATE.items()}, ensure_ascii=False)};",
      f'export const BUILDINGS = {json.dumps(buildings, ensure_ascii=False)};',
      f'export const WALK_TABLE = {json.dumps(walk, ensure_ascii=False)};', '']
open(os.path.join(root, 'shared/campusData.js'), 'w', encoding='utf-8').write('\n'.join(js))

# 미니 지도: 캠퍼스 주변만 잘라 정수 m로
BOX = (-520, -330, 560, 420)
def inbox(pts): return any(BOX[0] - 60 < pts[i] < BOX[2] + 60 and BOX[1] - 60 < pts[i + 1] < BOX[3] + 60 for i in range(0, len(pts), 2))
R = lambda a: [round(v) for v in a]
roads = [{'hw': r['hw'], 'n': r['n'], 'w': round(r['w'] or 6, 1), 'el': r['el'], 'p': R(r['p'])} for r in d['roads'] if inbox(r['p']) and not r['tun']]
blds = [{'n': b['n'], 'p': [R(ring) for poly in b['p'] for ring in poly]} for b in d['buildings'] if inbox(b['p'][0][0])]
mini = {'box': BOX, 'campus': [R(r) for r in d['campus']], 'roads': roads, 'buildings': blds,
        'wood': [[R(r) for r in poly] for poly in d['wood']],
        'stops': {k: {'name': v['stop'], 'xy': v['stopXY']} for k, v in GATE.items()},
        'gates': {k: v['gate'] for k, v in GATE.items()},
        'attribution': '© OpenStreetMap contributors'}
p = os.path.join(root, 'frontend/src/data/miniMap.json')
json.dump(mini, open(p, 'w', encoding='utf-8'), ensure_ascii=False, separators=(',', ':'))
print('buildings', len(buildings), 'roads', len(roads), 'mini bytes', os.path.getsize(p))
for k, v in walk.items(): print(k, v)
