"""실서비스 빌드(frontend/dist) + 백엔드 e2e. 서울시 API 자리에 테스트 고정 응답을 넣은 서버(8801)와 키 없는 서버(8802)를 씁니다.
실행: cd frontend && npm run build  →  cd backend && node scripts/e2eServer.js &  →  python test/e2e_live.py"""
import datetime, json, re, sys, time
from pathlib import Path
from playwright.sync_api import sync_playwright

OUT = Path(__file__).resolve().parent / 'screenshots'
KST = datetime.timezone(datetime.timedelta(hours=9))
T0 = datetime.datetime(2026, 11, 9, 8, 10, 0, tzinfo=KST)      # 월 08:10
res = []
def check(n, c, d=''): res.append(('PASS' if c else 'FAIL') + f' {n} {d}')
PUSH_STUB = """
  PushManager.prototype.getSubscription = async function () { return null; };
  PushManager.prototype.subscribe = async function () {
    return { endpoint: 'https://push.example.invalid/e2e', toJSON() { return { endpoint: this.endpoint, keys: { p256dh: 'BOrE2Ep256dhKey', auth: 'e2eAuth' } }; } };
  };"""

def api(pg, path):
    return pg.evaluate("""async (path) => { const r = await fetch(path, { headers: { 'x-user-id': localStorage.getItem('kubusai:user') } }); return await r.json(); }""", path)

