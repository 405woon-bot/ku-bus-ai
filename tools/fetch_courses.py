#!/usr/bin/env python3
"""국민대 수강신청 '강좌조회(수업계획서)'의 공개 강의 목록 → courses.json

수강신청 사이트 화면(https://sugang.kookmin.ac.kr/front/enrollment/course-catalog)이 쓰는 공개 조회 API를 그대로 부릅니다.
  POST /api/subject/public/lectures/conditions/validation/ko    강의 검색(로그인 필요 없음)
       searchType "01" = 기본검색(과목명·교과목번호·교수명 중 하나 필요)
       searchType "02" = 개설강좌(대학·학부(과) 단위 — 조건 없이 '전체'는 서버가 받지 않으므로 대학별로 나눠 모음)
  GET  /api/subject/public/commoncodes/all                       대학·학과 목록과 코드표(이수구분 등)

사용 예 (프로젝트 폴더에서)
  python tools/fetch_courses.py                                  2026년 2학기 학부 전체(대학별 개설강좌)
  python tools/fetch_courses.py --year 2027 --semester 1         다른 학기
  python tools/fetch_courses.py --name 회로이론 --name 자료구조     주요 과목만(과목명 검색)
  python tools/fetch_courses.py --names-file tools/my_courses.txt  과목명 목록 파일(한 줄에 하나)
  python tools/fetch_courses.py --college 공과대학 --dept 경영학부   대학·학과 단위
  python tools/fetch_courses.py --from-raw raw.json              저장해 둔 응답 파일을 변환만(네트워크 없음)

결과: backend/courses/courses.json  (서버가 읽어 '수업 검색'에 씀)

예의 지키기: 학기마다 한 번만 실행하고, 요청 사이에 1초씩 쉽니다(--delay). 수강신청 기간처럼 접속이 몰리는 때는 피하고,
학교 정보시스템 이용 규정을 따르세요. 수강신청(장바구니·신청) 기능은 부르지 않습니다.
표준 라이브러리만 씁니다(Python 3.9 이상, 따로 설치할 것 없음).
"""
from __future__ import annotations

import argparse
import datetime as dt
import http.cookiejar
import json
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

BASE = 'https://sugang.kookmin.ac.kr'
SEARCH_URL = BASE + '/api/subject/public/lectures/conditions/validation/ko'
CODES_URL = BASE + '/api/subject/public/commoncodes/all'
PAGE_URL = BASE + '/front/enrollment/course-catalog'
DEFAULT_OUT = Path(__file__).resolve().parent.parent / 'backend' / 'courses' / 'courses.json'

SEMESTERS = {'1': '10', '1학기': '10', '10': '10', '여름': '11', '여름학기': '11', '11': '11',
             '2': '20', '2학기': '20', '20': '20', '겨울': '21', '겨울학기': '21', '21': '21'}
SEMESTER_NAMES = {'10': '1학기', '11': '여름학기', '20': '2학기', '21': '겨울학기'}
DAYS = {'MONDAY': 0, 'TUESDAY': 1, 'WEDNESDAY': 2, 'THURSDAY': 3, 'FRIDAY': 4, 'SATURDAY': 5, 'SUNDAY': 6}
DAY_NAMES = ['월', '화', '수', '목', '금', '토', '일']
# 공통코드 SCUR0100(이수구분) — 코드표를 못 받으면 이 값을 씀
CATEGORY_FALLBACK = {'01': '전공필수', '02': '전공선택', '03': '교양필수', '04': '교양선택', '05': '기초공통', '06': '일반선택',
                     '07': '부전공', '08': '교직', '09': '복수전공', '10': '교양기초', '11': '계열교양', '12': '학부(과)기초',
                     '13': '학부전공', '14': '기초과목', '15': '공통필수', '16': '공통선택', '17': '교직선택', '18': '선수과목',
                     '40': '기초교양', '41': '전공기초교양'}

