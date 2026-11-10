"""tools/fetch_courses.py 단위 테스트(네트워크 없음) — 실행: python -m unittest tools/test_fetch_courses.py"""
import json
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import fetch_courses as fc  # noqa: E402

FIX = Path(__file__).resolve().parent / 'fixtures' / 'sample_lectures_response.json'
RESP = json.loads(FIX.read_text(encoding='utf-8'))
ROWS = RESP['lectureRoms']['results']


class FakeClient:
    """offset/limit 페이지 응답을 흉내: 묶음 강의 때문에 쪽마다 한 건이 더 올 수 있음"""
    def __init__(self, rows, extra=True):
        self.rows, self.extra, self.bodies = rows, extra, []

    def request(self, url, body=None):
        self.bodies.append(body)
        o, n = body['offset'], body['limit']
        page = self.rows[o:o + n + (1 if self.extra else 0)]
        return {'invalidCode': None, 'prohibitType': 'NONE', 'lectureRoms': {'results': page, 'totalCount': len(self.rows)}}


class FetchCoursesTest(unittest.TestCase):
    def test_merge_30min_slots_into_blocks(self):
        b = fc.merge_slots(ROWS[0]['schedule']['lectureTimes'])
        self.assertEqual(b, [{'day': 0, 'start': '15:00', 'end': '16:30', 'room': '미래관3층38호실'},
                             {'day': 3, 'start': '16:30', 'end': '18:00', 'room': '미래관3층38호실'}])

    def test_normalize_course(self):
        c = fc.normalize(ROWS[0], {'category': fc.CATEGORY_FALLBACK, 'dept': {'20639': '전자공학부 지능형반도체융합전자전공'}})
        self.assertEqual((c['id'], c['code'], c['section'], c['name'], c['professor'], c['credits']), ('2026-20-0066305-01', '0066305', '01', '회로이론II', '김교수', 3))
        self.assertEqual((c['category'], c['dayNight'], c['grades'], c['department']), ('전공선택', '주간', ['2'], '전자공학부 지능형반도체융합전자전공'))
        self.assertEqual(c['timeText'], '월 15:00-16:30 · 목 16:30-18:00')
        self.assertNotIn('professorNo', c)
        night, sat, online = (fc.normalize(r) for r in ROWS[1:])
        self.assertEqual((night['dayNight'], night['timeText']), ('야간', '화 18:00-21:00'))
        self.assertEqual(sat['times'][0]['day'], 5)
        self.assertEqual((online['times'], online['timeText']), ([], '시간 미정'))

    def test_pages_until_total_and_dedupe_tied_rows(self):
        rows = [dict(ROWS[i % 4], id=f'x-{i}') for i in range(7)]
        client = FakeClient(rows)
        got = fc.search_all_pages(client, '2026', '20', {'searchType': '02', 'univCd': '1', 'deprtCd': '1'}, 3, '테스트')
        self.assertEqual(sorted(r['id'] for r in got), [f'x-{i}' for i in range(7)])
        self.assertEqual([b['offset'] for b in client.bodies], [0, 3, 6])
        self.assertEqual((client.bodies[0]['syy'], client.bodies[0]['smtCd'], client.bodies[0]['searchType'], client.bodies[0]['subjtNm']), ('2026', '20', '02', None))

    def test_rejected_conditions(self):
        with self.assertRaises(fc.SearchRejected):
            fc.results_of({'invalidCode': 'E01', 'lectureRoms': {}})
        with self.assertRaises(fc.SearchRejected):
            fc.results_of({'prohibitType': 'BLOCK', 'lectureRoms': {}})
        self.assertEqual(fc.results_of(RESP)[1], 4)

    def test_colleges_and_units(self):
        codes = {'colleges': [{'univCd': '20628', 'deptCd': '20628', 'deptNm': '공과대학'}, {'univCd': None, 'deptCd': '20647', 'deptNm': '바이오융합대학'},
                              {'univCd': '20110', 'deptCd': '20110', 'deptNm': '공과대학(2017년 폐지)'}, {'univCd': '30001', 'deptCd': '30001', 'deptNm': '일반대학원'}],
                 'departments': [{'univCd': '20628', 'deptCd': '20638', 'deptNm': '전자공학부', 'useYn': '1'}]}
        self.assertEqual([u['name'] for u in fc.active_colleges(codes)], ['공과대학', '바이오융합대학'])
        self.assertEqual(fc.active_colleges(codes)[1]['univCd'], '20647')
        self.assertEqual(len(fc.active_colleges(codes, include_grad=True)), 3)
        self.assertEqual([(u['univCd'], u['deptCd']) for u in fc.find_units(codes, ['공과대학', '전자공학부', '전자공학'])], [('20628', '20628'), ('20628', '20638'), ('20628', '20638')])

    def test_from_raw_cli_writes_courses_json(self):
        with tempfile.TemporaryDirectory() as d:
            out = Path(d) / 'courses.json'
            self.assertEqual(fc.main(['--from-raw', str(FIX), '--out', str(out), '--year', '2026', '--semester', '2']), 0)
            j = json.loads(out.read_text(encoding='utf-8'))
            self.assertEqual((j['meta']['semesterName'], j['meta']['count'], len(j['courses'])), ('2학기', 4, 4))
            self.assertEqual(sorted(c['name'] for c in j['courses'])[0], '데이터베이스')

    def test_main_all_colleges_and_names_with_fake_server(self):
        bodies = []

        class FakeServer:
            def __init__(self, **kw):
                self.calls = 0

            def open_page(self):
                pass

            def request(self, url, body=None):
                self.calls += 1
                if url == fc.CODES_URL:
                    return {'collegeList': [{'univCd': '20628', 'deptCd': '20628', 'deptNm': '공과대학'}, {'univCd': '20428', 'deptCd': '20428', 'deptNm': '교양대학'}],
                            'departmentList': [], 'commonCdList': [{'cmmnCd': 'SCUR0100', 'cmmnCdVal': '02', 'cdValNm': '전공선택'}]}
                bodies.append(body)
                if body['searchType'] == '01' and not body['subjtNm']:
                    raise fc.SearchRejected('HTTP 500')
                rows = ROWS[:2] if body.get('univCd') == '20628' else ROWS[2:]
                if body['searchType'] == '01':
                    rows = [r for r in ROWS if body['subjtNm'] in r['subjectNm']]
                return {'invalidCode': None, 'prohibitType': 'NONE', 'lectureRoms': {'results': rows[body['offset']:body['offset'] + body['limit']], 'totalCount': len(rows)}}

        real = fc.Client
        fc.Client = FakeServer
        try:
            with tempfile.TemporaryDirectory() as d:
                out = Path(d) / 'c.json'
                self.assertEqual(fc.main(['--out', str(out), '--delay', '0']), 0)
                j = json.loads(out.read_text(encoding='utf-8'))
                self.assertEqual((j['meta']['mode'], j['meta']['count']), ('all-colleges', 4))
                self.assertEqual({b['searchType'] for b in bodies}, {'02'})
                bodies.clear()
                self.assertEqual(fc.main(['--out', str(out), '--name', '회로이론', '--name', '없는과목']), 0)
                j = json.loads(out.read_text(encoding='utf-8'))
                self.assertEqual((j['meta']['mode'], [c['name'] for c in j['courses']]), ('selected', ['회로이론II']))
                self.assertEqual([b['subjtNm'] for b in bodies], ['회로이론', '없는과목'])
        finally:
            fc.Client = real


if __name__ == '__main__':
    unittest.main()