with sync_playwright() as p:
    b = p.chromium.launch()
    uid = f'e2e{int(time.time())}'
    ctx = b.new_context(viewport={'width': 1440, 'height': 1000})
    ctx.grant_permissions(['notifications'], origin='http://localhost:8801')
    ctx.add_init_script(f"try{{localStorage.setItem('kubusai:user','{uid}')}}catch(e){{}}" + PUSH_STUB)
    pg = ctx.new_page(); errs = []
    pg.on('pageerror', lambda e: errs.append(str(e)))
    pg.clock.install(time=T0)
    pg.goto('http://localhost:8801/')
    card = pg.locator('section[aria-label="등교 지연 알림"]')
    card.wait_for(timeout=10000)
    pg.wait_for_function("() => document.querySelector('section[aria-label=\"등교 지연 알림\"] [data-source]')", timeout=10000)
    first = card.locator('[data-source]').first.inner_text()
    check('승차 정류장 설정 전: 예시 데이터 · 승차 정류장 미설정', '예시 데이터' in first and '승차 정류장 미설정' in first, first)

    # 노선별 승차 정류장 번호 입력(설정 화면) → 서버 저장 → 서울시 실시간으로 전환
    pg.get_by_role('button', name='노선 정류장 불러오기').first.click()
    pg.wait_for_selector('text=정류장 11곳을 불러왔어요', timeout=5000)
    check('노선 정류장 불러오기(서울시 getStaionByRoute)', True)
    for no in ['171', '1711', '1112']:
        pg.fill(f'input[aria-label="{no}번 승차 정류장 번호"]', '08901')
    pg.wait_for_selector('section[aria-label="등교 지연 알림"] [data-source="seoul"]', timeout=12000)
    t = re.sub(r'\s+', ' ', card.inner_text())
    check('서울시 실시간 청색 배지', card.locator('[data-source="seoul"]').inner_text().strip().startswith('서울시 실시간'))
    check('실시간 기준 지연 문구', '현재 정릉로 정체로 171번 6분 지연! 8:33까지 출발을 권장합니다. (대체 추천: 후문 방향 1112번 탑승 시 정시 출발 가능)' in t, t[:200])
    check('다음 버스 도착(arrmsg1)', '3분후[1번째 전]' in pg.locator('[data-testid="arrival"]').first.inner_text())
    plan = api(pg, '/api/plan')
    ui = re.search(r'권장 출발 (\d\d:\d\d)', t)
    hhmm = lambda m: f'{m // 60:02d}:{m % 60:02d}'
    check('화면 권장 출발 = 서버 /api/plan', ui and ui.group(1) == hhmm(plan['plan']['recommendedDepartMin']) == '08:33', f"{ui.group(1) if ui else None} / {hhmm(plan['plan']['recommendedDepartMin'])}")
    me = api(pg, '/api/me')
    check('서버에 승차 정류장 저장', [r['boardArsId'] for r in me['routes']] == ['08901'] * 3)
    st = pg.inner_text('[data-testid="route-status-171"]')
    check('노선 상태: 차내 소요·중간 정류장', '서울시 실시간' in st and '중간 정류장 3곳' in st, st)
    live = api(pg, '/api/live?routes=171,1711,1112')
    check('/api/live: liveMin·usualMin·delayMin·status·cause', [[r['id'], r['liveMin'], r['usualMin'], r['delayMin'], r['status']['label'], r['cause']] for r in live['routes']][0] == ['171', 18, 12, 6, '+6분 지연', '정릉로'])

    # 서버 푸시 켜기 → VAPID 구독 등록 → 서버 저장(synced)
    pg.get_by_role('button', name='서버 푸시 켜기').click()
    pg.wait_for_selector('text=서버 푸시 켜짐(synced)', timeout=10000)
    check('서버 푸시: synced 표시 + 서버에 구독 1개', api(pg, '/api/me')['pushSubscriptions'] == 1)
    check('서버 동기화 칩', pg.locator('text=서버와 동기화됨(synced)').count() == 1)
    pg.screenshot(path=str(OUT / 'live_desktop.png'))
    toasts = pg.locator('[role="alert"]').all_inner_texts()
    check('예시 데이터 알림은 실시간 알림이 오면 치움', len(toasts) >= 1 and all('예시 교통 데이터' not in x for x in toasts), str([x[:40] for x in toasts]))
    hist = [h for h in (re.sub(r'\s+', ' ', x) for x in pg.locator('#settings li').all_inner_texts()) if '알림 ·' in h]
    check('최근 알림: 예시 데이터로 계산된 기록에만 출처 표시', any('+6분' in x and '예시' not in x for x in hist) and all(('예시 데이터 기준' in x) == ('+8분' in x) for x in hist if '지연 알림' in x), str(hist))
    card.scroll_into_view_if_needed(); card.screenshot(path=str(OUT / 'live_alert_card.png'))
    pg.locator('#settings').screenshot(path=str(OUT / 'live_settings.png'))
    check('페이지 오류 없음', not errs, str(errs)[:200])
    ctx.close()

    # 휴대폰 화면
    ctx = b.new_context(**p.devices['iPhone 13'])
    ctx.add_init_script(f"try{{localStorage.setItem('kubusai:user','{uid}')}}catch(e){{}}")
    pg = ctx.new_page(); pg.clock.install(time=T0); pg.goto('http://localhost:8801/')
    pg.wait_for_selector('section[aria-label="등교 지연 알림"] [data-source="seoul"]', timeout=10000)
    ov = pg.evaluate('document.documentElement.scrollWidth - document.documentElement.clientWidth')
    check('[iPhone 13] 서울시 실시간 표시 · 가로 넘침 없음', ov <= 0, str(ov))
    pg.screenshot(path=str(OUT / 'live_iphone13.png'))
    ctx.close()

    # 키 없는 서버: 예시 데이터 + 이유, 서버 푸시는 VAPID 없음 오류
    ctx = b.new_context(viewport={'width': 1280, 'height': 900})
    ctx.grant_permissions(['notifications'], origin='http://localhost:8802')
    ctx.add_init_script(PUSH_STUB)
    pg = ctx.new_page(); pg.clock.install(time=T0); pg.goto('http://localhost:8802/')
    pg.wait_for_function("() => document.querySelector('section[aria-label=\"등교 지연 알림\"] [data-source=\"mock\"]')", timeout=10000)
    tag = pg.locator('section[aria-label="등교 지연 알림"] [data-source="mock"]').inner_text()
    check('키 없음: 예시 데이터 · API 키 없음', 'API 키 없음' in tag, tag)
    pg.get_by_role('button', name='서버 푸시 켜기').click()
    pg.wait_for_selector('text=서버 푸시 오류(error)', timeout=8000)
    check('키 없음: 서버 푸시 error 안내', pg.locator('text=VAPID').count() >= 1)
    ctx.close(); b.close()

print('\n'.join(res)); n = sum(r.startswith('FAIL') for r in res)
print(f'{len(res) - n} passed, {n} failed'); sys.exit(1 if n else 0)