# 브라우저 화면이 보내는 요청 본문과 같은 모양(값이 없는 조건은 null)
BLANK = {'syy': None, 'smtCd': None, 'locale': 'ko', 'searchType': '01', 'subjtCd': None, 'subjtNm': None, 'professorNm': None,
         'professorNo': None, 'daywCd': None, 'lessnLestmCd': None, 'cmpsjCdt': None, 'cmpsjDivCd': None, 'cltrDomnCd': None,
         'dghtDivCd': None, 'univCd': None, 'deprtCd': None, 'bchdmCntcSubjtYn': None, 'srclnLctreLangDivCd': None,
         'studentUnivDeptCd': None, 'scheduleSeq': None, 'grade': None, 'estblCrseDivCd': None, 'apntPriorSubjtYn': None,
         'offset': 0, 'limit': 100, 'scheduleDivCd': None}


class Client:
    """쿠키를 유지하는 아주 작은 HTTP 클라이언트(화면을 한 번 열어 받은 쿠키로 API를 부름)"""

    def __init__(self, delay=1.0, timeout=20, user_agent=None, verbose=True):
        self.delay, self.timeout, self.verbose = delay, timeout, verbose
        self.opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))
        self.headers = {
            'Accept': 'application/json, text/plain, */*',
            'Accept-Language': 'ko-KR,ko;q=0.9',
            'Origin': BASE,
            'Referer': PAGE_URL,
            'User-Agent': user_agent or 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) '
                                        'Chrome/140.0 Safari/537.36 KU-BUS-AI-timetable/0.4',
        }
        self.calls = 0
        self._last = 0.0

    def _wait(self):
        gap = time.time() - self._last
        if gap < self.delay:
            time.sleep(self.delay - gap)
        self._last = time.time()

    def request(self, url, body=None, tries=3):
        data = json.dumps(body, ensure_ascii=False).encode('utf-8') if body is not None else None
        headers = dict(self.headers, **({'Content-Type': 'application/json;charset=UTF-8'} if data else {}))
        for attempt in range(1, tries + 1):
            self._wait()
            self.calls += 1
            try:
                with self.opener.open(urllib.request.Request(url, data=data, headers=headers, method='POST' if data else 'GET'), timeout=self.timeout) as r:
                    raw = r.read().decode('utf-8', errors='replace')
                    return json.loads(raw) if raw.strip().startswith(('{', '[')) else raw
            except urllib.error.HTTPError as e:
                if e.code in (400, 404, 500):   # 서버가 받지 않는 조건 — 다시 해도 같음
                    raise SearchRejected(f'HTTP {e.code}') from None
                if attempt == tries:
                    raise
            except (urllib.error.URLError, TimeoutError) as e:
                if attempt == tries:
                    raise
                if self.verbose:
                    print(f'  ! 연결 문제({e}), {attempt * 3}초 뒤 다시 시도', file=sys.stderr)
            time.sleep(attempt * 3)
        return None

    def open_page(self):
        """화면을 한 번 열어 사이트 쿠키를 받음(브라우저와 같은 순서). 실패해도 계속 진행."""
        try:
            self._wait()
            self.calls += 1
            with self.opener.open(urllib.request.Request(PAGE_URL, headers={'User-Agent': self.headers['User-Agent']}), timeout=self.timeout) as r:
                r.read()
        except Exception as e:  # noqa: BLE001 — 페이지가 안 열려도 API는 될 수 있음
            if self.verbose:
                print(f'  (안내) 강좌조회 화면을 열지 못했어요: {e}', file=sys.stderr)


class SearchRejected(Exception):
    """검색 조건을 서버가 받지 않음(예: 기본검색인데 과목명이 없음)"""


# ───────────────────────── 응답 → 강의 한 건 ─────────────────────────

def hhmm(t):
    return f"{int(t['hour']):02d}:{int(t['minute']):02d}"


