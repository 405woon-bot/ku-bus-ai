"""실서비스 빌드(frontend/dist) + 백엔드 e2e. 서울시 API 자리에 테스트 고정 응답을 넣은 서버(8801)와 키 없는 서버(8802)를 씁니다.
실행: cd frontend && npm run build  →  node backend/scripts/e2eServer.js &  →  python test/e2e_live.py"""
import datetime, re, sys, time
from pathlib import Path
from playwright.sync_api import sync_playwright

OUT = Path(__file__).resolve().parent / 'screenshots'
OUT.mkdir(exist_ok=True)
KST = datetime.timezone(datetime.timedelta(hours=9))
T0 = datetime.datetime(2026, 11, 9, 8, 10, 0, tzinfo=KST)      # 월 08:10 (서버 시계와 같게)
CLASS = {'name': '자료구조', 'day': 0, 'start': '09:00', 'end': '10:15', 'building': '미래관', 'room': '301'}
res = []
def check(n, c, d=''): res.append(('PASS' if c else 'FAIL') + f' {n} {d}')
PUSH_STUB = """
  PushManager.prototype.getSubscription = async function () { return null; };
  PushManager.prototype.subscribe = async function () {
    return { endpoint: 'https://push.example.invalid/e2e', toJSON() { return { endpoint: this.endpoint, keys: { p256dh: 'BOrE2Ep256dhKey', auth: 'e2eAuth' } }; } };
  };"""
hhmm = lambda m: f'{int(m // 60):02d}:{int(m % 60):02d}'
flat = lambda s: re.sub(r'\s+', ' ', s).strip()

def context(b, p, port, uid, **kw):
    ctx = b.new_context(**kw)
    ctx.grant_permissions(['notifications'], origin=f'http://localhost:{port}')
    ctx.add_init_script(f"try{{localStorage.setItem('kubusai:user','{uid}')}}catch(e){{}}" + PUSH_STUB)
    return ctx

def api(ctx, port, uid, method, path, data=None):
    r = ctx.request.fetch(f'http://localhost:{port}{path}', method=method, headers={'x-user-id': uid, 'content-type': 'application/json'}, data=data)
    return r.json()

