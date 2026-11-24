"""실서비스 빌드(frontend/dist) + 백엔드 e2e. 서울시 API 자리에 테스트 고정 응답을 넣은 서버(8801)와 키 없는 서버(8802)를 씁니다.
실행: cd frontend && npm run build  →  node backend/scripts/e2eServer.js &  →  python test/e2e_live.py"""
import datetime, io, json, re, sys, time
from pathlib import Path
from playwright.sync_api import sync_playwright
from PIL import Image, ImageDraw

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
def capture_png():  # 시험용 '캡처' 이미지(실제 학생증 아님)
    im = Image.new('RGB', (1170, 2532), '#EEF1F5'); d = ImageDraw.Draw(im); d.rectangle([330, 850, 840, 1360], fill='#2B3442')
    buf = io.BytesIO(); im.save(buf, 'PNG'); return buf.getvalue()

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

    # ① 서울시 응답 서버: 처음 화면(v2.1 출발지 먼저 · 정류장 직접 고르기 링크) → 정류장 검색·선택 → 홈 3요소
    ctx = context(b, p, 8801, uid, viewport={'width': 1440, 'height': 1000})
    api(ctx, 8801, uid, 'PUT', '/api/me/timetable', {'classes': [CLASS]})
    pg = ctx.new_page(); errs = []
    pg.on('pageerror', lambda e: errs.append(str(e)))
    pg.clock.install(time=T0)
    pg.goto('http://localhost:8801/')
    onb = pg.get_by_test_id('onboarding'); onb.wait_for(timeout=10000)
    check('v2.1 처음 화면: 어디서 출발하세요? · GPS · 역 이름 칸 하나 · 출발 방식 고르기 없음 · 정류장 직접 고르기 링크', '어디서 출발하세요?' in onb.inner_text() and onb.get_by_test_id('transit-gps').count() == 1
          and onb.locator('input[type="search"]').count() == 1 and pg.get_by_role('radio').count() == 0 and onb.get_by_test_id('pick-stop-link').count() == 1)
    onb.get_by_test_id('pick-stop-link').click()
    dlg = pg.get_by_role('dialog'); dlg.wait_for(timeout=5000)
    check('정류장 직접 고르기 → 탑승 정류장 고르기 창(입력창 하나)', '탑승 정류장 고르기' in dlg.inner_text() and dlg.locator('input[type="search"]').count() == 1)
    dlg.locator('input[type="search"]').fill('정릉')
    dlg.get_by_role('button', name=re.compile('정릉시장.*08901')).click(timeout=10000)
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
          and order.index('왜 늦나요?') == order.index('실시간 버스 도착') + 1 and '정릉로가 많이 막혀요. 공사와 비 영향일 수 있어요.' in wt and '+11분' in wt and '근거' in wt
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
    check('v2.1 설정: 정류장만 고른 사람은 고급(정류장 직행) 펼침 · 출발지 칸에 직행 중 안내 · 경로가 없어 스위치 없음', pg.get_by_test_id('advanced').get_attribute('data-open') == 'true'
          and '정릉시장' in flat(pg.get_by_test_id('stop-row').inner_text()) and pg.get_by_test_id('transit-direct-note').count() == 1 and pg.get_by_test_id('direct-switch').count() == 0)
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

    # ⑤ '도착했어요!'(실서비스): 서버가 누른 시각 · 버튼 시간을 확인하고 배워서 외부 DB(가짜 Upstash)에 저장 · 출발 알림 멈춤 · 되돌리기
    #    서버 시계(월 08:10부터 흐름)에 맞춰 '2분 뒤 시작하는 수업'을 만들고 화면 시계를 그 분의 15초로 → 수업 1분 남짓 전에 도착(빠듯)
    uid3 = uid + 'a'
    ctx = context(b, p, 8801, uid3, **p.devices['iPhone 13'])
    srv = datetime.datetime.fromisoformat(api(ctx, 8801, uid3, 'GET', '/api/wake')['now'].replace('Z', '+00:00')).astimezone(KST)
    t_arr = srv.replace(second=15, microsecond=0)
    start_min = t_arr.hour * 60 + t_arr.minute + 2
    A_CLASS = {'id': 'e2eA', 'name': '알고리즘', 'day': 0, 'start': hhmm(start_min), 'end': hhmm(start_min + 75), 'building': '미래관', 'room': '410'}
    api(ctx, 8801, uid3, 'PUT', '/api/me/timetable', {'classes': [A_CLASS]})
    api(ctx, 8801, uid3, 'PATCH', '/api/me', {'stop': {'arsId': '08901', 'name': '정릉시장'}})
    pg = ctx.new_page(); errs = []; sent = []
    pg.on('pageerror', lambda e: errs.append(str(e)))
    pg.on('request', lambda r: sent.append((r.method, r.url, len(r.post_data or ''))) if r.method in ('POST', 'PUT', 'PATCH') else None)
    pg.clock.install(time=t_arr); pg.goto('http://localhost:8801/')
    btn = pg.get_by_test_id('arrive-button'); btn.wait_for(timeout=10000)
    check('[도착] 실서비스: 수업 2분 전 → 홈에 [도착했어요!]', btn.count() == 1, A_CLASS['start'])
    btn.click()
    pg.wait_for_selector('[data-testid="arrival-feedback"][data-status="done"]', timeout=8000)
    ftx = flat(pg.get_by_test_id('arrival-feedback').inner_text())
    check('[도착] 서버가 기록 · 학습: 수업 1분 전(빠듯) → 다음부터 2분 일찍 · 내 걸음 반영 +2분', '도착 기록 완료!' in ftx and '수업 1분 전' in ftx and '조금 빠듯했어요' in ftx
          and '다음부터 평소보다 2분 일찍 도착하도록 안내할게요' in ftx and '내 걸음 반영 +2분' in ftx, ftx)
    check('[도착] 이미지가 없으면 등록 안내', pg.get_by_test_id('kcard-empty').count() == 1)
    me = api(ctx, 8801, uid3, 'GET', '/api/me'); rec0 = (me.get('arrivals') or [{}])[-1]
    check('[도착] API: /api/me — 내 걸음 반영 1.6~1.9(정수 +2) · 도착 기록 1건(오늘 · 이 수업 · 빠듯)', 1.5 <= me['personal']['offsetMin'] <= 2.0 and me['personal']['samples'] == 1
          and rec0.get('classId') == 'e2eA' and rec0.get('key', '').startswith('2026-11-09:') and rec0.get('verdict') == 'tight', f"{me.get('personal')} {rec0}")
    again = api(ctx, 8801, uid3, 'POST', '/api/me/arrival', {'classId': 'e2eA'})
    check('[도착] 같은 수업 두 번째는 409(이미 기록) · 기록 그대로', again.get('kind') == 'already' and again.get('record', {}).get('key') == rec0.get('key'), str(again)[:120])
    plan = api(ctx, 8801, uid3, 'GET', '/api/plan')
    check('[도착] /api/plan: arrived · 출발 알림 멈춤 · 추천에 내 걸음 +2분', plan.get('arrived') is True and plan.get('alarmsDue') == [] and plan['rec'].get('personalMin') == 2,
          f"{plan.get('arrived')} {plan.get('alarmsDue')} {plan['rec'].get('state')} {plan['rec'].get('personalMin')}")
    pg.get_by_test_id('kcard-empty').locator('xpath=ancestor::div[@role="dialog"]').get_by_role('button', name='닫기').last.click()
    card = pg.get_by_test_id('arrived-card')
    check('[도착] 홈: 도착 기록 카드 · 내 걸음 반영 +2분 · 버튼은 한 번만', card.count() == 1 and '내 걸음 반영 +2분' in flat(card.inner_text()) and pg.get_by_test_id('arrive-button').count() == 0, flat(card.inner_text()))
    pg.reload(); pg.get_by_test_id('arrived-card').wait_for(timeout=10000)
    check('[도착] 다시 열어도(서버 값으로) 도착 기록 카드', pg.get_by_test_id('arrive-button').count() == 0)
    pg.evaluate("location.hash = '#settings'"); pg.get_by_test_id('kcard-settings').wait_for(timeout=5000)
    pg.get_by_test_id('kcard-file').set_input_files(files=[{'name': 'kcard.png', 'mimeType': 'image/png', 'buffer': capture_png()}])
    pg.wait_for_selector('[data-testid="kcard-settings"][data-state="ready"]', timeout=8000)
    me = api(ctx, 8801, uid3, 'GET', '/api/me')
    check('[K•CARD+] 실서비스: 등록됨 · 서버로 보낸 요청 본문은 모두 작음(이미지는 이 기기에만)', bool(sent) and all(n < 4000 for _, _, n in sent) and 'data:image' not in json.dumps(me) and 'kcard' not in json.dumps(me),
          str([(m, u.split('8801')[-1], n) for m, u, n in sent])[:240])
    per = flat(pg.get_by_test_id('personal-status').inner_text())
    check('[도착] 설정: 내 걸음 반영 +2분 · 도착 기록 1번', '+2분' in per and '도착 기록 1번' in per, per)
    pg.evaluate("location.hash = '#home'"); pg.get_by_test_id('kcard-open').click()
    pg.get_by_test_id('kcard-viewer').wait_for(timeout=5000)
    check('[K•CARD+] 다시 보기: 전체 화면 이미지', pg.evaluate("() => document.querySelector('[data-testid=\"kcard-viewer\"] img').naturalWidth") == 1170)
    pg.screenshot(path=str(OUT / 'live_iphone13_kcard_viewer.png'))
    pg.keyboard.press('Escape')
    card = pg.get_by_test_id('arrived-card')
    card.get_by_role('button', name='잘못 눌렀어요').click(); card.get_by_role('button', name='기록 취소하기').click()
    pg.get_by_test_id('arrive-button').wait_for(timeout=5000)
    me = api(ctx, 8801, uid3, 'GET', '/api/me')
    check('[도착] 잘못 눌렀어요 → 서버에서 기록 취소 · 보정 0 · 버튼 다시', me['personal']['offsetMin'] == 0 and me['arrivals'] == [], str(me['personal']))
    # 연결이 끊겼을 때: 누른 기록을 이 기기에 두었다가(보내는 중 카드) 3초 뒤 다시 보내 기록
    tries = {'n': 0}
    def flaky(route):
        tries['n'] += 1
        if tries['n'] == 1: route.abort()
        else: route.continue_()
    pg.route('**/api/me/arrival', flaky)
    pg.get_by_test_id('arrive-button').click()
    pg.wait_for_selector('[data-testid="arrival-feedback"][data-status="pending"]', timeout=5000)
    ptx = flat(pg.get_by_test_id('arrival-feedback').inner_text())
    check('[도착] 연결이 끊기면: 아직 못 보냈어요 · 이 기기에 두었다가 다시 보냄', '도착 기록을 아직 못 보냈어요' in ptx and '누른 시각 그대로' in ptx
          and pg.evaluate("localStorage.getItem('kubusai:arrival:pending') !== null"), ptx)
    pg.wait_for_selector('[data-testid="arrival-feedback"][data-status="done"]', timeout=12000)
    me = api(ctx, 8801, uid3, 'GET', '/api/me')
    check('[도착] 잠시 뒤 다시 보내 기록 완료 · 한 번만 저장 · 보낼 것 비움', tries['n'] == 2 and len(me['arrivals']) == 1 and me['personal']['samples'] == 1
          and pg.evaluate("localStorage.getItem('kubusai:arrival:pending') === null"), f"tries={tries['n']} {me['personal']}")
    pg.unroute('**/api/me/arrival')
    check('[도착] 페이지 오류 없음', not errs, str(errs)[:200])
    ctx.close()

    # ⑥ v2.1 출발지 먼저(가짜 ODsay · 하루 3건으로 줄인 상한 / 가짜 서울시 실시간 지하철 · 버스 · 돌발정보 · 기상청 · Gemini):
    #    처음 화면 '어디서 출발하세요?' → 국민대 700m 안(걸어가는 편이 빨라요) → GPS(홍대입구 근처) → 추천 경로 3개
    #    → [이 경로로 안내 설정](서버 저장 · 바로 환승 홈) → 환승 '왜 늦나요?' 재료 · 설정 상태(대기 아님)
    #    → 하루 상한 넘김(내일부터 · 근처 국민대행 정류장 400m) → [이 정류장] → 홈 [경로 다시 찾기] → 고급 · 정류장 직행 스위치
    uid4 = uid + 't'
    HONGDAE = {'latitude': 37.557527, 'longitude': 126.923778}
    ctx = context(b, p, 8801, uid4, **p.devices['iPhone 13'], geolocation=HONGDAE)
    ctx.grant_permissions(['geolocation', 'notifications'], origin='http://localhost:8801')
    srv = datetime.datetime.fromisoformat(api(ctx, 8801, uid4, 'GET', '/api/wake')['now'].replace('Z', '+00:00')).astimezone(KST)
    t_start = srv.hour * 60 + srv.minute + 95   # 표준 계산 출발이 지금부터 15분쯤 뒤 → 지하철 실시간 시간대(출발 30분 전 ~ 20분 뒤)
    T_CLASS = {'id': 'e2eT', 'name': '자료구조', 'day': 0, 'start': hhmm(t_start), 'end': hhmm(t_start + 75), 'building': '미래관', 'room': '301'}
    api(ctx, 8801, uid4, 'PUT', '/api/me/timetable', {'classes': [T_CLASS]})
    pg = ctx.new_page(); errs = []
    pg.on('pageerror', lambda e: errs.append(str(e)))
    pg.clock.install(time=srv); pg.goto('http://localhost:8801/')
    onb = pg.get_by_test_id('onboarding'); onb.wait_for(timeout=10000)
    check('[환승] v2.1 처음 화면: 출발지만 물음(출발 방식 고르기 · [환승해서 가요] 링크 없음)', onb.get_by_test_id('transit-gps').count() == 1 and pg.get_by_role('radio').count() == 0
          and pg.get_by_test_id('open-transit').count() == 0 and pg.get_by_test_id('pick-stop-link').count() == 1)
    onb.locator('input[type="search"]').fill('국민대')
    pg.get_by_role('button', name=re.compile('국민대학교앞')).first.click()
    fbk = pg.get_by_test_id('transit-fallback'); fbk.wait_for(timeout=8000)
    ftx = flat(fbk.inner_text())
    h0 = api(ctx, 8801, uid4, 'GET', '/api/health')['odsay']
    check('[환승] 국민대 700m 안 출발지 → ODsay를 부르지 않음 · 걸어가는 편이 빨라요(직행 약속 · 근처 정류장 찾기 없음)', fbk.get_attribute('data-reason') == 'near' and '걸어가는 편이 빨라요' in ftx and '직행' not in ftx
          and pg.get_by_test_id('nearby-stops').count() == 0 and pg.get_by_test_id('nearby-none').count() == 0 and h0['callsToday'] == 0 and pg.get_by_test_id('onboarding').count() == 1, ftx[:120])
    pg.get_by_test_id('transit-gps').click()
    opts = pg.get_by_test_id('route-option'); opts.first.wait_for(timeout=10000)
    hdr = flat(pg.get_by_test_id('transit-results').locator('p').first.inner_text())
    check('[환승] GPS(홍대입구 근처) → ODsay 추천 경로 3개 · 첫 카드 최적 · 새로 검색 오늘 1/3회', opts.count() == 3 and flat(opts.first.inner_text()).startswith('최적')
          and 'GPS로 고른 위치' in hdr and '오늘 1/3회' in hdr, hdr)
    kinds = opts.first.locator('[data-testid="mode-bar"] [data-kind]').evaluate_all('els => els.map(e => e.dataset.kind)')
    check('[환승] 카드 위 막대: 도보 · 지하철 · 도보 · 지하철 · 도보 · 버스 · 도보(시간 비율)', kinds == ['walk', 'subway', 'walk', 'subway', 'walk', 'bus', 'walk'], str(kinds))
    rows = opts.first.locator('ol > li').evaluate_all('els => els.map(e => e.dataset.kind)')
    c0 = flat(opts.first.inner_text())
    check('[환승] 카드 아래 타임라인: 2호선 → 4호선 → 간선 171 → 하차(국민대학교앞) · 이 경로로 안내 설정', rows == ['subway', 'subway', 'bus', 'end'] and '2호선' in c0 and '4호선' in c0
          and '간선' in c0 and '171' in c0 and '하차' in c0 and '이 경로로 안내 설정' in c0, c0[:200])
    page_html = pg.content()
    check('[환승] 화면에 ODsay · 지하철 키 없음', 'ODSAY+TEST/KEY=' not in page_html and 'ODSAY%2BTEST' not in page_html and 'SUBWAY-TEST-KEY' not in page_html)
    ov = pg.evaluate('document.documentElement.scrollWidth - document.documentElement.clientWidth')
    bar_over = opts.first.locator('[data-testid="mode-bar"]').evaluate('el => el.scrollWidth - el.clientWidth')
    check('[환승] 경로 카드: 가로 넘침 없음(막대 한 줄)', ov <= 0 and bar_over <= 1, f'{ov} {bar_over}')
    opts.first.screenshot(path=str(OUT / 'live_iphone13_route_option.png'))
    pg.get_by_test_id('transit-gps').click(); pg.wait_for_timeout(800)
    hdr2 = flat(pg.get_by_test_id('transit-results').locator('p').first.inner_text())
    check('[환승] 같은 위치 다시 검색 → 저장된 결과(오늘 호출 안 씀)', '저장된 검색 결과' in hdr2 and api(ctx, 8801, uid4, 'GET', '/api/health')['odsay']['callsToday'] == 1, hdr2)
    pg.get_by_test_id('route-option').first.get_by_test_id('route-choose').click()
    pg.locator('section[aria-label="출발 추천"][data-mode="transit"]').wait_for(timeout=8000)
    me = api(ctx, 8801, uid4, 'GET', '/api/me')
    check('[환승] [이 경로로 안내 설정] → 서버(외부 DB)에 저장 · 처음 화면에서 바로 환승 홈', me['transit']['mode'] == 'transit' and me['transit']['route']['title'] == '2호선 → 4호선 → 171'
          and me['transit']['origin']['name'] == 'GPS로 고른 위치' and pg.get_by_test_id('onboarding').count() == 0, f"{me['transit']['mode']} {me['transit']['route']['title']}")
    o_ = me['transit']['origin']
    hl = api(ctx, 8801, uid4, 'GET', '/api/health')['location']
    check('[v2.2.3] GPS 출발지는 약 100m 칸으로 저장(37.557527 → 37.558 · 126.923778 → 126.924) · health: 정밀한 GPS 출발지 0 · 예전 기록 옮기기 끝(좌표 값 없음)',
          (o_['lat'], o_['lon'], o_['kind']) == (37.558, 126.924, 'gps') and hl['digits'] == 3 and hl['users']['gps'] >= 1 and hl['users']['precise'] == 0
          and hl['migration']['done'] is True and '37.55' not in json.dumps(hl), f"{o_} {hl}")
    hr = api(ctx, 8801, uid4, 'GET', '/api/health')['retention']
    check('[v2.2.4] 마지막 사용 기록(화면 요청) · health retention: 90일 · 켜짐 · 지금 지울 사람 0 · 멈춤 없음 · 다음 삭제 가능 시각은 90일 뒤(사용자 ID 없음)',
          isinstance(me.get('lastSeen'), (int, float)) and hr['days'] == 90 and hr['on'] is True and hr['users'] >= 1 and hr['dueNow'] == 0 and hr['held'] is None
          and hr['nextDueAt'] and uid4 not in json.dumps(hr), f"{me.get('lastSeen')} {hr}")
    pg.wait_for_function("() => (document.querySelector('[data-testid=\"data-line\"]')?.innerText || '').includes('갱신')", timeout=10000)
    live = api(ctx, 8801, uid4, 'GET', '/api/transit/live')
    plan = api(ctx, 8801, uid4, 'GET', '/api/plan')
    dline = flat(pg.get_by_test_id('data-line').inner_text())
    first = flat(pg.locator('section[aria-label="출발 추천"]').inner_text())
    dep = plan['rec']['pick']['departMin']
    check('[환승] 홈: 출발지 칩 · ① 출발(2호선 배지 · 홍대입구역) · ③ 강의실 도착 · ② 내 경로 카드', pg.get_by_test_id('origin-chip').count() == 1 and flat(pg.get_by_test_id('first-badge').inner_text()) == '2호선'
          and '홍대입구역' in first and pg.locator('section[aria-label="강의실 도착 예정"]').count() == 1 and '내 경로' in pg.get_by_test_id('transit-route').inner_text(), first)
    check('[환승] 홈 출발 시각 = 서버 계산(/api/plan · 알림과 같은 값, ±1분)', any(hhmm(dep + d) in first for d in (-1, 0, 1)) or plan['rec'].get('departNow'), f"{hhmm(dep)} / {first}")
    check('[환승] 실시간: 첫 지하철(서울시 지하철) · 국민대행 171번(서울시 버스) — 출발 30분 전부터', live['first']['source'] == 'seoul' and live['first']['kind'] == 'subway' and live['final']['source'] == 'seoul'
          and '첫 지하철 실시간' in dline and '국민대행 버스 실시간' in dline, f"{live['first'].get('source')} {live['final'].get('source')} / {dline}")
    sub_row = flat(pg.get_by_test_id('transit-route').locator('li[data-kind="subway"]').first.inner_text())
    check('[환승] 2호선 줄: 탑승 시각 + 실시간 · 배차 간격 예상 표시', '탑승' in sub_row and ('실시간' in sub_row or '배차 간격 예상' in sub_row), sub_row)
    tb = pg.locator('nav.fixed').bounding_box(); third = pg.locator('section[aria-label="강의실 도착 예정"]').bounding_box()
    top = pg.locator('section[aria-label="출발 추천"]').bounding_box()
    check('[환승] 경로를 고르면 맨 위부터: 휴대폰 첫 화면에 출발 · 도착 카드가 함께 보임', top['y'] >= 0 and third['y'] + third['height'] <= tb['y'], f"top={top['y']:.0f} bottom={third['y'] + third['height']:.0f} tab={tb['y']:.0f}")
    pg.screenshot(path=str(OUT / 'live_iphone13_transit_home.png'))
    # v2.1 C: 환승에도 '왜 늦나요?'(직행과 같은 기준 · 같은 코드) — 화면 요청에만 경로 주변 돌발정보 · 날씨 · 마지막 국민대행 버스 설명. 경로 좌표는 보내지 않음
    t171 = next((t for t in live['final']['trips'] if t['no'] == '171'), {})
    check('[환승] v2.1 /api/transit/live: 돌발정보(서울시) · 날씨(기상청) · 마지막 171번 지연 11분 · Gemini 설명 · 좌표(path) 없음', live['incidents']['source'] == 'seoul' and live['weather']['source'] == 'kma'
          and t171.get('delayMin') == 11 and (t171.get('explain') or {}).get('source') == 'gemini' and '"path"' not in json.dumps(live),
          f"{live['incidents'].get('source')} {live['weather'].get('source')} {t171.get('delayMin')} {(t171.get('explain') or {}).get('source')}")
    why = pg.get_by_test_id('why-strip'); wt = flat(why.inner_text()) if why.count() else ''
    check("[환승] v2.1 홈 '왜 늦나요?'(직행과 같은 기준): 마지막 버스 171번 · 노란 줄 · AI 문장 · +11분 · 근거", why.count() == 1 and flat(pg.get_by_test_id('why-who').inner_text()) == '마지막 버스 171번'
          and why.get_attribute('data-tone') == 'caution' and why.get_attribute('data-why') == 'ai' and '정릉로가 많이 막혀요. 공사와 비 영향일 수 있어요.' in wt and '+11분' in wt and '근거' in wt, wt[:160])
    pg.screenshot(path=str(OUT / 'live_iphone13_transit_why.png'))
    # v2.2 '출발했어요!': 누르면 서버(외부 DB)에 오늘 출발 기록 → 이동 중 카드 · 서버 계산도 누른 시각 기준 · 출발 알림 그만 → 잘못 눌렀어요로 지움
    pg.evaluate('window.scrollTo(0, 0)'); pg.wait_for_timeout(200)
    dbtn = pg.get_by_test_id('depart-button')
    check('[환승] v2.2 출발 카드에 [출발했어요!](추천 출발 1시간 전 ~ 수업 시작 전)', dbtn.count() == 1, flat(pg.locator('section[aria-label="출발 추천"]').inner_text())[:120])
    dbtn.click()
    pg.get_by_test_id('departed-hero').wait_for(timeout=8000)
    pg.wait_for_function("() => !(document.querySelector('[data-testid=\"depart-note\"]')?.innerText || '').includes('보내는 중')", timeout=8000)
    me = api(ctx, 8801, uid4, 'GET', '/api/me'); d = me.get('departure') or {}
    hero = flat(pg.get_by_test_id('departed-hero').inner_text())
    check('[환승] v2.2 누르면: 서버에 오늘 출발 기록(오늘 첫 수업 · 저장한 경로) · 이동 중 카드 · 다음 탈 것', str(d.get('key', '')).startswith('2026-11-09:') and '171' in d.get('routeKey', '')
          and f"이동 중 · {hhmm(d.get('departMin', 0))} 출발" in hero and '탑승' in hero and '잘못 눌렀어요' in hero, f"{d} / {hero}")
    plan2 = api(ctx, 8801, uid4, 'GET', '/api/plan')
    check('[환승] v2.2 서버 계산(알림)도 누른 시각 기준 · 출발 알림 없음', plan2['rec'].get('departed') is True and abs(plan2['rec']['pick']['departMin'] - d.get('departMin', -1)) < 0.01 and plan2['alarmsDue'] == [],
          f"{plan2['rec'].get('departed')} {plan2['alarmsDue']}")
    dl2 = flat(pg.get_by_test_id('data-line').inner_text())
    check('[환승] v2.2 데이터 줄: HH:MM 출발 기준', f"{hhmm(d.get('departMin', 0))} 출발 기준" in dl2, dl2)
    pg.screenshot(path=str(OUT / 'live_iphone13_departed.png'))
    pg.get_by_test_id('depart-undo').click(); pg.get_by_test_id('depart-undo-yes').click()
    pg.get_by_test_id('depart-button').wait_for(timeout=8000)
    me = api(ctx, 8801, uid4, 'GET', '/api/me')
    check('[환승] v2.2 잘못 눌렀어요 → 서버 기록도 지움 · 버튼 다시', me.get('departure') is None and pg.get_by_test_id('departed-hero').count() == 0, str(me.get('departure')))
    # 하루 상한(e2e 서버 3건): 새 출발지 2건을 더 찾으면 3/3 → 새 출발지는 '내일부터' + 근처 국민대행 정류장(저장한 경로는 그대로)
    for o in ({'lat': 37.5665, 'lon': 126.9780, 'name': '시청', 'kind': 'stop'}, {'lat': 37.5133, 'lon': 127.1001, 'name': '잠실', 'kind': 'stop'}):
        api(ctx, 8801, uid4, 'POST', '/api/transit/search', o)
    # 설정 · 데이터 연결: 환승 경로로 안내 중이어도 돌발정보 · 날씨가 '대기'가 아님(환승 실시간 응답으로 보여 줌)
    pg.get_by_test_id('origin-chip').click()
    pg.wait_for_selector('[data-testid="transit-origin"]', timeout=8000)
    pg.wait_for_function("() => !(document.querySelector('[data-testid=\"incident-status\"]')?.innerText || '').includes('대기')", timeout=8000)
    inc = flat(pg.get_by_test_id('incident-status').inner_text()); wxs = flat(pg.get_by_test_id('weather-status').inner_text()); ais = flat(pg.get_by_test_id('explain-status').inner_text())
    check('[환승] v2.1 설정: 환승 경로여도 돌발정보 · 날씨 · AI 설명 연결됨(대기 아님)', inc.startswith('연결됨 · ') and wxs.startswith('연결됨 · ') and ais.startswith('연결됨'), f'{inc} / {wxs} / {ais}')
    origin_input = pg.locator('[data-testid="transit-origin"] input[type="search"]')
    origin_input.fill('정릉')
    pg.get_by_role('button', name=re.compile('정릉시장')).first.click()
    fbk = pg.get_by_test_id('transit-fallback'); fbk.wait_for(timeout=8000)
    near = pg.get_by_test_id('nearby-stops'); near.wait_for(timeout=8000)
    ftx = flat(fbk.inner_text()); ntx = flat(near.inner_text())
    me = api(ctx, 8801, uid4, 'GET', '/api/me')
    check('[환승] v2.1 하루 상한 넘김 → 내일부터 찾을 수 있어요 · 직행 약속 없음 · 오늘 3/3회 · 저장한 경로 그대로', fbk.get_attribute('data-reason') == 'cap' and '내일부터 찾을 수 있어요' in ftx and '직행' not in ftx
          and '3/3회' in ftx and me['transit']['mode'] == 'transit' and me['transit']['route']['title'] == '2호선 → 4호선 → 171', ftx[:160])
    check('[환승] v2.1 근처 국민대행 정류장(400m): 정릉시장 120m · 걸어서 2분 · 171 · 경로가 있으니 자동으로 바꾸지 않고 [이 정류장]', pg.get_by_test_id('nearby-stop').count() == 1
          and '정릉시장' in ntx and '120 m' in ntx and '걸어서 2분' in ntx and '171' in ntx and '바꿀 수도 있어요' in ntx and pg.get_by_test_id('nearby-apply').count() == 1
          and pg.get_by_test_id('bigstation-tip').count() == 0, ntx[:160])
    pg.screenshot(path=str(OUT / 'live_iphone13_cap_nearby.png'))
    pg.get_by_test_id('nearby-apply').click()
    pg.wait_for_selector('[data-testid="nearby-stop"][data-on="true"]', timeout=8000)
    me = api(ctx, 8801, uid4, 'GET', '/api/me'); rt_ = me['transit'].get('retry') or {}
    check('[환승] [이 정류장] → 서버: 정류장 직행(정릉시장 08901 · 걸어서 3분 칩) · 다시 찾을 출발지 기억(정릉시장 · cap) · 고른 경로는 남김', me['transit']['mode'] == 'direct' and me['stop']['arsId'] == '08901'
          and me['prefs']['walkToStopMin'] == 3 and (rt_.get('origin') or {}).get('name') == '정릉시장' and rt_.get('reason') == 'cap' and me['transit']['route']['title'] == '2호선 → 4호선 → 171', str(rt_)[:160])
    note = pg.get_by_test_id('transit-fallback-note')
    check('[환승] 출발지 칸: 환승 경로를 찾지 못해 가까운 정릉시장 정류장 직행 중', note.count() == 1 and '환승 경로를 찾지 못해' in note.inner_text() and '정릉시장' in note.inner_text())
    h = api(ctx, 8801, uid4, 'GET', '/api/health')
    check('[환승] /api/health: odsay(오늘 3/3 · Referer) · nearKu(400m · 찾음) · seoulSubway(연결됨 · 호출 수) · 키 없음', h['odsay']['keyConfigured'] and h['odsay']['callsToday'] == 3 and h['odsay']['cap'] == 3
          and h['odsay']['referer'] == 'https://ku-bus-ai.onrender.com' and h['nearKu']['radiusM'] == 400 and h['nearKu']['finds'] >= 1
          and h['seoulSubway']['keyConfigured'] and h['seoulSubway']['callsToday'] >= 1 and h['seoulSubway']['lastOkAt']
          and 'ODSAY+TEST' not in json.dumps(h) and 'SUBWAY-TEST-KEY' not in json.dumps(h) and 'E2E-TEST-KEY' not in json.dumps(h), json.dumps({k: h['odsay'][k] for k in ('callsToday', 'cap', 'left')}))
    pg.wait_for_timeout(300)
    ods = flat(pg.get_by_test_id('odsay-status').inner_text()); sbs = flat(pg.get_by_test_id('subway-status').inner_text())
    check('[환승] 설정 · 데이터 연결: 환승 경로(ODsay) 오늘 3회 다 씀 · 실시간 지하철 연결됨', ods == '오늘 3회 다 씀' and sbs.startswith('연결됨'), f'{ods} / {sbs}')
    # 홈: 가까운 정류장 직행 + [경로 다시 찾기]
    pg.evaluate("location.hash = '#home'")
    rn = pg.get_by_test_id('retry-notice'); rn.wait_for(timeout=8000)
    pg.locator('section[aria-label="실시간 버스 도착"]').wait_for(timeout=8000)
    check('[환승] 홈: 정릉시장 직행(실시간 버스 카드) + 경로 다시 찾기 줄', '정릉시장' in rn.inner_text() and pg.get_by_test_id('origin-chip').count() == 0, flat(rn.inner_text()))
    pg.screenshot(path=str(OUT / 'live_iphone13_retry_home.png'))
    pg.get_by_test_id('retry-search').click()
    fbk = pg.get_by_test_id('transit-fallback'); fbk.wait_for(timeout=8000)
    pg.wait_for_selector('[data-testid="nearby-stop"][data-on="true"]', timeout=8000)
    check('[환승] [경로 다시 찾기] → 설정에서 정릉시장으로 바로 다시 찾음(아직 한도 초과) · 지금 정류장은 안내 중 · 호출 수 그대로', pg.evaluate('location.hash') == '#settings'
          and fbk.get_attribute('data-reason') == 'cap' and pg.get_by_test_id('nearby-apply').count() == 0 and api(ctx, 8801, uid4, 'GET', '/api/health')['odsay']['callsToday'] == 3)
    # 고급 · 정류장 직행 스위치: 끄면 저장한 환승 경로로('경로 다시 찾기'는 끝) · 켜면 직행
    adv = pg.get_by_test_id('advanced')
    if adv.get_attribute('data-open') != 'true': pg.get_by_test_id('advanced-open').click()
    sw = pg.get_by_test_id('direct-switch').get_by_role('switch')
    check('[환승] 고급: 탑승 정류장 정릉시장 · 정류장 직행 스위치 켜짐', sw.get_attribute('aria-checked') == 'true' and '정릉시장' in flat(pg.get_by_test_id('stop-row').inner_text()))
    sw.click()
    trs = {}
    for _ in range(30):
        trs = api(ctx, 8801, uid4, 'GET', '/api/me')['transit']
        if trs['mode'] == 'transit': break
        pg.wait_for_timeout(100)
    check('[환승] 스위치 끄기 → 저장한 환승 경로로 · 경로 다시 찾기 끝(서버 retry 지움)', trs['mode'] == 'transit' and trs.get('retry') is None, str(trs.get('retry')))
    pg.evaluate("location.hash = '#home'")
    pg.get_by_test_id('origin-chip').wait_for(timeout=8000)
    check('[환승] 홈: 다시 환승 경로(출발지 칩) · 경로 다시 찾기 줄 없음', pg.get_by_test_id('retry-notice').count() == 0)
    pg.evaluate("location.hash = '#settings'")
    adv = pg.get_by_test_id('advanced'); adv.wait_for(timeout=5000)
    if adv.get_attribute('data-open') != 'true': pg.get_by_test_id('advanced-open').click()
    pg.get_by_test_id('direct-switch').get_by_role('switch').click()
    pg.get_by_test_id('transit-direct-note').wait_for(timeout=5000)
    pg.evaluate("location.hash = '#home'")
    pg.locator('section[aria-label="실시간 버스 도착"]').wait_for(timeout=8000)
    check('[환승] 스위치 켜기 → 직행 홈(정릉시장) · 서버도 직행 · 경로 다시 찾기 줄 없음', pg.get_by_test_id('origin-chip').count() == 0 and pg.get_by_test_id('retry-notice').count() == 0
          and api(ctx, 8801, uid4, 'GET', '/api/me')['transit']['mode'] == 'direct')
    check('[환승] 페이지 오류 없음', not errs, str(errs)[:200])
    ctx.close()

    # ③ 키 없는 서버: 정류장 검색은 이유 안내, 고른 정류장은 예시 데이터(점선) + 이유, 서버 푸시는 VAPID 없음
    uid2 = uid + 'k'
    ctx = context(b, p, 8802, uid2, viewport={'width': 1280, 'height': 900})
    api(ctx, 8802, uid2, 'PUT', '/api/me/timetable', {'classes': [CLASS]})
    pg = ctx.new_page(); errs = []
    pg.on('pageerror', lambda e: errs.append(str(e)))
    pg.clock.install(time=T0); pg.goto('http://localhost:8802/')
    onb = pg.get_by_test_id('onboarding'); onb.wait_for(timeout=10000)
    onb.locator('input[type="search"]').fill('정릉')
    pg.wait_for_selector('text=서울시 버스 API 키가 없어', timeout=8000)
    check('키 없음: 처음 화면 출발지 검색(정류장 이름) 이유 안내', True)
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
    # v2.1 키 없는 서버(ODsay · 지하철 · 서울시 버스 키 없음): 출발지 검색은 오류 대신 이유 · 근처 정류장도 지어내지 않음 · 설정 상태는 꺼짐
    ctx.grant_permissions(['geolocation'], origin='http://localhost:8802'); ctx.set_geolocation({'latitude': 37.557527, 'longitude': 126.923778})
    pg.get_by_role('link', name='설정').first.click()
    check('키 없음: v2.1 설정 출발지 칸(출발 방식 고르기 없음 · GPS 바로) · 정릉시장 직행 중 안내', pg.get_by_test_id('transit-settings').get_by_role('radio').count() == 0
          and pg.get_by_test_id('transit-gps').count() == 1 and pg.get_by_test_id('transit-direct-note').count() == 1)
    pg.get_by_test_id('transit-gps').click()
    fbk = pg.get_by_test_id('transit-fallback'); fbk.wait_for(timeout=8000)
    pg.get_by_test_id('nearby-none').wait_for(timeout=8000)
    ftx = flat(fbk.inner_text())
    check('키 없음: 출발지 검색 → 오류 대신 ODSAY_API_KEY 없음 · 직행 약속 없음 · 근처 정류장은 확인하지 못함(지어내지 않음) · 큰 환승역 안내 없음', fbk.get_attribute('data-reason') == 'no-key' and 'ODSAY_API_KEY' in ftx
          and '직행' not in ftx and '근처 버스 정류장을 확인하지 못했어요' in ftx and pg.get_by_test_id('nearby-stops').count() == 0 and pg.get_by_test_id('bigstation-tip').count() == 0, ftx[:160])
    ods = flat(pg.get_by_test_id('odsay-status').inner_text()); sbs = flat(pg.get_by_test_id('subway-status').inner_text())
    check('키 없음: 설정 환승 경로 · 실시간 지하철 = 꺼짐', ods == '꺼짐' and sbs == '꺼짐' and pg.get_by_text('SEOUL_SUBWAY_KEY가 없어').count() == 1, f'{ods} / {sbs}')
    h2 = api(ctx, 8802, uid2, 'GET', '/api/health')
    check('키 없음: /api/health odsay · seoulSubway 꺼짐 · 근처 정류장 찾기(nearKu) 있음', h2['odsay']['keyConfigured'] is False and h2['seoulSubway']['keyConfigured'] is False and h2['nearKu']['radiusM'] == 400)
    pg.get_by_role('link', name='홈').first.click(); pg.wait_for_timeout(500)
    check('키 없음: 경로를 못 찾아도 홈은 고른 정류장 직행 그대로(예시 데이터 점선) · 경로 다시 찾기 · 경로 고르기 줄 없음', pg.get_by_test_id('retry-notice').count() == 0 and pg.get_by_test_id('transit-pending').count() == 0
          and pg.locator('section[aria-label="출발 추천"][data-source="mock"]').count() == 1)
    check('키 없음: 페이지 오류 없음', not errs, str(errs)[:200])
    ctx.close()

    # ⑦ v2.2.2 사용자 ID(키 없는 서버 8802): 새 기기는 긴 무작위 ID · 예전 8자 ID는 그대로 ·
    #    저장 공간(localStorage)이 막혀도 'demo'(예전에 막힌 기기들이 같이 쓰던 값)가 아니라 이 기기만의 ID
    BLOCK_LS = "Object.defineProperty(window, 'localStorage', { configurable: true, get: function () { throw new DOMException('The operation is insecure.', 'SecurityError'); } });"
    BLOCK_COOKIE = "Object.defineProperty(Document.prototype, 'cookie', { configurable: true, get: function () { throw new DOMException('blocked', 'SecurityError'); }, set: function () { throw new DOMException('blocked', 'SecurityError'); } });"
    LONG = re.compile(r'^u[0-9a-f]{32}$')
    def open_ids(init=None, reload=False):
        c = b.new_context(viewport={'width': 1200, 'height': 900})
        if init: c.add_init_script(init)
        pg = c.new_page(); errs = []; seen = []
        pg.on('pageerror', lambda e: errs.append(str(e)))
        pg.on('request', lambda r: seen.append(r.headers.get('x-user-id', '')) if '/api/' in r.url else None)
        pg.goto('http://localhost:8802/'); pg.get_by_test_id('onboarding').wait_for(timeout=10000); pg.wait_for_timeout(800)
        first = list(seen); again = []
        if reload:
            seen.clear(); pg.reload(); pg.get_by_test_id('onboarding').wait_for(timeout=10000); pg.wait_for_timeout(800); again = list(seen)
        return c, pg, errs, first, again
    cookie_of = lambda c: next((k['value'] for k in c.cookies() if k['name'] == 'kubusai_uid'), None)
    c, pg, errs, first, _ = open_ids()
    stored = pg.evaluate("localStorage.getItem('kubusai:user')")
    check('[v2.2.2] 처음 여는 기기: 긴 무작위 ID(u + 32자) · 모든 요청이 같은 ID · 쿠키에도 같은 값', bool(LONG.match(stored or '')) and first and set(first) == {stored}
          and cookie_of(c) == stored and not errs, f'{stored} {set(first)} {cookie_of(c)} {errs[:1]}')
    c.close()
    old_id = 'u' + format(int(time.time() * 1000) % (36 ** 8), 'x')[:8].rjust(8, '0')
    c, pg, errs, first, _ = open_ids(f"try{{localStorage.setItem('kubusai:user','{old_id}')}}catch(e){{}}")
    check('[v2.2.2] 예전 8자 ID가 있는 기기: 바꾸지 않고 그대로 씀', pg.evaluate("localStorage.getItem('kubusai:user')") == old_id and first and set(first) == {old_id} and not errs, f'{old_id} {set(first)}')
    c.close()
    c, pg, errs, first, again = open_ids(BLOCK_LS, reload=True)
    blocked_id = first[0] if first else ''
    ls_state = pg.evaluate("(() => { try { localStorage.getItem('x'); return 'open'; } catch (e) { return 'blocked'; } })()")
    check("[v2.2.2] 저장 공간이 막힌 기기(쿠키는 됨): 'demo'가 아니라 이 기기만의 긴 ID · 새로고침해도 쿠키로 같은 사용자 · 앱은 그대로 열림",
          ls_state == 'blocked' and bool(LONG.match(blocked_id)) and set(first) == {blocked_id} and again and set(again) == {blocked_id} and cookie_of(c) == blocked_id and not errs,
          f'{ls_state} {set(first)} → {set(again)} {errs[:1]}')
    c.close()
    ca, pga, errsa, firsta, againa = open_ids(BLOCK_LS + BLOCK_COOKIE, reload=True)
    cb, pgb, errsb, firstb, _ = open_ids(BLOCK_LS + BLOCK_COOKIE)
    ida, idb = (firsta or [''])[0], (firstb or [''])[0]
    check("[v2.2.2] 저장 공간 · 쿠키가 모두 막힌 기기 둘: 각자 다른 임시 ID(같은 페이지 안에서는 같은 값) · 'demo' 없음",
          bool(LONG.match(ida)) and bool(LONG.match(idb)) and ida != idb and set(firsta) == {ida} and set(firstb) == {idb} and 'demo' not in firsta + firstb + againa and not errsa and not errsb,
          f'{set(firsta)} / {set(firstb)} {errsa[:1]} {errsb[:1]}')
    check('[v2.2.2] 모두 막힌 기기를 새로 열면 새 임시 ID(기록을 남길 곳이 없음 — 다른 사람 기록과 섞이지 않음)', againa and len(set(againa)) == 1 and bool(LONG.match(againa[0])) and againa[0] != ida, f'{ida} → {set(againa)}')
    ca.close(); cb.close()
    ih = api(ctx := b.new_context(), 8802, 'x', 'GET', '/api/health')['identity']; ctx.close()
    check("[v2.2.2] /api/health identity: 'demo'로 온 요청 0 · 긴 ID 사용자가 생김 · ID 값은 싣지 않음", ih['demoHeader'] == 0 and ih['users']['long'] >= 4 and ih['demoUser'] is None
          and blocked_id not in json.dumps(ih), str(ih))

    # ⑧ v2.2.5 설정 › 내 데이터 › '내 데이터 모두 삭제'(8801 · 가짜 Upstash): '삭제'를 입력해야 버튼이 켜짐 · 서버가 실패하면 이 기기 값은 그대로 ·
    #    성공하면 서버(외부 DB) 기록 → 이 기기 알림 구독 · K•CARD+ · 저장값 → 새 사용자 번호로 처음 화면 + 완료 안내
    ctx = b.new_context(**p.devices['iPhone 13'])
    ctx.grant_permissions(['notifications'], origin='http://localhost:8801')
    ctx.add_init_script(PUSH_STUB)
    pg = ctx.new_page(); errs = []
    pg.on('pageerror', lambda e: errs.append(str(e)))
    pg.clock.install(time=T0); pg.goto('http://localhost:8801/')
    pg.get_by_test_id('onboarding').wait_for(timeout=10000)
    old = pg.evaluate("localStorage.getItem('kubusai:user')")
    api(ctx, 8801, old, 'PUT', '/api/me/timetable', {'classes': [CLASS]})
    api(ctx, 8801, old, 'PATCH', '/api/me', {'stop': {'arsId': '08901', 'name': '정릉시장'}})
    pg.evaluate("localStorage.setItem('kubusai:kcard', JSON.stringify({ width: 1, height: 1, size: 1, type: 'image/png', savedAt: 1, dataUrl: 'data:image/png;base64,AA==' })); localStorage.setItem('kubusai:push', 'on'); localStorage.setItem('__e2e_push_sub', '1')")
    pg.evaluate("navigator.serviceWorker.register('/sw.js').then(() => navigator.serviceWorker.ready)")
    pg.reload(); pg.locator('section[aria-label="출발 추천"]').wait_for(timeout=10000)
    deleted0 = api(ctx, 8801, 'x', 'GET', '/api/health')['storage'].get('deleted', 0)
    pg.evaluate("location.hash = '#settings'")
    md = pg.get_by_test_id('mydata'); md.wait_for(timeout=8000); md.scroll_into_view_if_needed()
    mtx = flat(md.inner_text())
    check('[v2.2.5] 설정 › 내 데이터: 저장하는 것 · 90일 · K•CARD+ 이 기기만 · 문의(GitHub Issues · 이메일) · 내 데이터 모두 삭제',
          '서버에 저장하는 것' in mtx and '90일' in mtx and '이 기기만' in mtx and md.get_by_test_id('contact-issues').get_attribute('href') == 'https://github.com/405woon-bot/ku-bus-ai/issues'
          and md.get_by_test_id('contact-issues').get_attribute('target') == '_blank' and md.get_by_test_id('contact-mail').get_attribute('href') == 'mailto:405woon@gmail.com'
          and md.get_by_test_id('delete-all').count() == 1, mtx[:200])
    md.screenshot(path=str(OUT / 'live_iphone13_mydata.png'))
    md.get_by_test_id('delete-all').click()
    dlg = pg.get_by_test_id('delete-dialog'); dlg.wait_for(timeout=5000)
    confirm = pg.get_by_test_id('delete-confirm'); inp = pg.get_by_test_id('delete-input')
    states = [confirm.is_disabled()]
    inp.fill('삭'); states.append(confirm.is_disabled())
    inp.fill('삭제하기'); states.append(confirm.is_disabled())
    inp.fill('삭제'); states.append(confirm.is_disabled())
    check("[v2.2.5] 확인 창: '삭제'를 정확히 입력해야만 [모두 삭제]가 켜짐(빈칸 · '삭' · '삭제하기'는 꺼짐) · 키보드가 바로 올라오지 않음(입력칸에 자동 포커스 안 함)",
          states == [True, True, True, False] and dlg.get_attribute('data-state') == 'ready', str(states))
    inp.press('Enter'); pg.wait_for_timeout(500)
    check("[v2.2.5] '삭제' 입력 뒤 키보드 완료(Enter) → 지우지 않음(빨간 버튼으로만) · 창 · 서버 기록 · 이 기기 사용자 번호 그대로",
          pg.get_by_test_id('delete-dialog').count() == 1 and len(api(ctx, 8801, old, 'GET', '/api/me')['classes']) == 1 and pg.evaluate("localStorage.getItem('kubusai:user')") == old
          and pg.evaluate("document.activeElement?.dataset?.testid") != 'delete-input')
    pg.screenshot(path=str(OUT / 'live_iphone13_delete_dialog.png'))
    pg.get_by_test_id('delete-cancel').click(); pg.wait_for_timeout(300)
    kept = api(ctx, 8801, old, 'GET', '/api/me')
    check('[v2.2.5] 취소 → 창만 닫히고 아무것도 지우지 않음', pg.get_by_test_id('delete-dialog').count() == 0 and len(kept['classes']) == 1 and kept['stop']['arsId'] == '08901')
    # 서버가 실패하면(503) 이 기기 값은 그대로 · 다시 시도
    def fail_once(route):
        if route.request.method == 'DELETE':
            route.fulfill(status=503, content_type='application/json', body=json.dumps({'error': '외부 저장소에서 아직 지우지 못했어요', 'kind': 'pending'}))
        else:
            route.continue_()
    pg.route('**/api/me', fail_once)
    md.get_by_test_id('delete-all').click(); dlg.wait_for(timeout=5000)
    pg.get_by_test_id('delete-input').fill('삭제'); pg.get_by_test_id('delete-confirm').click()
    pg.get_by_test_id('delete-error').wait_for(timeout=8000)
    etx = flat(pg.get_by_test_id('delete-error').inner_text())
    still = api(ctx, 8801, old, 'GET', '/api/me')
    check('[v2.2.5] 서버 실패: 이유 + 이 기기 값은 그대로 · [다시 시도] · 이 기기 사용자 번호 · K•CARD+ 그대로 · 서버 기록 그대로',
          '서버 기록을 지우지 못했어요.' in etx and '이 기기 값은 그대로' in etx and flat(pg.get_by_test_id('delete-confirm').inner_text()) == '다시 시도'
          and pg.evaluate("localStorage.getItem('kubusai:user')") == old and pg.evaluate("localStorage.getItem('kubusai:kcard')") is not None and len(still['classes']) == 1, etx)
    pg.screenshot(path=str(OUT / 'live_iphone13_delete_error.png'))
    pg.unroute('**/api/me')
    with pg.expect_navigation(timeout=15000):
        pg.get_by_test_id('delete-confirm').click()
    pg.get_by_test_id('deleted-note').wait_for(timeout=10000)
    pg.get_by_test_id('onboarding').wait_for(timeout=10000)
    new_id = pg.evaluate("localStorage.getItem('kubusai:user')")
    gone = api(ctx, 8801, old, 'GET', '/api/me')
    h8 = api(ctx, 8801, 'x', 'GET', '/api/health')['storage']
    cookie_now = next((k['value'] for k in ctx.cookies() if k['name'] == 'kubusai_uid'), None)
    check('[v2.2.5] 모두 삭제 → 서버(외부 DB) 기록 없음 · 새 사용자 번호(긴 ID) · 쿠키도 새 번호 · 처음 화면 + 완료 안내 · 주소에 표시 없음',
          len(gone['classes']) == 0 and gone['stop'] is None and h8.get('deleted', 0) >= deleted0 + 1 and new_id and new_id != old and bool(LONG.match(new_id))
          and cookie_now == new_id and 'deleted' not in pg.url and '내 데이터를 모두 지웠어요' in pg.get_by_test_id('deleted-note').inner_text(), f'{old} → {new_id} {pg.url} {h8}')
    late = api(ctx, 8801, old, 'PATCH', '/api/me', {'stop': {'arsId': '08901', 'name': '정릉시장'}})
    check('[v2.2.5] 지운 직후 예전 번호로 늦게 온 저장은 받지 않음(409 deleted) · 기록을 다시 만들지 않음',
          late.get('kind') == 'deleted' and api(ctx, 8801, old, 'GET', '/api/me')['stop'] is None, str(late))
    check('[v2.2.5] 이 기기: K•CARD+ 캡처 · 알림 켬 표시 · 알림 구독(브라우저) 지움 · 앱 저장값은 새 사용자 것만',
          pg.evaluate("localStorage.getItem('kubusai:kcard')") is None and pg.evaluate("localStorage.getItem('kubusai:push')") is None
          and pg.evaluate("localStorage.getItem('__e2e_push_sub')") is None and '정릉시장' not in (pg.evaluate("localStorage.getItem('kubusai:v1')") or ''))
    pg.screenshot(path=str(OUT / 'live_iphone13_deleted_home.png'))
    check('[v2.2.5] 페이지 오류 없음', not errs, str(errs)[:200])
    ctx.close()

    # ⑨ v2.2.6(8801): 근처 정류장 후보 6곳(화면 3곳) · Gemini 기다림 4초 · 오늘 거른 AI 문장 수(가짜 Gemini는 지시문대로 써서 원인 단정 0)
    h9 = api(b.new_context(), 8801, 'x', 'GET', '/api/health')
    check('[v2.2.6] /api/health: nearKu 후보 6곳 · 화면 3곳 · 심야 표시 수 · explain 기다림 4초(화면 1.2초) · 거른 수(원인 단정 없음) · 문장 · 키 없음',
          h9['nearKu']['maxStops'] == 6 and h9['nearKu']['show'] == 3 and h9['nearKu']['night'] == 0 and h9['explain']['timeoutMs'] == 4000 and h9['explain']['waitMs'] == 1200
          and isinstance(h9['explain']['rejected'], dict) and h9['explain']['rejected'].get('causal', 0) == 0 and 'E2E-GEMINI-KEY' not in json.dumps(h9),
          json.dumps({'nearKu': h9['nearKu'], 'explain': {k: h9['explain'][k] for k in ('timeoutMs', 'waitMs', 'rejected')}}, ensure_ascii=False)[:300])

    # ⑩ v2.3.0(8801): 실시간 지하철 허용 목록 19개 · 확인 도구 /api/subway/test(가짜 서울시에는 시험 역 열차가 없어 모두 '없음') · 10분 보관 ·
    #   /api/health 새 항목(역 · 노선 이름 없이 합계만) · 키는 어디에도 안 나옴. 환승 경로(2호선)의 첫 지하철 실시간은 위 [환승] 검사에서 그대로 확인
    c10 = b.new_context()
    t10 = api(c10, 8801, 'x', 'GET', '/api/subway/test'); t10b = api(c10, 8801, 'x', 'GET', '/api/subway/test')
    h10 = api(c10, 8801, 'x', 'GET', '/api/health')['seoulSubway']; c10.close()
    check('[v2.3.0] /api/subway/test: 고정 역 8곳(서울 … 수서) · 모두 없음이면 ok false(nodata) · 경강선은 시험 역 없음 · 허용 목록 19 · 다시 열면 보관한 결과 · 키 없음',
          t10['ok'] is False and t10['reason'] == 'nodata' and [s['station'] for s in t10['stations']] == ['서울', '왕십리', '상봉', '강남', '성신여대입구', '김포공항', '신림', '수서']
          and all(s['status'] == 'nodata' for s in t10['stations']) and t10['check']['1081']['result'].startswith('시험 역 없음') and t10['check']['1065']['result'].startswith('안 보임')
          and t10['allow'] == {'total': 19, 'on': 19, 'off': []} and t10['runsToday'] == 1 and t10b['cached'] is True and 'SUBWAY-TEST-KEY' not in json.dumps(t10),
          json.dumps({k: t10.get(k) for k in ('ok', 'reason', 'runsToday', 'allow')}, ensure_ascii=False)[:300])
    check('[v2.3.0] /api/health seoulSubway: 19개 노선 켬 · 오늘 시험 1번(하루 3번) · 열차를 뺀 횟수 · 목록 밖이라 부르지 않은 횟수 · 역 · 노선 이름 없음 · 키 없음',
          h10['lines'] == {'total': 19, 'on': 19, 'off': []} and h10['test']['runsToday'] == 1 and h10['test']['maxPerDay'] == 3
          and set(h10['filtered']) == {'line', 'dir', 'type', 'dest'} and h10['skipped'] == {'line': 0, 'off': 0}
          and '서울' not in json.dumps(h10, ensure_ascii=False) and 'SUBWAY-TEST-KEY' not in json.dumps(h10), json.dumps(h10, ensure_ascii=False)[:300])
    b.close()

print('\n'.join(res)); n = sum(r.startswith('FAIL') for r in res)
print(f'{len(res) - n} passed, {n} failed'); sys.exit(1 if n else 0)