def merge_slots(lecture_times):
    """30분 칸(lectureTimes) → 요일별 연속 구간. 같은 요일·같은 강의실에서 끝 시각 = 다음 시작 시각이면 하나로 합침"""
    slots = []
    for s in lecture_times or []:
        day = DAYS.get(str(s.get('dayOfWeek', '')).upper())
        if day is None or not s.get('start') or not s.get('end'):
            continue
        slots.append({'day': day, 'start': hhmm(s['start']), 'end': hhmm(s['end']), 'room': (s.get('classRoomName') or '').strip()})
    slots.sort(key=lambda x: (x['day'], x['start'], x['room']))
    blocks = []
    for s in slots:
        b = blocks[-1] if blocks else None
        if b and b['day'] == s['day'] and b['room'] == s['room'] and b['end'] == s['start']:
            b['end'] = s['end']
        elif b and b['day'] == s['day'] and b['room'] == s['room'] and b['start'] <= s['start'] < b['end']:
            b['end'] = max(b['end'], s['end'])   # 같은 칸이 두 번 온 경우(교수 두 명 등)
        else:
            blocks.append(dict(s))
    return blocks


def time_text(times):
    if not times:
        return '시간 미정'
    return ' · '.join(f"{DAY_NAMES[t['day']]} {t['start']}-{t['end']}" for t in times)


def normalize(lec, codes=None):
    """API 강의 한 건 → courses.json 한 건(앱이 쓰는 필드만, 교번 등 개인 식별 번호는 뺌)"""
    codes = codes or {}
    credits = lec.get('credits') or {}
    times = merge_slots((lec.get('schedule') or {}).get('lectureTimes'))
    dept_code = lec.get('assignedDepartmentCode') or ''
    year, smt = str(lec.get('year') or ''), str(lec.get('semesterCode') or '')
    code, section = str(lec.get('subjectId') or ''), str(lec.get('classSequence') or '')
    return {
        'id': f'{year}-{smt}-{code}-{section}',
        'code': code,
        'section': section,
        'name': (lec.get('subjectNm') or '').strip(),
        'professor': (lec.get('professorName') or '').strip(),
        'credits': credits.get('credit'),
        'theory': credits.get('theoryTime'),
        'practice': credits.get('practiceTime'),
        'category': codes.get('category', CATEGORY_FALLBACK).get(str(lec.get('categoryCode') or ''), ''),
        'categoryCode': lec.get('categoryCode') or '',
        'dayNight': {'Day': '주간', 'Night': '야간'}.get(lec.get('dayTime'), lec.get('dayTime') or ''),
        'grades': list(((lec.get('grades') or {}).get('elements')) or []),
        'department': codes.get('dept', {}).get(dept_code, ''),
        'departmentCode': dept_code,
        'type': lec.get('type') or '',
        'foreignLanguage': bool(lec.get('foreignLanguage')),
        'closed': bool(lec.get('closed')),
        'remark': (lec.get('remark') or '').strip(),
        'times': times,
        'timeText': time_text(times),
    }


def results_of(resp):
    """검색 응답 → (강의 목록, 전체 건수). 서버가 조건을 거절하면 SearchRejected"""
    if not isinstance(resp, dict):
        raise SearchRejected('응답 형식이 달라요')
    if resp.get('invalidCode') or (resp.get('prohibitType') not in (None, 'NONE')):
        raise SearchRejected(f"검색 조건 거절: {resp.get('invalidCode') or resp.get('prohibitType')} {resp.get('warningMessage') or ''}".strip())
    rom = resp.get('lectureRoms') or {}
    return list(rom.get('results') or []), int(rom.get('totalCount') or 0)


# ───────────────────────── 조회 방식 ─────────────────────────

def search_all_pages(client, year, smt, patch, limit, label):
    """한 가지 조건으로 마지막 쪽까지(offset을 limit씩 늘림). 묶음 강의가 함께 오면 쪽마다 한두 건 더 올 수 있어 id로 중복 제거"""
    out, offset, total = {}, 0, None
    while True:
        body = dict(BLANK, syy=str(year), smtCd=smt, offset=offset, limit=limit, **patch)
        rows, total = results_of(client.request(SEARCH_URL, body))
        for r in rows:
            out[str(r.get('id') or f"{r.get('subjectId')}-{r.get('classSequence')}")] = r
        offset += limit
        if not rows or offset >= total:
            break
    print(f'  {label}: {len(out)}건' + (f' (서버 집계 {total})' if total is not None and total != len(out) else ''))
    return list(out.values())