with sync_playwright() as p:
    b = p.chromium.launch()
    uid = f'e2e{int(time.time())}'

    # ① 서울시 응답 서버: 처음 화면(정류장 고르기) → 정류장 검색·선택 → 홈 3요소
    ctx = context(b, p, 8801, uid, viewport={'width': 1440, 'height': 1000})
    api(ctx, 8801, uid, 'PUT', '/api/me/timetable', {'classes': [CLASS]})
    pg = ctx.new_page(); errs = []
    pg.on('pageerror', lambda e: errs.append(str(e)))
    pg.clock.install(time=T0)
    pg.goto('http://localhost:8801/')
    pg.get_by_text('어느 정류장에서 버스를 타세요?').wait_for(timeout=10000)
    check('처음 화면: 탑승 정류장 고르기(입력창 하나)', pg.locator('input[type="search"]').count() == 1)
    pg.locator('input[type="search"]').fill('정릉')
    pg.get_by_role('button', name=re.compile('정릉시장.*08901')).click(timeout=10000)
    card = pg.locator('section[aria-label="출발 추천"]'); card.wait_for(timeout=10000)
    pg.wait_for_selector('[data-testid="data-line"] [data-source="seoul"]', timeout=10000)
    for _ in range(50):  # 화면이 탑승 정류장을 서버에 저장(0.4초 뒤)할 때까지
        if (api(ctx, 8801, uid, 'GET', '/api/me').get('stop') or {}).get('arsId') == '08901': break
        pg.wait_for_timeout(100)
    plan = api(ctx, 8801, uid, 'GET', '/api/plan')
    pick = plan['rec']['pick']
    t = flat(card.inner_text())
    check('출발 추천 = 서버 /api/plan', f"{hhmm(pick['departMin'])} 출발" in t and f"{hhmm(pick['boardMin'])} 탑승" in t and pick['trip']['no'] in t, f"{t} / {hhmm(pick['departMin'])}")
    check('추천 버스: 171번 08:30 탑승 → 08:25 출발', '08:25' in t and '171' in t and '08:30 탑승' in t, t)
    bus = flat(pg.locator('section[aria-label="실시간 버스 도착"]').inner_text())
    check('실시간 버스: 도착 예정 + 도로 정체 태그 + 정체 원인', '171번 버스 3분 후 도착' in bus and '도로 정체 혼잡' in bus and '정릉로 정체' in bus, bus)
    arrive = flat(pg.locator('section[aria-label="강의실 도착 예정"]').inner_text())
    check('강의실 도착 예정 + 상태', '강의실 도착 예정' in arrive and '여유' in arrive and '자료구조 09:00 시작' in arrive, arrive)
    line = flat(pg.locator('[data-testid="data-line"]').inner_text())
    check('출처 배지: 서울시 실시간 + 갱신 시각', line.startswith('서울시 실시간') and '갱신' in line, line)
    check('예시 데이터 안내 없음', pg.locator('[data-testid="fallback-notice"]').count() == 0)
    me = api(ctx, 8801, uid, 'GET', '/api/me')
    check('서버에 탑승 정류장 저장', (me.get('stop') or {}).get('arsId') == '08901', str(me.get('stop')))
    pg.screenshot(path=str(OUT / 'live_desktop_home.png'))

    # 설정: 데이터 · 서버 연결
    pg.get_by_role('link', name='설정').first.click()
    pg.get_by_text('데이터 · 서버 연결').wait_for(timeout=5000)
    check('설정: 실시간 데이터 배지(서울시 실시간)', pg.locator('[data-source="seoul"]').count() >= 1)
    check('설정: 서버와 동기화됨(synced)', pg.get_by_text('서버와 동기화됨(synced)').count() == 1)
    pg.get_by_role('button', name='서버 푸시 켜기').click()
    pg.wait_for_selector('text=서버 푸시 켜짐(synced)', timeout=10000)
    check('서버 푸시 켜기 → synced + 서버에 구독 1개', api(ctx, 8801, uid, 'GET', '/api/me')['pushSubscriptions'] == 1)
    pg.screenshot(path=str(OUT / 'live_desktop_settings.png'), full_page=True)

    # 시간표: 수업 검색(서버 /api/courses) → 추가 → 서버에 강의 묶음 번호와 함께 저장
    pg.get_by_role('link', name='시간표').first.click()
    search = pg.locator('section[aria-label="수업 검색"] input[type="search"]'); search.wait_for(timeout=5000)
    check('수업 검색: 강의 목록 정보(학기·개수)', '2026년 2학기 강의' in pg.locator('[data-testid="course-meta"]').inner_text())
    search.fill('회로이론')
    row = pg.locator('[data-testid="course-row"]').filter(has_text='회로이론II').filter(has_text='04분반').first
    row.get_by_role('button', name='추가').click(timeout=8000)
    pg.wait_for_selector('[data-block]:has-text("회로이론II")', timeout=5000)
    saved = []
    for _ in range(30):
        saved = [c for c in api(ctx, 8801, uid, 'GET', '/api/me')['classes'] if c.get('courseId')]
        if saved: break
        pg.wait_for_timeout(100)
    check('수업 검색으로 추가 → 서버에 저장(요일·시간·강의실·묶음 번호)', [(c['name'], c['day'], c['start'], c['end'], c['building'], c['room']) for c in saved] == [('회로이론II', 4, '09:00', '12:00', '미래관', '337')], str(saved))
    pg.screenshot(path=str(OUT / 'live_desktop_timetable.png'))
    check('페이지 오류 없음', not errs, str(errs)[:200])
    ctx.close()

    # ② 휴대폰(iPhone 13): 같은 사용자 — 3요소가 탭 바 위에 모두 보임
    ctx = context(b, p, 8801, uid, **p.devices['iPhone 13'])
    pg = ctx.new_page(); pg.clock.install(time=T0); pg.goto('http://localhost:8801/')
    pg.wait_for_selector('[data-testid="data-line"] [data-source="seoul"]', timeout=10000)
    ov = pg.evaluate('document.documentElement.scrollWidth - document.documentElement.clientWidth')
    third = pg.locator('section[aria-label="강의실 도착 예정"]').bounding_box(); tab = pg.locator('nav.fixed').bounding_box()
    check('[iPhone 13] 가로 넘침 없음 · 3요소가 스크롤 없이 보임', ov <= 0 and third['y'] + third['height'] <= tab['y'], f"ov={ov} bottom={third['y'] + third['height']:.0f} tab={tab['y']:.0f}")
    pg.screenshot(path=str(OUT / 'live_iphone13_home.png'))
    ctx.close()

    # ③ 키 없는 서버: 정류장 검색은 이유 안내, 고른 정류장은 예시 데이터(점선) + 이유, 서버 푸시는 VAPID 없음
    uid2 = uid + 'k'
    ctx = context(b, p, 8802, uid2, viewport={'width': 1280, 'height': 900})
    api(ctx, 8802, uid2, 'PUT', '/api/me/timetable', {'classes': [CLASS]})
    pg = ctx.new_page(); errs = []
    pg.on('pageerror', lambda e: errs.append(str(e)))
    pg.clock.install(time=T0); pg.goto('http://localhost:8802/')
    pg.get_by_text('어느 정류장에서 버스를 타세요?').wait_for(timeout=10000)
    pg.locator('input[type="search"]').fill('정릉')
    pg.wait_for_selector('text=서울시 버스 API 키가 없어', timeout=8000)
    check('키 없음: 정류장 검색 이유 안내', True)
    api(ctx, 8802, uid2, 'PATCH', '/api/me', {'stop': {'arsId': '08901', 'name': '정릉시장'}})
    pg.reload()
    pg.wait_for_selector('[data-testid="fallback-notice"]', timeout=10000)
    line = flat(pg.locator('[data-testid="data-line"]').inner_text())
    check('키 없음: 예시 데이터 · API 키 없음 배지', '예시 데이터 · API 키 없음' in line, line)
    check('키 없음: 출발 추천 카드가 점선(예시 데이터 기준)', pg.locator('section[aria-label="출발 추천"][data-source="mock"]').count() == 1
          and '예시 데이터 기준' in pg.locator('section[aria-label="출발 추천"]').inner_text())
    pg.screenshot(path=str(OUT / 'nokey_desktop_home.png'))
    pg.get_by_role('link', name='설정').first.click()
    pg.get_by_role('button', name='서버 푸시 켜기').wait_for(timeout=5000)
    check('키 없음: 서버 푸시 키(VAPID) 없음 안내', pg.get_by_text('VAPID').count() >= 1)
    pg.get_by_role('link', name='시간표').first.click()
    pg.locator('section[aria-label="수업 검색"] input[type="search"]').fill('회로')
    pg.wait_for_selector('text=fetch_courses.py', timeout=5000)
    check('강의 목록이 없는 서버: 수업 검색 안내(fetch_courses.py)', '강의 목록이 아직 없어요' in pg.locator('[data-testid="course-meta"]').inner_text())
    check('키 없음: 페이지 오류 없음', not errs, str(errs)[:200])
    ctx.close(); b.close()

print('\n'.join(res)); n = sum(r.startswith('FAIL') for r in res)
print(f'{len(res) - n} passed, {n} failed'); sys.exit(1 if n else 0)
