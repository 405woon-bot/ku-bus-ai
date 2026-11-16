"""실서비스 빌드(frontend/dist) + 백엔드 e2e. 서울시 API 자리에 테스트 고정 응답을 넣은 서버(8801)와 키 없는 서버(8802)를 씁니다.
실행: cd frontend && npm run build  →  node backend/scripts/e2eServer.js &  →  python test/e2e_live.py"""
import datetime, json, re, sys, time
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
  (function () {
    var KEY = '__e2e_push_sub';
    function make() { return { endpoint: 'https://push.example.invalid/e2e', options: { applicationServerKey: null },
      toJSON: function () { return { endpoint: this.endpoint, keys: { p256dh: 'BOrE2Ep256dhKey', auth: 'e2eAuth' } }; },
      unsubscribe: async function () { try { localStorage.removeItem(KEY); } catch (e) {} return true; } }; }
    // 헤드리스 크롬은 권한을 줘도 Notification.permission이 'denied'로 보이는 문제가 있어(실제 브라우저와 다름) 허용 상태로 맞춤
    try { if (typeof Notification !== 'undefined') Object.defineProperty(Notification, 'permission', { get: function () { return 'granted'; }, configurable: true }); } catch (e) {}
    if (typeof PushManager !== 'undefined') {
      PushManager.prototype.getSubscription = async function () { try { return localStorage.getItem(KEY) ? make() : null; } catch (e) { return null; } };
      PushManager.prototype.subscribe = async function () { try { localStorage.setItem(KEY, '1'); } catch (e) {} return make(); };
    }
  })();"""
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
    # '왜 늦나요?' 한 줄(가짜 Gemini 응답): 171번이 혼잡 → 버스 카드 바로 아래 노란 줄 · AI 태그 · +11분(서버 계산) · 근거
    #  (지난번 '경로 주변 날씨 · 돌발정보' 줄 자리 — 근거를 펼치면 날씨 · 돌발정보가 함께 나옴)
    why = pg.locator('[data-testid="why-strip"]'); why.wait_for(timeout=8000)
    order = pg.evaluate('''() => [...document.querySelectorAll('section[aria-label]')].map(s => s.getAttribute('aria-label'))''')
    wt = flat(why.inner_text())
    check('왜 늦나요?: 버스 카드 다음 노란 줄 · AI 문장 · +11분 · 근거(경로 주변 줄 자리, 줄이 늘지 않음)', why.get_attribute('data-tone') == 'caution' and why.get_attribute('data-why') == 'ai'
          and order.index('왜 늦나요?') == order.index('실시간 버스 도착') + 1 and '정릉로 공사 구간에 비까지 겹쳐 버스가 많이 막혀요.' in wt and '+11분' in wt and '근거' in wt
          and '예시' not in wt and pg.locator('[data-testid="incident-strip"]').count() == 0, wt)
    why.get_by_role('button').first.click()
    wt = flat(why.inner_text())
    check('근거 펼침: 서버 계산(약 11분 더 · 평균 시속 6km) · 정릉로 · 비 1.5mm(08:00 관측) · 경로 위 공사 + 국민대 근처 행사(예정) · AI는 사실만',
          '원활할 때보다 약 11분 더 걸려요 · 평균 시속 6km' in wt and '171번 정릉시장 → 국민대학교앞 · 원활 기준 시속 20km' in wt
          and '정릉로 · 걷는 속도 수준으로 느림' in wt and '날씨 · 기상청 08:00 관측' in wt and '비 · 1시간 1.5mm' in wt
          and '공사 정릉로 하수관 정비공사(테스트) · 경로 위' in wt and '거리 행사(테스트) · 국민대 근처' in wt and '부터 예정' in wt
          and '봉은교' not in wt and '차량 고장' not in wt and '돌발정보 · 서울시 08:1' in wt
          and 'AI(Gemini)는 위 사실만 보고 문장을 썼어요' in wt and '정체의 원인이라고 확정하는 건 아니에요' in wt and '예시' not in wt, wt)
    pg.screenshot(path=str(OUT / 'live_desktop_why_open.png'))
    trips = api(ctx, 8801, uid, 'GET', '/api/stops/08901/trips')
    check('API: /api/stops/08901/trips에 incidents(seoul, 2건)', trips['incidents']['source'] == 'seoul' and [x['id'] for x in trips['incidents']['items']] == ['T-WORK', 'T-EVENT'], str(trips['incidents'])[:200])
    t171 = next(t for t in trips['trips'] if t['no'] == '171')
    facts = json.dumps(t171['explain']['facts'], ensure_ascii=False)
    check('API: 171 → delayMin 11(서버 계산) · explain gemini · AI에 넘긴 사실에는 숫자 없음 · 예정된 행사는 사실에서 뺌', t171.get('delayMin') == 11 and t171['explain']['source'] == 'gemini'
          and t171['explain']['facts']['가장 느린 도로'] == '정릉로' and not re.search(r'[0-9]', facts) and '거리 행사' not in facts, facts)
    why.get_by_role('button').first.click()
    ex = api(ctx, 8801, uid, 'GET', '/api/explain/test')
    check('API: /api/explain/test = 예시 사실(실시간 아님) · Gemini 문장', ex.get('example') is True and ex['result']['source'] == 'gemini' and '실시간 아님' in ex.get('note', ''), str(ex)[:200])
    # 기상청 초단기실황(가짜 응답): 서버에서만 부르고, 국민대 격자 60 · 128
    wx = api(ctx, 8801, uid, 'GET', '/api/weather')
    check('API: /api/weather = 기상청 · 격자 60,128 · 비 1.5mm · 원문(raw)', wx.get('source') == 'kma' and wx.get('grid') == {'nx': 60, 'ny': 128}
          and wx.get('ptyText') == '비' and wx.get('rn1Mm') == 1.5 and (wx.get('raw') or {}).get('PTY') == '1', str(wx)[:200])
    check('API: trips 응답에 weather(kma) · 원문 없음', trips.get('weather', {}).get('source') == 'kma' and 'raw' not in trips['weather'], str(trips.get('weather'))[:160])
    h = api(ctx, 8801, uid, 'GET', '/api/health')
    check('API: /api/health 날씨 상태(키 있음 · 마지막 관측)', h['weather']['keyConfigured'] and h['weather']['lastObs'] is not None and 'E2E-KMA-KEY' not in str(h), str(h['weather'])[:160])
    check('API: /api/health AI 설명 상태(키 있음 · gemini-3.5-flash-lite · 마지막 성공 · 키 노출 없음)', h['explain']['keyConfigured'] and h['explain']['model'] == 'gemini-3.5-flash-lite'
          and h['explain']['lastOkAt'] and h['explain']['lastError'] is None and 'E2E-GEMINI-KEY' not in str(h), str(h['explain'])[:200])
    me = api(ctx, 8801, uid, 'GET', '/api/me')
    check('서버에 탑승 정류장 저장', (me.get('stop') or {}).get('arsId') == '08901', str(me.get('stop')))
    pg.screenshot(path=str(OUT / 'live_desktop_home.png'))

    # 설정: 데이터 · 서버 연결
    pg.get_by_role('link', name='설정').first.click()
    pg.get_by_text('데이터 · 서버 연결').wait_for(timeout=5000)
    check('설정: 실시간 데이터 배지(서울시 실시간)', pg.locator('[data-source="seoul"]').count() >= 1)
    check('설정: 서버와 동기화됨(synced)', pg.get_by_text('서버와 동기화됨(synced)').count() == 1)
    inc = flat(pg.locator('[data-testid="incident-status"]').inner_text())
    check('설정: 돌발정보 연결됨 · 2건', inc == '연결됨 · 2건', inc)
    wxs = flat(pg.locator('[data-testid="weather-status"]').inner_text())
    check('설정: 날씨(기상청) 연결됨 · 08:00 관측', wxs == '연결됨 · 08:00 관측' and pg.get_by_text('국민대 격자(60 · 128)').count() == 1, wxs)
    ais = flat(pg.locator('[data-testid="explain-status"]').inner_text())
    check('설정: AI 설명(Gemini) 연결됨 · gemini-3.5-flash-lite', ais == '연결됨 · gemini-3.5-flash-lite' and pg.get_by_text('AI 설명(Gemini)').count() == 1, ais)
    sts = flat(pg.locator('[data-testid="storage-status"]').inner_text())
    check('설정: 서버 저장소 = 외부 DB · 연결됨(가짜 Upstash)', sts == '외부 DB · 연결됨', sts)
    panel = pg.locator('[data-testid="push-panel"]')
    pg.wait_for_selector('[data-testid="push-panel"][data-state="off"]', timeout=8000)
    check('백그라운드 알림: 처음에는 꺼짐(알림 켜기)', panel.get_by_role('button', name='알림 켜기').count() == 1)
    panel.get_by_role('button', name='알림 켜기').click()
    pg.wait_for_selector('[data-testid="push-panel"][data-state="on"]', timeout=10000)
    st_txt = flat(pg.locator('[data-testid="push-status"]').inner_text())
    check('알림 켜기 → 서버에 구독 1개 · 실제로 받기 전에는 \'켜짐 · 확인 필요\'', st_txt == '켜짐 · 확인 필요' and api(ctx, 8801, uid, 'GET', '/api/me')['pushSubscriptions'] == 1, st_txt)
    panel.get_by_role('button', name='테스트 알림 보내기').click()
    pg.wait_for_selector('[data-testid="push-panel"][data-confirmed="1"]', timeout=15000)
    st_txt = flat(pg.locator('[data-testid="push-status"]').inner_text())
    check('테스트 알림 → (가짜 휴대폰이 받음) → 수신 확인됨 · 시각', st_txt.startswith('수신 확인됨 · '), st_txt)
    status = api(ctx, 8801, uid, 'POST', '/api/push/status', {'endpoint': 'https://push.example.invalid/e2e'})
    check('API: /api/push/status — 이 기기 ackAt · 마지막 테스트 ackAt', bool(status['device']['ackAt']) and bool(status['lastTest']['ackAt']), str(status)[:200])
    pg.screenshot(path=str(OUT / 'live_desktop_settings.png'), full_page=True)
    # 앱을 다시 열면: 구독을 확인(서버가 이미 앎) → 그대로 수신 확인됨
    pg.reload(); pg.get_by_text('데이터 · 서버 연결').wait_for(timeout=8000)
    pg.wait_for_selector('[data-testid="push-panel"][data-confirmed="1"]', timeout=10000)
    check('다시 열기: 구독 확인 · 수신 확인됨 유지', pg.locator('[data-testid="push-panel"][data-state="on"]').count() == 1)
    # 서버가 구독을 잃어버렸다면(예전처럼 서버 재시작 등) → 앱을 열 때 자동 재등록
    api(ctx, 8801, uid, 'POST', '/api/push/unsubscribe', {'endpoint': 'https://push.example.invalid/e2e'})
    pg.reload(); pg.get_by_text('데이터 · 서버 연결').wait_for(timeout=8000)
    pg.wait_for_selector('[data-testid="push-panel"][data-state="on"]', timeout=10000)
    ptxt = flat(panel.inner_text())
    check('서버에서 구독이 사라져도 → 앱을 열면 자동 재등록(다시 확인 필요)', '방금 자동으로 다시 등록했어요' in ptxt and '켜짐 · 확인 필요' in ptxt
          and api(ctx, 8801, uid, 'GET', '/api/me')['pushSubscriptions'] == 1, ptxt)

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
    pg.wait_for_selector('[data-testid="why-strip"]', timeout=8000)
    check('[iPhone 13] 가로 넘침 없음 · \'왜 늦나요?\' 줄이 있어도 3요소가 스크롤 없이 보임', ov <= 0 and third['y'] + third['height'] <= tab['y'], f"ov={ov} bottom={third['y'] + third['height']:.0f} tab={tab['y']:.0f}")
    why = pg.locator('[data-testid="why-strip"]')
    check('[iPhone 13] 왜 늦나요? 두 줄 안(줄임) · +11분', why.bounding_box()['height'] <= 64 and '+11분' in why.inner_text(), f"h={why.bounding_box()['height']:.1f}")
    pg.screenshot(path=str(OUT / 'live_iphone13_home.png'))
    bar = pg.locator('[data-testid="install-bar"]')
    check('[iPhone Safari] 홈 화면 추가 안내 한 줄(탭 바 위에 떠 있음)', bar.count() == 1 and '홈 화면에 추가하고 알림 받기' in bar.inner_text()
          and bar.bounding_box()['y'] + bar.bounding_box()['height'] <= tab['y'], flat(bar.inner_text()) if bar.count() else 'none')
    token = None
    for _ in range(40):
        m = re.search(r'[?&]h=([\w-]+)', pg.url)
        if m: token = m.group(1); break
        pg.wait_for_timeout(100)
    check('[iPhone Safari] 주소에 이어받기 코드(?h=…)를 붙여 둠', bool(token), pg.url)
    bar.get_by_role('button', name='방법 보기').click()
    sheet = pg.locator('[data-testid="install-sheet"]'); sheet.wait_for(timeout=5000)
    stx = flat(sheet.inner_text())
    check('[iPhone Safari] 방법 보기: 공유 → 홈 화면에 추가 → 홈 화면 아이콘 → 알림 켜기 · 설정 이어짐', '홈 화면에 추가하기' in stx and '공유' in stx and '홈 화면에 추가' in stx
          and '알림 켜기' in stx and '그대로 이어져요' in stx, stx)
    pg.screenshot(path=str(OUT / 'live_iphone13_install_sheet.png'))
    sheet.get_by_role('button', name='알겠어요').click()
    pg.get_by_role('button', name='안내 닫기(7일 동안)').click()
    pg.reload(); pg.wait_for_selector('[data-testid="data-line"] [data-source="seoul"]', timeout=10000); pg.wait_for_timeout(500)
    check('[iPhone Safari] ×로 닫으면 다시 열어도 안 보임(7일)', pg.locator('[data-testid="install-bar"]').count() == 0)
    pg.evaluate("location.hash = '#settings'")
    pg.wait_for_selector('[data-testid="push-panel"][data-state="need-install"]', timeout=8000)
    check('[iPhone Safari] 설정: 홈 화면 앱에서만 알림 → 방법 보기', pg.locator('[data-testid="push-panel"]').get_by_role('button', name='방법 보기').count() == 1)
    ctx.close()

    # ④ 홈 화면 앱(standalone)으로 처음 열기: 저장 공간이 비어 있어도 이어받기 코드로 같은 사용자 · 같은 정류장
    ctx = b.new_context(**p.devices['iPhone 13'])
    ctx.grant_permissions(['notifications'], origin='http://localhost:8801')
    ctx.add_init_script("Object.defineProperty(navigator, 'standalone', { get: function () { return true; } });" + PUSH_STUB)
    pg = ctx.new_page(); errs = []
    pg.on('pageerror', lambda e: errs.append(str(e)))
    pg.clock.install(time=T0); pg.goto(f'http://localhost:8801/?h={token}#home')
    toast = pg.locator('[data-testid="handoff-toast"]'); toast.wait_for(timeout=10000)
    check('[홈 화면 앱] 처음 열면: Safari에서 쓰던 정류장 · 시간표를 가져왔어요', 'Safari에서 쓰던 정류장 · 시간표를 그대로 가져왔어요' in toast.inner_text(), flat(toast.inner_text()))
    pg.wait_for_selector('[data-testid="data-line"] [data-source="seoul"]', timeout=10000)
    same = pg.evaluate("localStorage.getItem('kubusai:user')")
    check('[홈 화면 앱] 같은 사용자 · 같은 정류장 · 주소에서 코드는 지움 · 안내 줄 없음', same == uid and '정릉시장' in pg.locator('main').inner_text()
          and 'h=' not in pg.url and pg.locator('[data-testid="install-bar"]').count() == 0, f'{same} {pg.url}')
    pg.screenshot(path=str(OUT / 'live_iphone13_standalone_home.png'))
    pg.evaluate("location.hash = '#settings'")
    pg.wait_for_selector('[data-testid="push-panel"][data-state="off"]', timeout=8000)
    check('[홈 화면 앱] 설정: 알림 켜기(버튼을 눌러야 허용을 물음)', pg.locator('[data-testid="push-panel"]').get_by_role('button', name='알림 켜기').count() == 1)
    again = api(ctx, 8801, 'x', 'POST', '/api/handoff/claim', {'token': token})
    check('[이어받기] 쓴 코드는 다시 못 씀(410)', 'error' in again and '이미' in again['error'], str(again))
    check('[홈 화면 앱] 페이지 오류 없음', not errs, str(errs)[:200])
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
    strip = pg.locator('[data-testid="incident-strip"]')
    order = pg.evaluate('''() => [...document.querySelectorAll('section[aria-label]')].map(s => s.getAttribute('aria-label'))''')
    check('키 없음: 예시(비 + 돌발 1건) · 점선 · 세 카드 다음 · 예시 데이터 · 실시간 아님', strip.count() == 1 and strip.get_attribute('data-tone') == 'mock'
          and order.index('경로 주변 날씨 · 돌발정보') > order.index('강의실 도착 예정') and '예시 데이터 · 실시간 아님' in strip.inner_text() and '비 오는 중' in strip.inner_text(), str(order))
    check('키 없음: 추천 버스가 원활(1112)이면 \'왜 늦나요?\' 없이 지난번 경로 주변 줄', pg.locator('[data-testid="why-strip"]').count() == 0)
    pg.screenshot(path=str(OUT / 'nokey_desktop_home.png'))
    pg.get_by_role('link', name='설정').first.click()
    pg.wait_for_selector('[data-testid="push-panel"][data-state="no-vapid"]', timeout=8000)
    check('키 없음: 백그라운드 알림 = 서버 키 없음 + VAPID 안내', '서버 키 없음' in pg.locator('[data-testid="push-panel"]').inner_text() and pg.get_by_text('VAPID').count() >= 1)
    sts = flat(pg.locator('[data-testid="storage-status"]').inner_text())
    check('키 없음: 서버 저장소 = 임시(재시작하면 지워짐) + Upstash 안내', sts == '임시 파일 · 재시작하면 지워짐' and pg.get_by_text('UPSTASH_REDIS_REST_URL').count() >= 1, sts)
    inc = flat(pg.locator('[data-testid="incident-status"]').inner_text())
    check('키 없음: 설정 돌발정보 = 예시 데이터 + 키 없음 안내', inc == '예시 데이터' and pg.get_by_text('SEOUL_ACCIDENT_API_KEY도 없어요').count() == 1, inc)
    wxs = flat(pg.locator('[data-testid="weather-status"]').inner_text())
    check('키 없음: 설정 날씨 = 예시 데이터 + KMA_API_KEY 없음 안내', wxs == '예시 데이터' and pg.get_by_text('KMA_API_KEY도 없어요').count() == 1, wxs)
    ais = flat(pg.locator('[data-testid="explain-status"]').inner_text())
    check('키 없음: 설정 AI 설명 = 예시 데이터 + GEMINI_API_KEY 없음 안내', ais == '예시 데이터' and pg.get_by_text('GEMINI_API_KEY도 없어요').count() == 1, ais)
    wx = api(ctx, 8802, uid2, 'GET', '/api/weather')
    tr = api(ctx, 8802, uid2, 'GET', '/api/stops/08901/trips')
    check('키 없음: /api/weather 꺼짐(off) · trips 날씨는 예시(mock)', wx.get('source') == 'off' and tr.get('weather', {}).get('source') == 'mock', f"{wx} / {str(tr.get('weather'))[:80]}")
    ex2 = [t.get('explain') for t in tr['trips'] if t.get('explain')]
    check('키 없음: 막히는 예시 노선의 설명은 예시(AI를 부르지 않음) · /api/explain/test는 키 없음', ex2 and all(e['source'] == 'example' for e in ex2)
          and api(ctx, 8802, uid2, 'GET', '/api/explain/test')['result']['reason'] == 'no-key', str(ex2)[:160])
    pg.get_by_role('link', name='시간표').first.click()
    pg.locator('section[aria-label="수업 검색"] input[type="search"]').fill('회로')
    pg.wait_for_selector('text=fetch_courses.py', timeout=5000)
    check('강의 목록이 없는 서버: 수업 검색 안내(fetch_courses.py)', '강의 목록이 아직 없어요' in pg.locator('[data-testid="course-meta"]').inner_text())
    check('키 없음: 페이지 오류 없음', not errs, str(errs)[:200])
    ctx.close(); b.close()

print('\n'.join(res)); n = sum(r.startswith('FAIL') for r in res)
print(f'{len(res) - n} passed, {n} failed'); sys.exit(1 if n else 0)