def load_codes(client):
    """대학·학과 목록과 이수구분 코드표"""
    try:
        j = client.request(CODES_URL)
    except Exception as e:  # noqa: BLE001
        print(f'  (안내) 코드표를 받지 못해 기본 이수구분 표를 씁니다: {e}', file=sys.stderr)
        return {'colleges': [], 'departments': [], 'category': CATEGORY_FALLBACK, 'dept': {}}
    cat = {c['cmmnCdVal']: c['cdValNm'] for c in j.get('commonCdList', []) if c.get('cmmnCd') == 'SCUR0100'} or CATEGORY_FALLBACK
    depts = j.get('departmentList', [])
    return {'colleges': j.get('collegeList', []), 'departments': depts, 'category': cat,
            'dept': {d['deptCd']: d['deptNm'] for d in depts if d.get('deptCd')}}


def active_colleges(codes, include_grad=False):
    """현재 쓰는 대학(폐지 제외). 학부는 univCd가 2로 시작, 대학원은 3으로 시작"""
    out = []
    for c in codes['colleges']:
        name, univ = c.get('deptNm') or '', c.get('univCd') or c.get('deptCd')
        if not univ or '폐지' in name or c.get('useYn') == '0':
            continue
        if univ.startswith('2') or (include_grad and univ.startswith('3')):
            out.append({'univCd': univ, 'deptCd': c.get('deptCd') or univ, 'name': name})
    return out


def find_units(codes, names):
    """'공과대학'·'전자공학부' 같은 이름 → 검색 단위(대학 코드, 학과 코드)"""
    units = []
    for want in names:
        hit = [c for c in codes['colleges'] if (c.get('deptNm') or '').replace(' ', '') == want.replace(' ', '')]
        hit = hit or [d for d in codes['departments'] if (d.get('deptNm') or '').replace(' ', '') == want.replace(' ', '') and d.get('useYn') != '0']
        hit = hit or [d for d in codes['departments'] if want.replace(' ', '') in (d.get('deptNm') or '').replace(' ', '') and d.get('useYn') != '0']
        if not hit:
            print(f'  ! "{want}"에 맞는 대학·학과를 코드표에서 찾지 못했어요', file=sys.stderr)
            continue
        d = hit[0]
        units.append({'univCd': d.get('univCd') or d.get('deptCd'), 'deptCd': d.get('deptCd'), 'name': d.get('deptNm')})
    return units


def write_courses(courses, out_path, meta):
    out_path.parent.mkdir(parents=True, exist_ok=True)
    courses = sorted(courses, key=lambda c: (c['name'], c['code'], c['section']))
    lines = ',\n'.join(json.dumps(c, ensure_ascii=False, separators=(',', ':')) for c in courses)
    head = json.dumps(dict(meta, count=len(courses)), ensure_ascii=False, separators=(',', ':'))
    out_path.write_text(f'{{"meta":{head},"courses":[\n{lines}\n]}}\n', encoding='utf-8')
    return len(courses)


