"""미리보기 빌드(frontend/dist-preview/index.html) 회귀 점검 — 서버·API 키·네트워크 없이 열림.
모든 http 요청을 막은 상태에서 배지 상태 3가지(실시간 연결 · 잠시 끊김 · 실시간 실패)를 휴대폰·PC로 확인합니다.
실행: cd frontend && npm run build:preview  →  python test/regression_preview.py"""
import re, sys
from pathlib import Path
from playwright.sync_api import sync_playwright
ROOT = Path(__file__).resolve().parent.parent
URL = (ROOT / 'frontend' / 'dist-preview' / 'index.html').as_uri()
OUT = str(ROOT / 'test' / 'screenshots') + '/'

res = []
def check(n, c, d=''): res.append(('PASS' if c else 'FAIL') + f' {n} {d}')
with sync_playwright() as p:
    b = p.chromium.launch()
    for label, args in [('iphone13', dict(**p.devices['iPhone 13'])), ('desktop', dict(viewport={'width': 1440, 'height': 900}))]:
        ctx = b.new_context(**args)
        ctx.route('**/*', lambda r: r.abort() if r.request.url.startswith('http') else r.continue_())
        pg = ctx.new_page(); errs = []
        pg.on('pageerror', lambda e: errs.append(str(e)))
        pg.goto(URL)
        card = pg.locator('section[aria-label="출발 추천"]'); card.wait_for(timeout=10000)
        for state, btn in [('live', '실시간 연결'), ('stale', '잠시 끊김'), ('fallback', '실시간 실패')]:
            pg.get_by_role('button', name=btn, exact=True).click(); pg.wait_for_timeout(400)
            line = re.sub(r'\s+', ' ', pg.locator('[data-testid="data-line"]').inner_text())
            ov = pg.evaluate('document.documentElement.scrollWidth - document.documentElement.clientWidth')
            bar = pg.locator('div.border-b.border-dashed.bg-surface').first.bounding_box()
            third = pg.locator('section[aria-label="강의실 도착 예정"]').bounding_box()
            third = {**third, 'y': third['y'] - bar['height']}  # 실제 서비스에는 미리보기 띠가 없음
            vh = pg.viewport_size['height']
            tabbar = pg.locator('nav.fixed').bounding_box() if label == 'iphone13' else None
            limit = tabbar['y'] if tabbar else vh
            check(f'[{label}/{state}] 데이터 줄', True, line)
            check(f'[{label}/{state}] 가로 넘침 없음', ov <= 0, str(ov))
            check(f'[{label}/{state}] 3요소가 첫 화면에 보임(미리보기 띠 제외)', third['y'] + third['height'] <= limit, f"bottom={third['y']+third['height']:.0f} limit={limit:.0f}")
            pg.screenshot(path=OUT + f'preview_{label}_home_{state}.png')
        src = pg.locator('section[aria-label="출발 추천"]').get_attribute('data-source')
        check(f'[{label}] 실패 상태: 출발 추천 카드 점선(예시)', src == 'mock' and pg.locator('[data-testid="fallback-notice"]').count() == 1)
        pg.get_by_role('button', name='실시간 연결', exact=True).click(); pg.wait_for_timeout(300)
        sub = pg.locator('section[aria-label="실시간 버스 도착"]').inner_text()
        check(f'[{label}] 정체 원인 표시', '정릉로 정체' in sub, re.sub(r'\s+', ' ', sub))
        # 경로 주변 날씨 · 돌발정보(예시): 버스 카드 바로 아래 노란 줄 → 누르면 날씨 1 + 돌발 2 + '예시 데이터 · 실시간 아님'
        LBL = '경로 주변 날씨 · 돌발정보'
        flat = lambda t: re.sub(r'\s+', ' ', t)
        order_now = lambda: pg.evaluate('''() => [...document.querySelectorAll('section[aria-label]')].map(s => s.getAttribute('aria-label'))''')
        strip = pg.locator('[data-testid="incident-strip"]')
        order = order_now(); txt = flat(strip.inner_text())
        check(f'[{label}] 경로 주변 줄(비+공사): 버스 카드 다음 · 노란 줄 · 정체 원인일 수 있어요 · 비 · 공사', strip.count() == 1 and strip.get_attribute('data-tone') == 'caution'
              and order.index(LBL) == order.index('실시간 버스 도착') + 1 and '정체 원인일 수 있어요 · 비 · 공사' in txt and '1시간 1.5mm' in txt and '관측' in txt, txt)
        strip.get_by_role('button').click(); pg.wait_for_timeout(200)
        txt = flat(strip.inner_text())
        check(f'[{label}] 펼침: 날씨 1(맨 위) + 돌발 2 + 예시 표시', pg.locator('[data-testid="weather-item"]').count() == 1 and pg.locator('[data-testid="incident-item"]').count() == 2
              and txt.index('날씨') < txt.index('공사 정릉로') and '기온 7.2℃' in txt and '국민대에서 약' in txt and '예시 데이터 · 실시간 아님' in txt, txt)
        ov = pg.evaluate('document.documentElement.scrollWidth - document.documentElement.clientWidth')
        check(f'[{label}] 펼침: 가로 넘침 없음', ov <= 0, str(ov))
        pg.screenshot(path=OUT + f'preview_{label}_incident_open.png')
        strip.get_by_role('button').click(); pg.wait_for_timeout(200)  # 접기
        check(f'[{label}] 접기', pg.locator('[data-testid="incident-item"]').count() == 0 and pg.locator('[data-testid="weather-item"]').count() == 0)
        pg.get_by_role('button', name='맑음', exact=True).click(); pg.wait_for_timeout(300)
        txt = flat(strip.inner_text())
        check(f'[{label}] 날씨 보기 · 맑음: 날씨는 빠지고 돌발정보만(정체 원인일 수 있어요 · 공사, 2건)', strip.get_attribute('data-weather') == ''
              and '정체 원인일 수 있어요 · 공사' in txt and '2건' in txt and '1시간' not in txt, txt)
        pg.get_by_role('button', name='행사만', exact=True).click(); pg.wait_for_timeout(300)
        txt = flat(strip.inner_text())
        check(f'[{label}] 맑음 + 행사만: 흰 줄(예정 · 참고)', strip.get_attribute('data-tone') == 'info' and '국민대 근처 집회 · 행사 예정' in txt, txt)
        pg.get_by_role('button', name='없음', exact=True).click(); pg.wait_for_timeout(300)
        check(f'[{label}] 맑음 + 돌발 없음: 줄이 사라짐(지금 화면과 같음)', strip.count() == 0)
        pg.get_by_role('button', name='눈', exact=True).click(); pg.wait_for_timeout(300)
        txt = flat(strip.inner_text())
        check(f'[{label}] 눈 + 돌발 없음: 날씨만 노란 줄(정체 원인일 수 있어요 · 눈)', strip.count() == 1 and strip.get_attribute('data-tone') == 'caution'
              and '정체 원인일 수 있어요 · 눈' in txt and '1시간 0.5mm' in txt, txt)
        pg.screenshot(path=OUT + f'preview_{label}_weather_only.png')
        pg.get_by_role('button', name='실시간 실패', exact=True).click(); pg.get_by_role('button', name='공사+행사', exact=True).click()
        pg.get_by_role('button', name='비', exact=True).click(); pg.wait_for_timeout(300)
        order = order_now(); txt = flat(strip.inner_text())
        check(f'[{label}] 실시간 실패: 예시 1줄은 점선 · 세 카드 다음 · 비 + 공사 (예시)', strip.get_attribute('data-tone') == 'mock'
              and order.index(LBL) > order.index('강의실 도착 예정') and '예시 데이터 · 실시간 아님' in txt and '비 오는 중' in txt, txt)
        pg.get_by_role('button', name='실시간 연결', exact=True).click(); pg.wait_for_timeout(300)
        # 설정 화면
        pg.evaluate("location.hash = '#settings'"); pg.wait_for_timeout(400)
        pg.get_by_role('button', name='서버 푸시 켜기').click(); pg.wait_for_timeout(300)
        panel = re.sub(r'\s+', ' ', pg.locator('[data-testid="push-panel"]').inner_text())
        check(f'[{label}] 미리보기 서버 푸시 → error 안내', '서버 푸시 오류(error)' in panel, panel)
        inc = re.sub(r'\s+', ' ', pg.locator('[data-testid="incident-status"]').inner_text())
        check(f'[{label}] 설정: 돌발정보 상태(미리보기 · 예시)', inc == '미리보기 · 예시', inc)
        wxs = re.sub(r'\s+', ' ', pg.locator('[data-testid="weather-status"]').inner_text())
        check(f'[{label}] 설정: 날씨(기상청) 상태(미리보기 · 예시)', wxs == '미리보기 · 예시', wxs)
        ov = pg.evaluate('document.documentElement.scrollWidth - document.documentElement.clientWidth')
        check(f'[{label}] 설정 가로 넘침 없음', ov <= 0, str(ov))
        pg.screenshot(path=OUT + f'preview_{label}_settings.png')
        check(f'[{label}] 페이지 오류 없음', not errs, str(errs)[:200])
        ctx.close()
    b.close()
print('\n'.join(res)); n = sum(r.startswith('FAIL') for r in res)
print(f'{len(res) - n} passed, {n} failed'); sys.exit(1 if n else 0)
