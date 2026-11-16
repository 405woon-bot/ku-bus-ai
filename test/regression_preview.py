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
        # '왜 늦나요?'(미리보기 예시 문장 · 실제 AI 응답 아님): 171 혼잡 → 버스 카드 바로 아래 노란 줄(지난번 '경로 주변' 줄 자리)
        LBL = '왜 늦나요?'
        flat = lambda t: re.sub(r'\s+', ' ', t)
        order_now = lambda: pg.evaluate('''() => [...document.querySelectorAll('section[aria-label]')].map(s => s.getAttribute('aria-label'))''')
        why = pg.locator('[data-testid="why-strip"]')
        fold = lambda: why.get_by_role('button').first.click()
        order = order_now(); txt = flat(why.inner_text())
        check(f'[{label}] 왜 늦나요?(비+공사): 버스 카드 다음 · 노란 줄 · AI + 예시 태그 · +2분 · 근거 · 경로 주변 줄은 안 겹침', why.count() == 1 and why.get_attribute('data-tone') == 'caution'
              and why.get_attribute('data-why') == 'ai' and order.index(LBL) == order.index('실시간 버스 도착') + 1 and txt.replace(' ', '').startswith('왜늦나요?AI예시') and '정릉로에 공사에다 비까지 겹쳐 버스가 많이 막혀요.' in txt
              and '+2분' in txt and '근거' in txt and pg.locator('[data-testid="incident-strip"]').count() == 0, txt)
        fold(); pg.wait_for_timeout(200)
        txt = flat(why.inner_text())
        check(f'[{label}] 근거 펼침: 서버 계산 · 느린 도로 · 날씨(예시) · 돌발 2건(예시, 예정 포함) · 예시 표시 · 실제 AI 응답 아님', pg.locator('[data-testid="why-fact-calc"]').count() == 1
              and '원활할 때보다 약 2분 더 걸려요' in txt and '원활 기준 시속 20km' in txt and '정릉로 · 많이 느림' in txt and '날씨 · 예시' in txt and '비 · 1시간 1.5mm' in txt
              and '공사 정릉로 하수관 정비공사(예시) · 경로 위' in txt and '거리 행사(예시) · 국민대 근처' in txt and '부터 예정' in txt
              and '예시 데이터 · 실시간 아님' in txt and '실제 AI 응답 아님' in txt and '실제 서비스에서는 AI(Gemini)가 위 사실만 보고 문장을 써요' in txt, txt)
        ov = pg.evaluate('document.documentElement.scrollWidth - document.documentElement.clientWidth')
        check(f'[{label}] 펼침: 가로 넘침 없음', ov <= 0, str(ov))
        pg.screenshot(path=OUT + f'preview_{label}_why_open.png', full_page=True)
        fold(); pg.wait_for_timeout(200)
        check(f'[{label}] 접기', pg.locator('[data-testid="why-fact-calc"]').count() == 0 and why.count() == 1)
        pg.get_by_role('button', name='기본 안내', exact=True).click(); pg.wait_for_timeout(300)
        txt = flat(why.inner_text())
        check(f'[{label}] AI 보기 · 기본 안내: 기본 안내 태그 + 사실만 쓴 문장', why.get_attribute('data-why') == 'rule' and '기본 안내' in txt
              and '정릉로가 막혀요. 비 · 공사 영향일 수 있어요.' in txt and '+2분' in txt, txt)
        pg.screenshot(path=OUT + f'preview_{label}_why_rule.png')
        pg.get_by_role('button', name='AI 문장', exact=True).click()
        pg.get_by_role('button', name='맑음', exact=True).click(); pg.wait_for_timeout(300)
        txt = flat(why.inner_text())
        check(f'[{label}] 맑음: 공사만 근거', '정릉로에 공사까지 겹쳐 버스가 많이 막혀요.' in txt and '비까지' not in txt, txt)
        pg.get_by_role('button', name='행사만', exact=True).click(); pg.wait_for_timeout(300)
        txt = flat(why.inner_text())
        check(f'[{label}] 맑음 + 행사만(예정): 예정된 행사는 원인으로 쓰지 않음', '정릉로에서 버스가 많이 느려요. 특이 원인은 확인되지 않았어요.' in txt and '행사' not in txt, txt)
        fold(); pg.wait_for_timeout(200)
        txt = flat(why.inner_text())
        check(f'[{label}] 맑음 + 행사만 펼침: 강수 없음 · 예정 행사는 근거 목록에만', '강수 없음' in txt and '거리 행사(예시) · 국민대 근처' in txt and '부터 예정' in txt, txt)
        fold(); pg.wait_for_timeout(200)
        pg.get_by_role('button', name='없음', exact=True).click(); pg.get_by_role('button', name='눈', exact=True).click(); pg.wait_for_timeout(300)
        txt = flat(why.inner_text())
        check(f'[{label}] 눈 + 돌발 없음: 날씨만 근거', '정릉로에 눈까지 와서 버스가 많이 막혀요.' in txt, txt)
        pg.screenshot(path=OUT + f'preview_{label}_why_snow.png')
        pg.get_by_role('button', name='실시간 실패', exact=True).click(); pg.get_by_role('button', name='공사+행사', exact=True).click()
        pg.get_by_role('button', name='비', exact=True).click(); pg.wait_for_timeout(300)
        order = order_now(); txt = flat(why.inner_text())
        check(f'[{label}] 실시간 실패: 왜 늦나요?는 점선 · 세 카드 다음 · (예시) · 예시 데이터 · 실시간 아님', why.get_attribute('data-tone') == 'mock' and why.get_attribute('data-why') == 'example'
              and order.index(LBL) > order.index('강의실 도착 예정') and '(예시)' in txt and '예시 데이터 · 실시간 아님' in txt and '정릉로가 막혀요. 비 · 공사 영향일 수 있어요.' in txt, txt)
        pg.screenshot(path=OUT + f'preview_{label}_why_mock.png', full_page=True)
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
        ais = re.sub(r'\s+', ' ', pg.locator('[data-testid="explain-status"]').inner_text())
        check(f'[{label}] 설정: AI 설명(Gemini) 상태(미리보기 · 예시)', ais == '미리보기 · 예시', ais)
        ov = pg.evaluate('document.documentElement.scrollWidth - document.documentElement.clientWidth')
        check(f'[{label}] 설정 가로 넘침 없음', ov <= 0, str(ov))
        pg.screenshot(path=OUT + f'preview_{label}_settings.png')
        check(f'[{label}] 페이지 오류 없음', not errs, str(errs)[:200])
        ctx.close()
    b.close()
print('\n'.join(res)); n = sum(r.startswith('FAIL') for r in res)
print(f'{len(res) - n} passed, {n} failed'); sys.exit(1 if n else 0)