def main(argv=None):
    p = argparse.ArgumentParser(description='국민대 강좌조회 → courses.json')
    p.add_argument('--year', default='2026', help='학년도 (기본 2026)')
    p.add_argument('--semester', default='2', help='학기: 1, 여름, 2, 겨울 (또는 코드 10/11/20/21, 기본 2)')
    p.add_argument('--name', action='append', default=[], help='과목명으로 찾기(여러 번 가능). 주면 그 과목만 모음')
    p.add_argument('--names-file', help='과목명 목록 파일(한 줄에 하나, # 줄은 무시)')
    p.add_argument('--college', action='append', default=[], help='대학 이름(예: 공과대학)으로 모으기')
    p.add_argument('--dept', action='append', default=[], help='학부(과) 이름(예: 전자공학부)으로 모으기')
    p.add_argument('--include-grad', action='store_true', help='전체 모드에서 대학원 강좌도 포함')
    p.add_argument('--limit', type=int, default=100, help='한 번에 받을 건수(기본 100)')
    p.add_argument('--delay', type=float, default=1.0, help='요청 사이 쉬는 시간(초, 기본 1.0)')
    p.add_argument('--out', default=str(DEFAULT_OUT), help=f'저장 위치(기본 {DEFAULT_OUT})')
    p.add_argument('--raw', help='받은 원본 강의 목록도 이 파일에 저장(문제 확인용)')
    p.add_argument('--from-raw', help='네트워크 없이, --raw로 저장한 파일을 courses.json으로 변환만')
    p.add_argument('--user-agent', help='User-Agent를 바꿔야 할 때')
    a = p.parse_args(argv)

    smt = SEMESTERS.get(str(a.semester).strip())
    if not smt:
        p.error('--semester는 1, 여름, 2, 겨울 중 하나예요')
    out_path = Path(a.out)
    meta = {'source': '국민대학교 수강신청 강좌조회(공개)', 'year': str(a.year), 'semester': smt,
            'semesterName': SEMESTER_NAMES[smt], 'fetchedAt': dt.datetime.now(dt.timezone(dt.timedelta(hours=9))).isoformat(timespec='seconds')}

    if a.from_raw:
        raw = json.loads(Path(a.from_raw).read_text(encoding='utf-8'))
        rows = raw.get('lectureRoms', {}).get('results', raw) if isinstance(raw, dict) else raw
        n = write_courses([normalize(r) for r in rows], out_path, dict(meta, mode='from-raw'))
        print(f'변환 완료: {n}건 → {out_path}')
        return 0

    names = list(a.name)
    if a.names_file:
        names += [s.strip() for s in Path(a.names_file).read_text(encoding='utf-8').splitlines() if s.strip() and not s.strip().startswith('#')]

    client = Client(delay=a.delay, user_agent=a.user_agent)
    print(f'국민대 강좌조회 {a.year}년 {SEMESTER_NAMES[smt]} — 요청 사이 {a.delay}초씩 쉽니다')
    client.open_page()
    codes = load_codes(client)
    rows, mode = {}, ''

    def collect(patch, label):
        try:
            for r in search_all_pages(client, a.year, smt, patch, a.limit, label):
                rows[str(r.get('id'))] = r
        except SearchRejected as e:
            print(f'  ! {label}: 서버가 받지 않는 조건이에요({e}) — 건너뜀', file=sys.stderr)

    if names or a.college or a.dept:
        mode = 'selected'
        for n in names:
            collect({'searchType': '01', 'subjtNm': n}, f'과목명 "{n}"')
        for u in find_units(codes, a.college + a.dept):
            collect({'searchType': '02', 'univCd': u['univCd'], 'deprtCd': u['deptCd']}, u['name'])
    else:
        mode = 'all-colleges'
        units = active_colleges(codes, a.include_grad)
        if not units:
            print('대학 목록을 받지 못했어요. --name 으로 과목을 지정해 다시 실행해 주세요.', file=sys.stderr)
            return 2
        for u in units:
            collect({'searchType': '02', 'univCd': u['univCd'], 'deprtCd': u['deptCd']}, u['name'])

    if a.raw:
        Path(a.raw).write_text(json.dumps(list(rows.values()), ensure_ascii=False), encoding='utf-8')
    courses = [normalize(r, codes) for r in rows.values()]
    n = write_courses(courses, out_path, dict(meta, mode=mode))
    timed = sum(1 for c in courses if c['times'])
    print(f'완료: 강의 {n}건(시간표 시간이 있는 강의 {timed}건) → {out_path}  · 요청 {client.calls}회')
    return 0


if __name__ == '__main__':
    sys.exit(main())
