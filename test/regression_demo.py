"""회귀: 단일 HTML 데모(dist-single)가 API 키·네트워크 없이 예시 데이터로 v0.1처럼 동작하는지.
실행: cd frontend && npm run build:single  →  python test/regression_demo.py"""
import re, sys
from pathlib import Path
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
URL = (ROOT / 'frontend/dist-single/index.html').as_uri()
OUT = Path(__file__).resolve().parent / 'screenshots'
res = []
def check(n, c, d=''): res.append(('PASS' if c else 'FAIL') + f' {n} {d}')

with sync_playwright() as p:
    b = p.chromium.launch()
    for label, args in [('desktop', dict(viewport={'width': 1440, 'height': 900})), ('iphone13', dict(**p.devices['iPhone 13']))]:
        ctx = b.new_context(**args)
        blocked = []
        ctx.route('**/*', lambda route: (blocked.append(route.request.url), route.abort()) if route.request.url.startswith('http') else route.continue_())
        pg = ctx.new_page(); errs = []
        pg.on('pageerror', lambda e: errs.append(str(e)))
        pg.goto(URL)
        card = pg.locator('section[aria-label="등교 지연 알림"]')
        card.wait_for(timeout=10000)
        t = re.sub(r'\s+', ' ', card.inner_text())
        check(f'[{label}] 예시 데이터 문구(v0.1과 같음)', '현재 정릉로 정체로 171번 8분 지연! 8:31까지 출발을 권장합니다. (대체 추천: 후문 방향 1112번 탑승 시 정시 출발 가능)' in t, t[:160])
        check(f'[{label}] 예시 데이터 점선 배지', card.locator('[data-source="mock"]').count() >= 1 and card.locator('[data-source="seoul"]').count() == 0)
        check(f'[{label}] 승차 정류장 입력 칸(노선 3개)', pg.locator('input[aria-label$="승차 정류장 번호"]').count() == 3)
        pg.fill('input[aria-label="171번 승차 정류장 번호"]', '08901')
        st = pg.inner_text('[data-testid="route-status-171"]')
        check(f'[{label}] 데모에서는 예시 데이터로 계산 안내', '예시 데이터' in st, st)
        ov = pg.evaluate('document.documentElement.scrollWidth - document.documentElement.clientWidth')
        check(f'[{label}] 가로 넘침 없음', ov <= 0, str(ov))
        if label == 'desktop':
            pg.screenshot(path=str(OUT / 'demo_desktop.png'))
            pg.get_by_role('button', name='출발 알림 1분 전으로').click()
            pg.get_by_role('radio', name='60×').first.click()
            try:
                pg.wait_for_selector('[role="alert"]:has-text("10분 뒤 출발하세요 (08:31)")', timeout=15000)
                check('[desktop] 출발 알림 팝업(10분 뒤 출발하세요 08:31)', True)
            except Exception as e:
                check('[desktop] 출발 알림 팝업(10분 뒤 출발하세요 08:31)', False, str(e)[:100])
        check(f'[{label}] 페이지 오류 없음', not errs, str(errs)[:200])
        check(f'[{label}] 외부 요청은 모두 차단된 상태로 동작', all(not u.startswith('http://localhost') for u in blocked), f'{len(blocked)}건 차단(웹폰트 등)')
        ctx.close()
    b.close()
print('\n'.join(res)); n = sum(r.startswith('FAIL') for r in res)
print(f'{len(res) - n} passed, {n} failed'); sys.exit(1 if n else 0)
