"""미리보기 빌드(frontend/dist-preview/index.html) 회귀 점검 — 서버·API 키·네트워크 없이 열림.
모든 http 요청을 막은 상태에서 배지 상태 3가지(실시간 연결 · 잠시 끊김 · 실시간 실패)를 휴대폰·PC로 확인합니다.
실행: cd frontend && npm run build:preview  →  python test/regression_preview.py"""
import io, re, sys
from pathlib import Path
from playwright.sync_api import sync_playwright
from PIL import Image, ImageDraw
ROOT = Path(__file__).resolve().parent.parent
URL = (ROOT / 'frontend' / 'dist-preview' / 'index.html').as_uri()
OUT = str(ROOT / 'test' / 'screenshots') + '/'

res = []
def check(n, c, d=''): res.append(('PASS' if c else 'FAIL') + f' {n} {d}')
def capture_png():
    """시험용 '캡처' 이미지(세로 1170×2532, 실제 학생증 아님)"""
    im = Image.new('RGB', (1170, 2532), '#EEF1F5'); d = ImageDraw.Draw(im)
    d.rectangle([180, 700, 990, 1510], fill='#FFFFFF'); d.rectangle([330, 850, 840, 1360], fill='#2B3442')
    buf = io.BytesIO(); im.save(buf, 'PNG'); return buf.getvalue()
CAPTURE = capture_png()
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
              and why.get_attribute('data-why') == 'ai' and order.index(LBL) == order.index('실시간 버스 도착') + 1 and txt.replace(' ', '').startswith('왜늦나요?AI예시') and '정릉로가 많이 막혀요. 공사와 비 영향일 수 있어요.' in txt
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
        fold(); pg.wait_for_timeout(200)
        txt = flat(why.inner_text())
        check(f'[{label}] v2.2.6 기본 안내 펼침: 맨 아래 까닭 — AI 문장이 원인을 단정해 기본 안내로 바꿨어요 · 원인 확정 아님', why.get_attribute('data-reason') == 'causal'
              and 'AI 문장이 원인을 단정해 기본 안내로 바꿨어요 · 정체의 원인이라고 확정하는 건 아니에요' in txt, txt[-160:])
        if label == 'iphone13': pg.screenshot(path=OUT + f'preview_{label}_why_rule_open.png', full_page=True)
        fold(); pg.wait_for_timeout(200)
        pg.get_by_role('button', name='AI 문장', exact=True).click()
        pg.get_by_role('button', name='맑음', exact=True).click(); pg.wait_for_timeout(300)
        txt = flat(why.inner_text())
        check(f'[{label}] 맑음: 공사만 근거(v2.2.6 원인을 잇지 않고 따로 · 가능성으로만)', '정릉로가 많이 막혀요. 공사 영향일 수 있어요.' in txt and '비 영향' not in txt and '공사와 비' not in txt, txt)
        pg.get_by_role('button', name='행사만', exact=True).click(); pg.wait_for_timeout(300)
        txt = flat(why.inner_text())
        check(f'[{label}] 맑음 + 행사만(예정): 예정된 행사는 원인으로 쓰지 않음', '정릉로에서 버스가 많이 느려요. 특이 원인은 확인되지 않았어요.' in txt and '행사' not in txt, txt)
        fold(); pg.wait_for_timeout(200)
        txt = flat(why.inner_text())
        check(f'[{label}] 맑음 + 행사만 펼침: 강수 없음 · 예정 행사는 근거 목록에만', '강수 없음' in txt and '거리 행사(예시) · 국민대 근처' in txt and '부터 예정' in txt, txt)
        fold(); pg.wait_for_timeout(200)
        pg.get_by_role('button', name='없음', exact=True).click(); pg.get_by_role('button', name='눈', exact=True).click(); pg.wait_for_timeout(300)
        txt = flat(why.inner_text())
        check(f'[{label}] 눈 + 돌발 없음: 날씨만 근거(v2.2.6 원인을 잇지 않음)', '정릉로가 많이 막혀요. 눈 영향일 수 있어요.' in txt and '와서' not in txt, txt)
        pg.screenshot(path=OUT + f'preview_{label}_why_snow.png')
        pg.get_by_role('button', name='실시간 실패', exact=True).click(); pg.get_by_role('button', name='공사+행사', exact=True).click()
        pg.get_by_role('button', name='비', exact=True).click(); pg.wait_for_timeout(300)
        order = order_now(); txt = flat(why.inner_text())
        check(f'[{label}] 실시간 실패: 왜 늦나요?는 점선 · 세 카드 다음 · (예시) · 예시 데이터 · 실시간 아님', why.get_attribute('data-tone') == 'mock' and why.get_attribute('data-why') == 'example'
              and order.index(LBL) > order.index('강의실 도착 예정') and '(예시)' in txt and '예시 데이터 · 실시간 아님' in txt and '정릉로가 막혀요. 비 · 공사 영향일 수 있어요.' in txt, txt)
        pg.screenshot(path=OUT + f'preview_{label}_why_mock.png', full_page=True)
        pg.get_by_role('button', name='실시간 연결', exact=True).click(); pg.wait_for_timeout(300)
        # 기기 보기: 아이폰 Safari(설치 전) → 홈 화면 추가 안내 한 줄 · 방법 보기(iOS 26) · ×로 닫기
        bar = pg.locator('[data-testid="install-bar"]')
        check(f'[{label}] PC: 홈 화면 추가 안내 없음', bar.count() == 0)
        pg.get_by_role('button', name='아이폰 Safari', exact=True).click(); pg.wait_for_timeout(300)
        tabbox = pg.locator('nav.fixed').bounding_box() if label == 'iphone13' else None
        bb = bar.bounding_box() if bar.count() else None
        check(f'[{label}] 아이폰 Safari: 탭 바 위에 한 줄 안내(화면 배치는 그대로)', bar.count() == 1 and '홈 화면에 추가하고 알림 받기' in bar.inner_text()
              and (tabbox is None or bb['y'] + bb['height'] <= tabbox['y']), flat(bar.inner_text()) if bar.count() else 'none')
        pg.screenshot(path=OUT + f'preview_{label}_install_bar.png')
        bar.get_by_role('button', name='방법 보기').click(); pg.wait_for_timeout(300)
        sheet = pg.locator('[data-testid="install-sheet"]')
        txt = flat(sheet.inner_text())
        check(f'[{label}] 방법 보기(iOS 26): ⋯ → 공유 → 홈 화면에 추가 → 웹 앱으로 열기 → 알림 켜기 · 설정 이어짐', sheet.count() == 1 and '주소창 오른쪽' in txt and '공유' in txt
              and '웹 앱으로 열기' in txt and '알림 켜기' in txt and '그대로 이어져요' in txt and sheet.get_by_role('img', name='더 보기').count() == 1, txt)
        ov = pg.evaluate('document.documentElement.scrollWidth - document.documentElement.clientWidth')
        check(f'[{label}] 방법 보기: 가로 넘침 없음', ov <= 0, str(ov))
        pg.screenshot(path=OUT + f'preview_{label}_install_sheet.png')
        pg.keyboard.press('Escape'); pg.wait_for_timeout(200)
        check(f'[{label}] Esc로 닫힘', sheet.count() == 0 and bar.count() == 1)
        pg.get_by_role('button', name='카카오톡', exact=True).click(); pg.wait_for_timeout(300)
        bar.get_by_role('button', name='방법 보기').click(); pg.wait_for_timeout(300)
        txt = flat(sheet.inner_text())
        check(f'[{label}] 카카오톡 안: Safari로 열어 주세요 + 주소 복사', 'Safari로 열어 주세요' in txt and '카카오톡' in txt and sheet.get_by_role('button', name='주소 복사').count() == 1, txt)
        sheet.get_by_role('button', name='알겠어요').click(); pg.wait_for_timeout(200)
        pg.get_by_role('button', name='안내 닫기(7일 동안)').click(); pg.wait_for_timeout(200)
        check(f'[{label}] ×로 닫으면 안내 줄이 사라짐', bar.count() == 0)
        pg.get_by_role('button', name='아이폰 앱', exact=True).click(); pg.wait_for_timeout(300)
        check(f'[{label}] 아이폰 앱(홈 화면에서 연 앱): 안내 줄 없음', bar.count() == 0)
        # 설정 화면 — 아이폰 앱: 알림 켜기 → 켜짐 · 확인 필요 → 테스트 알림 → 수신 확인됨(모두 예시)
        pg.evaluate("location.hash = '#settings'"); pg.wait_for_timeout(400)
        panel = pg.locator('[data-testid="push-panel"]')
        check(f'[{label}] 설정 · 아이폰 앱: 백그라운드 알림 꺼짐 + 예시 표시', panel.get_attribute('data-state') == 'off' and '예시 · 실제 알림 아님' in panel.inner_text(), flat(panel.inner_text()))
        panel.get_by_role('button', name='알림 켜기').click(); pg.wait_for_timeout(900)
        check(f'[{label}] 알림 켜기 → 켜짐 · 확인 필요(예시)', panel.get_attribute('data-state') == 'on' and '켜짐 · 확인 필요' in panel.inner_text(), flat(panel.inner_text()))
        panel.get_by_role('button', name='테스트 알림 보내기').click(); pg.wait_for_timeout(300)
        check(f'[{label}] 테스트 알림 보냄 → 아직 확인 필요', '보냄' in panel.inner_text() and panel.get_attribute('data-confirmed') == '')
        pg.wait_for_timeout(2200)
        check(f'[{label}] 휴대폰이 받으면 → 수신 확인됨(예시)', panel.get_attribute('data-confirmed') == '1' and '수신 확인됨 · ' in panel.inner_text(), flat(panel.inner_text()))
        pg.screenshot(path=OUT + f'preview_{label}_push_confirmed.png', full_page=True)
        pg.get_by_role('button', name='아이폰 Safari', exact=True).click(); pg.wait_for_timeout(300)
        check(f'[{label}] 설정 · 아이폰 Safari: 홈 화면 앱에서만 → 방법 보기', panel.get_attribute('data-state') == 'need-install' and panel.get_by_role('button', name='방법 보기').count() == 1)
        pg.get_by_role('button', name='PC', exact=True).click(); pg.wait_for_timeout(300)
        sts = flat(pg.locator('[data-testid="storage-status"]').inner_text())
        check(f'[{label}] 설정: 서버 저장소(미리보기 · 서버 없음)', sts == '미리보기 · 서버 없음', sts)
        inc = re.sub(r'\s+', ' ', pg.locator('[data-testid="incident-status"]').inner_text())
        check(f'[{label}] 설정: 돌발정보 상태(미리보기 · 예시)', inc == '미리보기 · 예시', inc)
        wxs = re.sub(r'\s+', ' ', pg.locator('[data-testid="weather-status"]').inner_text())
        check(f'[{label}] 설정: 날씨(기상청) 상태(미리보기 · 예시)', wxs == '미리보기 · 예시', wxs)
        ais = re.sub(r'\s+', ' ', pg.locator('[data-testid="explain-status"]').inner_text())
        check(f'[{label}] 설정: AI 설명(Gemini) 상태(미리보기 · 예시)', ais == '미리보기 · 예시', ais)
        ov = pg.evaluate('document.documentElement.scrollWidth - document.documentElement.clientWidth')
        check(f'[{label}] 설정 가로 넘침 없음', ov <= 0, str(ov))
        pg.screenshot(path=OUT + f'preview_{label}_settings.png')
        # ── '도착했어요!' · K•CARD+ 캡처(미리보기: 서버 대신 이 기기에서 같은 계산) ──
        def jump(m):
            pg.select_option('select[aria-label="미리보기 시각 이동"]', str(m)); pg.wait_for_timeout(450)
            for _ in range(2):
                x = pg.get_by_role('button', name='알림 닫기')
                if x.count(): x.first.click(); pg.wait_for_timeout(120)
        pg.evaluate("location.hash = '#home'"); pg.wait_for_timeout(300)
        pg.get_by_role('button', name='처음부터').click(); pg.wait_for_timeout(300)
        check(f'[{label}] 도착: 08:05에는 버튼 없음(수업 시작 30분 전부터)', pg.get_by_test_id('arrive-button').count() == 0)
        jump(8 * 60 + 57)
        third = pg.locator('section[aria-label="강의실 도착 예정"]')
        check(f'[{label}] 도착: 08:57 ③ 카드에 [도착했어요!] · 상태(지각 위험)는 아랫줄', third.get_by_test_id('arrive-button').count() == 1 and third.locator('b[data-tone]').inner_text() == '지각 위험', flat(third.inner_text()))
        if label == 'iphone13':
            bar = pg.locator('div.border-b.border-dashed.bg-surface').first.bounding_box(); tb = pg.locator('nav.fixed').bounding_box(); bb = third.bounding_box()
            check(f'[{label}] 도착: 버튼이 있어도 3요소가 첫 화면(미리보기 띠 제외)', bb['y'] + bb['height'] - bar['height'] <= tb['y'], f"bottom={bb['y'] + bb['height'] - bar['height']:.0f} tab={tb['y']:.0f}")
        reqs = []
        pg.on('request', lambda r: reqs.append(r.url) if r.url.startswith('http') else None)
        pg.get_by_test_id('arrive-button').click(); pg.wait_for_timeout(400)
        empty = pg.get_by_test_id('kcard-empty')
        fb = flat(pg.get_by_test_id('arrival-feedback').inner_text()) if pg.get_by_test_id('arrival-feedback').count() else ''
        check(f'[{label}] 도착: 이미지 없음 → 안내(설정에서 K•CARD+ 캡처를 등록하면 도착 시 바로 띄워 드려요) + 등록 바로가기', empty.count() == 1 and '설정에서 K•CARD+ 캡처를 등록하면 도착 시 바로 띄워 드려요' in flat(empty.inner_text())
              and empty.get_by_role('button', name='설정에서 등록하기').count() == 1, flat(empty.inner_text())[:160])
        check(f'[{label}] 도착: 피드백 — 기록 완료 · 08:57 수업 3분 전 · 다음부터 1분 일찍 · 내 걸음 반영 +1분', '도착 기록 완료!' in fb and '08:57 도착 · 수업 3분 전' in fb
              and '다음부터 평소보다 1분 일찍 도착하도록 안내할게요' in fb and '내 걸음 반영 +1분' in fb, fb)
        pg.get_by_role('button', name='설정에서 등록하기').click(); pg.wait_for_timeout(500)
        ks = pg.get_by_test_id('kcard-settings')
        check(f'[{label}] 등록 바로가기 → 설정 · K•CARD+ 칸 강조', pg.evaluate('location.hash') == '#settings' and 'border-primary' in (ks.get_attribute('class') or ''))
        pg.get_by_test_id('kcard-file').set_input_files(files=[{'name': 'kcard.png', 'mimeType': 'image/png', 'buffer': CAPTURE}]); pg.wait_for_timeout(900)
        stx = flat(pg.get_by_test_id('kcard-status').inner_text())
        check(f'[{label}] 설정: 캡처 이미지 등록 → 미리보기 · 등록됨 · 바꾸기/삭제', stx.startswith('등록됨 · ') and ks.locator('img').count() == 1 and ks.get_by_text('바꾸기').count() == 1 and ks.get_by_role('button', name='삭제').count() == 1, stx)
        check(f'[{label}] 설정: 이미지는 이 기기에만(등록 · 도착 기록 중 네트워크 요청 없음)', not reqs and '서버로 보내지 않아요' in flat(ks.inner_text()), str(reqs)[:200])
        per = flat(pg.get_by_test_id('personal-status').inner_text())
        check(f'[{label}] 설정: 내 걸음 반영 +1분 · 도착 기록 1번 · 최근 기록', '+1분' in per and '도착 기록 1번' in per and '08:57 도착' in per and '수업 3분 전' in per, per)
        pg.evaluate("location.hash = '#home'"); pg.wait_for_timeout(400)
        card = pg.get_by_test_id('arrived-card')
        check(f'[{label}] 도착 뒤 홈: 도착 기록 카드 · K•CARD+ 다시 보기 · 버튼은 한 번만', card.count() == 1 and 'K•CARD+ 다시 보기' in card.inner_text() and pg.get_by_test_id('arrive-button').count() == 0
              and '내 걸음 반영 +1분' in flat(card.inner_text()), flat(card.inner_text()))
        card.get_by_test_id('kcard-open').click(); pg.wait_for_timeout(400)
        viewer = pg.get_by_test_id('kcard-viewer')
        nat = pg.evaluate("() => { const i = document.querySelector('[data-testid=\"kcard-viewer\"] img'); return i ? i.naturalWidth : 0; }")
        check(f'[{label}] K•CARD+ 다시 보기: 전체 화면 이미지(1170px) · 피드백 없이', viewer.count() == 1 and nat == 1170 and pg.get_by_test_id('arrival-feedback').count() == 0, str(nat))
        if label == 'iphone13': pg.screenshot(path=OUT + f'preview_{label}_kcard_viewer.png')
        pg.keyboard.press('Escape'); pg.wait_for_timeout(250)
        check(f'[{label}] Esc로 닫힘', pg.get_by_test_id('kcard-viewer').count() == 0)
        # 다음 날(처음부터): ③ 카드에 내 걸음 +1분 → 강의실 도착 예정 08:54 → 08:55
        pg.get_by_role('button', name='처음부터').click(); pg.wait_for_timeout(400)
        third = pg.locator('section[aria-label="강의실 도착 예정"]'); ttx = flat(third.inner_text())
        check(f'[{label}] 다음 날: ③ 카드 \'내 걸음 +1분\' · 도착 예정 08:55(원래 08:54)', pg.get_by_test_id('personal-hint').count() == 1 and '내 걸음 +1분' in ttx and '08:55 강의실 도착 예정' in ttx, ttx)
        jump(8 * 60 + 57)
        pg.get_by_test_id('arrive-button').click(); pg.wait_for_timeout(500)
        fb = flat(pg.get_by_test_id('arrival-feedback').inner_text())
        check(f'[{label}] 이미지 있으면 누르자마자 전체 화면 + 피드백(+1 → +2분)', pg.get_by_test_id('kcard-viewer').count() == 1 and '다음부터 평소보다 1분 일찍' in fb and '내 걸음 반영 +2분' in fb, fb)
        pg.get_by_test_id('kcard-viewer').get_by_role('button', name='닫기').last.click(); pg.wait_for_timeout(300)
        card = pg.get_by_test_id('arrived-card')
        card.get_by_role('button', name='잘못 눌렀어요').click(); card.get_by_role('button', name='기록 취소하기').click(); pg.wait_for_timeout(300)
        check(f'[{label}] 잘못 눌렀어요 → 기록 취소: 보정 +1분으로 · 버튼 다시', pg.get_by_test_id('arrived-card').count() == 0 and pg.get_by_test_id('arrive-button').count() == 1
              and '내 걸음 +1분' in flat(pg.locator('section[aria-label="강의실 도착 예정"]').inner_text()))
        jump(9 * 60 + 5)
        msg = flat(pg.locator('main').inner_text())
        check(f'[{label}] 09:05(시작 뒤 15분 안): 큰 [도착했어요!]', pg.get_by_test_id('arrive-button').count() == 1 and '09:15(시작 15분 뒤)까지 기록할 수 있어요' in msg, msg[:160])
        jump(9 * 60 + 30)
        msg = flat(pg.locator('main').inner_text())
        check(f'[{label}] 09:30(기록 없이 수업 중): 버튼 없음 · K•CARD+ 보기', pg.get_by_test_id('arrive-button').count() == 0 and 'K•CARD+ 보기' in msg and '도착 기록 시간(시작 15분 뒤까지)이 지났어요' in msg, msg[:160])
        # 설정: 처음부터 다시 배우기 · 이미지 삭제
        pg.evaluate("location.hash = '#settings'"); pg.wait_for_timeout(300)
        per = pg.get_by_test_id('personal-status')
        per.get_by_role('button', name='처음부터 다시 배우기').click(); per.get_by_role('button', name='보정 0으로 · 기록 지우기').click(); pg.wait_for_timeout(300)
        check(f'[{label}] 처음부터 다시 배우기 → 0분 · 기록 없음', '0분' in per.inner_text() and '아직 도착 기록이 없어요' in per.inner_text(), flat(per.inner_text()))
        ks = pg.get_by_test_id('kcard-settings')
        ks.get_by_role('button', name='삭제').click(); ks.get_by_role('button', name='이 기기에서 지우기').click(); pg.wait_for_timeout(400)
        check(f'[{label}] 이미지 삭제 → 아직 등록하지 않았어요', flat(pg.get_by_test_id('kcard-status').inner_text()) == '아직 등록하지 않았어요' and ks.locator('img').count() == 0)
        ov = pg.evaluate('document.documentElement.scrollWidth - document.documentElement.clientWidth')
        check(f'[{label}] 도착 · K•CARD+ 화면 가로 넘침 없음', ov <= 0, str(ov))
        # ── v2.0 · v2.1 출발지 환승 경로(미리보기: ODsay · 서울시 실시간 지하철 형식의 예시 응답 · 실제 경로 아님) ──
        pg.evaluate("location.hash = '#home'"); pg.wait_for_timeout(300)
        pg.get_by_role('button', name='처음부터').click(); pg.wait_for_timeout(300)
        pg.evaluate("location.hash = '#settings'"); pg.wait_for_timeout(300)
        ts = pg.get_by_test_id('transit-settings'); adv = pg.get_by_test_id('advanced')
        check(f'[{label}] v2.1 설정: 출발 방식 고르기 없음 · 맨 위 출발지(GPS · 역 이름) · 정류장은 고급(직행 중이라 펼침)', ts.get_attribute('data-mode') == 'direct' and ts.get_by_role('radio').count() == 0
              and pg.get_by_test_id('transit-gps').count() == 1 and pg.locator('[data-testid="transit-origin"] input[type="search"]').count() == 1
              and adv.get_attribute('data-open') == 'true' and '고려대사범대학부속고등학교' in flat(pg.get_by_test_id('stop-row').inner_text()))
        # 처음 화면: 출발지만 물음
        pg.evaluate("location.hash = '#home'"); pg.wait_for_timeout(300)
        pg.get_by_test_id('preview-fresh').click(); pg.wait_for_timeout(400)
        onb = pg.get_by_test_id('onboarding')
        check(f'[{label}] v2.1 처음 화면: 어디서 출발하세요? · GPS · 역 이름 · 정류장 직접 고르기 링크', onb.count() == 1 and '어디서 출발하세요?' in onb.inner_text() and onb.get_by_test_id('transit-gps').count() == 1
              and onb.locator('input[type="search"]').count() == 1 and onb.get_by_test_id('pick-stop-link').count() == 1 and pg.locator('button[aria-label^="탑승 정류장"]').count() == 0)
        sel = onb.locator('select[aria-label="미리보기 검색 결과"]')
        sel.select_option('none'); onb.get_by_test_id('transit-gps').click(); pg.wait_for_timeout(400)
        fbk = pg.get_by_test_id('transit-fallback'); ftx = flat(fbk.inner_text()) if fbk.count() else ''
        check(f'[{label}] 한도 초과 · 근처 없음: 내일부터 · 직행 약속 없음 · 400m 안 정류장 없음 · 큰 환승역으로 찾기', fbk.get_attribute('data-reason') == 'cap' and '내일부터 찾을 수 있어요' in ftx and '직행' not in ftx and '25/25회' in ftx
              and pg.get_by_test_id('nearby-none').count() == 1 and pg.get_by_test_id('bigstation-tip').count() == 1 and pg.get_by_test_id('onboarding').count() == 1, ftx[:140])
        sel.select_option('stale'); onb.get_by_test_id('transit-gps').click(); pg.wait_for_timeout(400)
        resl = pg.get_by_test_id('transit-results')
        check(f'[{label}] 한도 초과 · 예전 경로: 41일 전에 찾은 경로 표시 · 실시간 다시 계산 안내 · 경로 3개', resl.get_attribute('data-stale') == 'true' and flat(pg.get_by_test_id('stale-tag').inner_text()) == '41일 전에 찾은 경로'
              and '41일 전에 찾아 둔 경로를 보여 드려요' in flat(pg.get_by_test_id('stale-notice').inner_text()) and pg.get_by_test_id('route-option').count() == 3)
        sel.select_option('nearby'); onb.get_by_test_id('transit-gps').click(); pg.wait_for_timeout(700)
        check(f'[{label}] 한도 초과 · 근처 국민대행 정류장 → 자동으로 직행 안내(홈 = 정류장 칩 · 실시간 버스) + 경로 다시 찾기', pg.get_by_test_id('onboarding').count() == 0
              and pg.locator('button[aria-label^="탑승 정류장 고려대사범대학부속고등학교"]').count() == 1 and pg.get_by_test_id('retry-notice').count() == 1
              and pg.locator('section[aria-label="실시간 버스 도착"]').count() == 1)
        if label == 'iphone13': pg.screenshot(path=OUT + f'preview_{label}_retry_home.png')
        pg.get_by_test_id('retry-search').click(); pg.wait_for_timeout(700)
        ts = pg.get_by_test_id('transit-settings')
        check(f'[{label}] [경로 다시 찾기] → 설정 · 출발지 칸 강조 · 기억해 둔 출발지로 바로 다시 찾음', pg.evaluate('location.hash') == '#settings' and 'border-primary' in (ts.get_attribute('class') or '')
              and pg.get_by_test_id('route-option').count() == 3 and pg.get_by_test_id('transit-fallback-note').count() == 1)
        oi = pg.locator('[data-testid="transit-origin"] input[type="search"]'); oi.fill('청덕'); pg.wait_for_timeout(250)
        pg.get_by_role('button', name=re.compile('청덕초등학교입구')).first.click(); pg.wait_for_timeout(400)
        fbk = pg.get_by_test_id('transit-fallback')
        check(f'[{label}] 국민대 700m 안 출발지 → 걸어가는 편이 빨라요(근처 정류장 안내 없음)', fbk.get_attribute('data-reason') == 'near' and '걸어가는 편이 빨라요' in flat(fbk.inner_text()) and pg.get_by_test_id('nearby-stops').count() == 0, flat(fbk.inner_text())[:120] if fbk.count() else '')
        oi.fill('')
        pg.get_by_test_id('transit-gps').click(); pg.wait_for_timeout(500)
        opts = pg.get_by_test_id('route-option')
        hdr = flat(pg.get_by_test_id('transit-results').locator('p').first.inner_text()) if opts.count() else ''
        check(f'[{label}] GPS(예시 위치) → 추천 경로 3개 · 최적 배지 · 예시 데이터 · 실시간 아님', opts.count() == 3 and flat(opts.first.inner_text()).startswith('최적') and '예시 데이터 · 실시간 아님' in hdr and 'ODsay 추천 경로 3개' in hdr, hdr)
        segs = opts.first.locator('[data-testid="mode-bar"] [data-kind]').evaluate_all('els => els.map(e => [e.dataset.kind, getComputedStyle(e).backgroundColor])')
        kinds = [k for k, _ in segs]; colors = {k: c for k, c in segs if k != 'walk'}
        check(f'[{label}] 막대: 회색 도보(아이콘+분) · 하늘색 지하철 · 초록 지선 버스', kinds == ['walk', 'subway', 'walk', 'subway', 'walk', 'bus', 'walk'] and colors.get('subway') == 'rgb(65, 173, 230)' and colors.get('bus') == 'rgb(62, 155, 79)', str(segs))
        blue = opts.nth(1).locator('[data-testid="mode-bar"] [data-kind="bus"]').first.evaluate('e => getComputedStyle(e).backgroundColor')
        check(f'[{label}] 둘째 경로: 파란색 간선(272)', blue == 'rgb(47, 100, 214)' and '272' in opts.nth(1).inner_text(), blue)
        rows = opts.first.locator('ol > li').evaluate_all('els => els.map(e => e.dataset.kind)')
        c0 = flat(opts.first.inner_text())
        check(f'[{label}] 타임라인: 2호선(홍대입구역 · 시청 방면) → 4호선 → 지선 1213(길음역) → 하차 국민대학교앞 · 환승 여유 3분', rows == ['subway', 'subway', 'bus', 'end'] and '홍대입구역' in c0 and '시청 방면' in c0
              and '길음역' in c0 and '1213' in c0 and '국민대학교앞' in c0 and '여유 3분' in c0 and '이 경로로 안내 설정' in c0, c0[:220])
        bar_over = opts.first.locator('[data-testid="mode-bar"]').evaluate('el => el.scrollWidth - el.clientWidth')
        ov = pg.evaluate('document.documentElement.scrollWidth - document.documentElement.clientWidth')
        check(f'[{label}] 경로 목록: 가로 넘침 없음(막대 한 줄)', ov <= 0 and bar_over <= 1, f'{ov} {bar_over}')
        if label == 'iphone13': opts.first.screenshot(path=OUT + f'preview_{label}_route_option.png')
        opts.first.get_by_test_id('route-choose').click(); pg.wait_for_timeout(400)
        saved = pg.get_by_test_id('transit-saved')
        check(f'[{label}] [이 경로로 안내 설정] → 저장한 경로 · 내 경로 카드', saved.count() == 1 and '2호선 → 4호선 → 1213' in flat(saved.inner_text()) and pg.get_by_test_id('transit-saved-card').count() == 1)
        stx2 = flat(pg.get_by_test_id('odsay-status').inner_text()); sbx = flat(pg.get_by_test_id('subway-status').inner_text())
        check(f'[{label}] 설정: 환승 경로(ODsay) · 실시간 지하철 상태(미리보기 · 예시)', stx2 == '미리보기 · 예시' and sbx == '미리보기 · 예시', f'{stx2} / {sbx}')
        pg.evaluate("location.hash = '#home'"); pg.wait_for_timeout(300)
        check(f'[{label}] 경로를 고르면 경로 다시 찾기 줄은 사라짐', pg.get_by_test_id('retry-notice').count() == 0)
        jump(7 * 60 + 30)
        dep = pg.locator('section[aria-label="출발 추천"]')
        txt = flat(pg.locator('main').inner_text())
        check(f'[{label}] 환승 홈 07:30: 출발지 칩 · ① 출발(2호선 배지) · ③ 강의실 도착 · ② 내 경로 카드 · 예시 표시', pg.get_by_test_id('origin-chip').count() == 1 and dep.get_attribute('data-mode') == 'transit'
              and flat(pg.get_by_test_id('first-badge').inner_text()) == '2호선' and pg.locator('section[aria-label="강의실 도착 예정"]').count() == 1
              and '내 경로' in pg.get_by_test_id('transit-route').inner_text() and '예시 데이터 · 실시간 아님' in flat(pg.get_by_test_id('data-line').inner_text()), txt[:200])
        order = pg.evaluate("() => [...document.querySelectorAll('main section[aria-label]')].map(s => s.getAttribute('aria-label'))")
        check(f'[{label}] 환승 홈 순서: 출발 추천 → 왜 늦나요?(마지막 버스) → 강의실 도착 → 환승 경로 · 직행 버스 카드 없음', order[:4] == ['출발 추천', '왜 늦나요?', '강의실 도착 예정', '환승 경로 2호선 → 4호선 → 1213'] and '실시간 버스 도착' not in order, str(order))
        why = pg.get_by_test_id('why-strip'); wtx = flat(why.inner_text()) if why.count() else ''
        check(f'[{label}] v2.1 환승 왜 늦나요?: 마지막 버스 1213번 · 노란 줄 · AI + 예시 · +N분 · 근거', why.count() == 1 and flat(pg.get_by_test_id('why-who').inner_text()) == '마지막 버스 1213번' and why.get_attribute('data-tone') == 'caution'
              and why.get_attribute('data-why') == 'ai' and re.search(r'\+\d+분', wtx) is not None and '근거' in wtx, wtx[:160])
        why.get_by_role('button').first.click(); pg.wait_for_timeout(200)
        calc = flat(pg.get_by_test_id('why-fact-calc').inner_text()) if pg.get_by_test_id('why-fact-calc').count() else ''
        check(f'[{label}] 근거 펼침: 1213번 길음역 → 국민대학교앞 구간 · 날씨 · 돌발정보(예시)', '1213번' in calc and '길음역' in calc and pg.get_by_test_id('why-fact-weather').count() == 1 and pg.get_by_test_id('why-fact-incidents').count() == 1, calc[:120])
        why.get_by_role('button').first.click(); pg.wait_for_timeout(200)
        if label == 'iphone13':
            bar = pg.locator('div.border-b.border-dashed.bg-surface').first.bounding_box(); tb = pg.locator('nav.fixed').bounding_box()
            bb = pg.locator('section[aria-label="강의실 도착 예정"]').bounding_box()
            check(f'[{label}] 환승 홈: 출발 · 왜 늦나요 · 도착 카드가 첫 화면(미리보기 띠 제외)', bb['y'] + bb['height'] - bar['height'] <= tb['y'], f"bottom={bb['y'] + bb['height'] - bar['height']:.0f} tab={tb['y']:.0f}")
            pg.screenshot(path=OUT + f'preview_{label}_transit_home.png')
        row = flat(pg.get_by_test_id('transit-route').locator('li[data-kind="subway"]').first.inner_text())
        check(f'[{label}] 07:30(출발 30분 전 안): 2호선은 예시 실시간 열차로 · 탑승 시각', '탑승' in row and ('예시' in row or '배차 간격 예상' in row), row)
        check(f'[{label}] 첫 지하철 간격이 평소와 같으면 지하철 줄 없음', pg.get_by_test_id('gap-strip').count() == 0)
        pg.get_by_role('button', name='+지하철 간격', exact=True).click(); pg.wait_for_timeout(500)
        gtx = flat(pg.get_by_test_id('gap-strip').inner_text()) if pg.get_by_test_id('gap-strip').count() else ''
        check(f'[{label}] v2.1 첫 지하철 간격(예시): 기본 안내 · 홍대입구역 2호선 열차 간격이 평소보다 길어요 · +4분 · 예시', '첫 지하철 2호선' in gtx and '기본 안내' in gtx and '홍대입구역 2호선 열차 간격이 평소보다 길어요.' in gtx
              and flat(pg.get_by_test_id('gap-plus').inner_text()) == '+4분' and '예시 데이터 · 실시간 아님' in gtx, gtx[:160])
        if label == 'iphone13': pg.screenshot(path=OUT + f'preview_{label}_transit_gap.png')
        pg.get_by_role('button', name='AI 문장', exact=True).click(); pg.wait_for_timeout(300)
        jump(7 * 60 + 5)
        row = flat(pg.get_by_test_id('transit-route').locator('li[data-kind="subway"]').first.inner_text())
        check(f'[{label}] 07:05(실시간 전): 2호선은 배차간격으로 예상', ' 예상 ' in f' {row} ' and '예시' not in row and '배차 간격' not in row, row)
        pg.select_option('select[aria-label="미리보기 시각 이동"]', str(7 * 60 + 40)); pg.wait_for_timeout(700)  # 알림을 닫지 않고 읽기
        toast = pg.get_by_role('alert')
        ttx = flat(toast.first.inner_text()) if toast.count() else ''
        check(f'[{label}] 환승 출발 알림: 첫 탑승(2호선 ··· 탑승) · 강의실 도착 예정', '출발' in ttx and '2호선' in ttx and '탑승' in ttx and '강의실' in ttx, ttx[:160])
        for _ in range(2):
            x = pg.get_by_role('button', name='알림 닫기')
            if x.count(): x.first.click(); pg.wait_for_timeout(120)
        pg.get_by_test_id('origin-chip').click(); pg.wait_for_timeout(500)
        check(f'[{label}] 출발지 칩 [바꾸기] → 설정 · 출발지 찾기 열림', pg.evaluate('location.hash') == '#settings' and pg.get_by_test_id('transit-origin').count() == 1)
        adv = pg.get_by_test_id('advanced')
        if adv.get_attribute('data-open') != 'true': pg.get_by_test_id('advanced-open').click(); pg.wait_for_timeout(200)
        pg.get_by_test_id('direct-switch').get_by_role('switch').click(); pg.wait_for_timeout(300)
        check(f'[{label}] 고급 · 정류장 직행 켜기 → 출발지 칸에 직행 중 안내', pg.get_by_test_id('transit-direct-note').count() == 1)
        pg.evaluate("location.hash = '#home'"); pg.wait_for_timeout(400)
        check(f'[{label}] 직행으로 바꾸면 직행 홈(탑승 정류장 · 실시간 버스 카드)', pg.get_by_test_id('origin-chip').count() == 0 and pg.locator('section[aria-label="실시간 버스 도착"]').count() == 1
              and pg.locator('section[aria-label="출발 추천"]').get_attribute('data-mode') is None)
        pg.evaluate("location.hash = '#settings'"); pg.wait_for_timeout(300)
        pg.get_by_test_id('direct-switch').get_by_role('switch').click(); pg.wait_for_timeout(300)
        pg.evaluate("location.hash = '#home'"); pg.wait_for_timeout(400)
        check(f'[{label}] 스위치를 끄면 다시 환승 경로 홈', pg.get_by_test_id('origin-chip').count() == 1)
        ov = pg.evaluate('document.documentElement.scrollWidth - document.documentElement.clientWidth')
        check(f'[{label}] 환승 화면 가로 넘침 없음', ov <= 0, str(ov))
        # ── v2.6.0 환승 지하철(미리보기 예시 · 실시간 아님): 07:40 [출발했어요!] → 08:05(2호선을 탄 뒤 · 4호선 예정 탑승 08:16의 15분 안) ──
        jump(7 * 60 + 40)
        pg.get_by_test_id('depart-button').click(); pg.get_by_test_id('depart-next').wait_for(timeout=5000); pg.wait_for_timeout(400)
        subs = pg.get_by_test_id('transit-route').locator('li[data-kind="subway"]')
        r4 = flat(subs.nth(1).inner_text())
        check(f'[{label}] v2.6.0 07:40 [출발했어요!] 직후: 4호선은 아직 예상(환승 지하철 예시 열차는 탑승 15분 전부터)', ' 예상 ' in f' {r4} ' and '예시' not in r4 and '다음' not in r4, r4)
        jump(8 * 60 + 5)
        r2 = flat(subs.nth(0).inner_text()); r4 = flat(subs.nth(1).inner_text())
        check(f'[{label}] v2.6.0 08:05: 2호선 타는 중(예상) · 4호선(동대문역사문화공원) 예시 열차로 탑승 시각 · 다음', '타는 중(예상)' in r2 and '동대문역사문화공원' in r4 and re.search(r'\d\d:\d\d 탑승 예시', r4) is not None and '다음' in r4, f'{r2} / {r4}')
        nx = flat(pg.get_by_test_id('depart-next').inner_text())
        check(f'[{label}] v2.6.0 08:05 이동 중 카드: 다음 탈 것 4호선 · 동대문역사문화공원역 · 예시(실시간 아님)', '4호선' in nx and '동대문역사문화공원' in nx and pg.get_by_test_id('depart-next-src').get_attribute('data-src') == 'live'
              and '예시' in flat(pg.get_by_test_id('depart-next-src').inner_text()) and '실시간' not in flat(pg.get_by_test_id('depart-next-src').inner_text()), nx)
        dl = flat(pg.get_by_test_id('data-line').inner_text())
        check(f'[{label}] v2.6.0 08:05 출처 줄: 예시 데이터 · 실시간 아님 · 이미 탄 첫 지하철 글 없음', '예시 데이터 · 실시간 아님' in dl and '첫 지하철' not in dl and '출발 30분 전부터' not in dl, dl)
        ov = pg.evaluate('document.documentElement.scrollWidth - document.documentElement.clientWidth')
        check(f'[{label}] v2.6.0 08:05 가로 넘침 없음', ov <= 0, str(ov))
        if label == 'iphone13': pg.get_by_test_id('transit-route').screenshot(path=OUT + f'preview_{label}_transfer_subway.png')
        pg.get_by_test_id('depart-undo').click(); pg.get_by_test_id('depart-undo-yes').click(); pg.wait_for_timeout(400)
        check(f'[{label}] v2.6.0 [잘못 눌렀어요] → 출발 기록 지움(이동 중 카드 없음)', pg.get_by_test_id('depart-next').count() == 0)
        # ── v2.7.0 환승 버스(미리보기 예시 · 실시간 아님): 미리보기 띠 '환승 버스 예시' → 2호선 → 150 → 1213 · 07:40 [출발했어요!] → 08:05(150 예정 탑승 08:14의 15분 안) ──
        pg.evaluate("location.hash = '#home'"); pg.wait_for_timeout(200)
        pg.get_by_test_id('preview-midbus').click(); pg.wait_for_timeout(500)
        jump(7 * 60 + 40)
        rc = pg.get_by_test_id('transit-route')
        rb = flat(rc.locator('li[data-kind="bus"]').nth(0).inner_text())
        kinds = rc.locator('ol > li').evaluate_all('els => els.map(e => e.dataset.kind)')
        check(f"[{label}] v2.7.0 '환승 버스 예시' → 2호선 → 150 → 1213 · 07:40: 150(시청앞.덕수궁)은 예상", kinds[:3] == ['subway', 'bus', 'bus']
              and '시청앞.덕수궁' in rb and '150' in rb and ' 예상 ' in f' {rb} ' and '예시' not in rb, f'{kinds} / {rb}')
        pg.get_by_test_id('depart-button').click(); pg.get_by_test_id('depart-next').wait_for(timeout=5000); pg.wait_for_timeout(400)
        jump(8 * 60 + 5)
        rb = flat(rc.locator('li[data-kind="bus"]').nth(0).inner_text()); r2 = flat(rc.locator('li[data-kind="subway"]').nth(0).inner_text())
        check(f'[{label}] v2.7.0 08:05: 2호선 지남 · 150(시청앞.덕수궁) 예시 버스로 탑승 시각 · 다음', '지남' in r2 and '시청앞.덕수궁' in rb and re.search(r'\d\d:\d\d 탑승 예시', rb) is not None and '다음' in rb, f'{r2} / {rb}')
        nx = flat(pg.get_by_test_id('depart-next').inner_text()); src = flat(pg.get_by_test_id('depart-next-src').inner_text())
        check(f'[{label}] v2.7.0 08:05 이동 중 카드: 다음 탈 것 150번 버스 · 시청앞.덕수궁 · 예시(실시간 아님)', '150' in nx and '시청앞.덕수궁' in nx
              and pg.get_by_test_id('depart-next-src').get_attribute('data-src') == 'live' and '예시' in src and '실시간' not in src, nx)
        dl = flat(pg.get_by_test_id('data-line').inner_text())
        check(f'[{label}] v2.7.0 08:05 출처 줄: 예시 데이터 · 실시간 아님 · 환승 버스 글 없음(예시)', '예시 데이터 · 실시간 아님' in dl and '환승 버스' not in dl and '첫 지하철' not in dl, dl)
        ov = pg.evaluate('document.documentElement.scrollWidth - document.documentElement.clientWidth')
        check(f'[{label}] v2.7.0 08:05 가로 넘침 없음', ov <= 0, str(ov))
        if label == 'iphone13': rc.screenshot(path=OUT + f'preview_{label}_transfer_bus.png')
        pg.evaluate("location.hash = '#settings'"); pg.get_by_text('데이터 · 서버 연결').wait_for(timeout=5000)
        srow = flat(pg.get_by_text('실시간 데이터', exact=True).first.locator('xpath=../..').inner_text())
        check(f"[{label}] v2.7.0 설정 '실시간 데이터': 출발했어요! 뒤 환승 지하철 · 버스 15분 전부터 · 서울시 정류장 환승 버스 하루 100회", '(서울시 정류장 환승 버스는 하루 100회까지)' in srow, srow[:200])
        pg.evaluate("location.hash = '#home'"); pg.wait_for_timeout(300)
        pg.get_by_test_id('depart-undo').click(); pg.get_by_test_id('depart-undo-yes').click(); pg.wait_for_timeout(400)
        check(f'[{label}] v2.7.0 [잘못 눌렀어요] → 출발 기록 지움', pg.get_by_test_id('depart-next').count() == 0)
        # ── v2.2.5 설정 › 내 데이터 · 내 데이터 모두 삭제(미리보기: 서버 없이 이 화면의 예시 값만 지움) ──
        pg.evaluate("location.hash = '#settings'"); pg.wait_for_timeout(300)
        md = pg.get_by_test_id('mydata'); md.scroll_into_view_if_needed()
        mtx = flat(md.inner_text())
        check(f'[{label}] v2.2.5 설정 › 내 데이터: 저장하는 것 · 보관 90일 · K•CARD+ 이 기기만 · 문의(GitHub Issues · 이메일) · 모두 삭제',
              '서버에 저장하는 것' in mtx and '90일' in mtx and '이 기기만' in mtx and md.get_by_test_id('contact-issues').get_attribute('href') == 'https://github.com/405woon-bot/ku-bus-ai/issues'
              and md.get_by_test_id('contact-mail').get_attribute('href') == 'mailto:405woon@gmail.com' and md.get_by_test_id('delete-all').count() == 1, mtx[:160])
        md.screenshot(path=OUT + f'preview_{label}_mydata.png')
        md.get_by_test_id('delete-all').click(); pg.wait_for_timeout(300)
        dlg = pg.get_by_test_id('delete-dialog'); dtx = flat(dlg.inner_text())
        check(f"[{label}] 확인 창(미리보기): '미리보기 · 서버 없음' · 되돌릴 수 없음 · 빈칸이면 [모두 삭제] 꺼짐",
              '미리보기 · 서버 없음' in dtx and '지우면 되돌릴 수 없어요.' in dtx and pg.get_by_test_id('delete-confirm').is_disabled(), dtx[:160])
        pg.get_by_test_id('delete-input').fill('삭제'); pg.get_by_test_id('delete-input').press('Enter'); pg.wait_for_timeout(400)
        check(f"[{label}] '삭제' 입력 뒤 Enter → 지우지 않음(빨간 버튼으로만) · 버튼 켜짐", dlg.count() == 1 and dlg.get_attribute('data-state') == 'ready'
              and not pg.get_by_test_id('delete-confirm').is_disabled() and pg.get_by_test_id('deleted-note').count() == 0)
        pg.screenshot(path=OUT + f'preview_{label}_delete_dialog.png')
        pg.keyboard.press('Escape'); pg.wait_for_timeout(250)
        check(f'[{label}] Esc → 창만 닫힘(지우지 않음 · 환승 경로 그대로)', dlg.count() == 0 and pg.get_by_test_id('transit-settings').get_attribute('data-mode') == 'transit')
        md.get_by_test_id('delete-all').click(); pg.wait_for_timeout(300)
        pg.get_by_test_id('delete-input').fill(' 삭제 ')
        with pg.expect_navigation(timeout=10000):
            pg.get_by_test_id('delete-confirm').click()
        pg.get_by_test_id('deleted-note').wait_for(timeout=8000)
        pg.locator('section[aria-label="출발 추천"]').wait_for(timeout=8000)
        keys = pg.evaluate("Object.keys(localStorage)")
        check(f'[{label}] 모두 삭제(미리보기) → 처음 상태(정류장 직행 · 출발지 없음) · 완료 안내 · 주소에 표시 없음 · 미리보기 띠 그대로',
              pg.get_by_test_id('origin-chip').count() == 0 and 'deleted' not in pg.url and pg.evaluate('location.hash') == '#home'
              and '내 데이터를 모두 지웠어요' in pg.get_by_test_id('deleted-note').inner_text() and pg.get_by_role('button', name='실시간 연결', exact=True).count() == 1
              and 'kubusai:kcard' not in keys, f'{pg.url} {keys}')
        if label == 'iphone13': pg.screenshot(path=OUT + f'preview_{label}_deleted_home.png')
        # ── v2.2.6 심야 안내(미리보기 시각 · 위의 모두 삭제 뒤 새로 연 화면에서): 한도 초과 · 근처 국민대행 정류장 없음 → 낮은 지금 문구 그대로, 23:40은 '운행이 끝난 시간이라 … 어려울 수 있어요' ──
        NIGHT = '버스 운행이 끝난 시간이라 근처 국민대행 정류장을 확인하기 어려울 수 있어요. 아침에 다시 찾아 주세요.'
        jump(8 * 60 + 5)
        pg.evaluate("location.hash = '#home'"); pg.wait_for_timeout(300)
        pg.get_by_test_id('preview-fresh').click(); pg.wait_for_timeout(400)
        onb = pg.get_by_test_id('onboarding')
        onb.locator('select[aria-label="미리보기 검색 결과"]').select_option('none'); onb.get_by_test_id('transit-gps').click(); pg.wait_for_timeout(400)
        nn = pg.get_by_test_id('nearby-none'); ntx = flat(nn.inner_text()) if nn.count() else ''
        check(f'[{label}] v2.2.6 낮(08:05) 근처 정류장 없음: 문구 그대로 · 심야 표시 없음', ntx == '출발지 400m 안에 국민대로 바로 가는 버스 정류장이 없어요' and nn.get_attribute('data-night') == 'false', ntx)
        jump(23 * 60 + 40)
        pg.get_by_test_id('onboarding').get_by_test_id('transit-gps').click(); pg.wait_for_timeout(400)
        nn = pg.get_by_test_id('nearby-none'); ntx = flat(nn.inner_text()) if nn.count() else ''
        ftx = flat(pg.get_by_test_id('transit-fallback').inner_text()) if pg.get_by_test_id('transit-fallback').count() else ''
        check(f"[{label}] v2.2.6 심야(23:40) 근처 정류장 없음: '운행이 끝난 시간이라 … 어려울 수 있어요' · '없어요'라고 단정하지 않음 · 큰 환승역 안내는 그대로",
              ntx == NIGHT and nn.get_attribute('data-night') == 'true' and '정류장이 없어요' not in ftx and pg.get_by_test_id('bigstation-tip').count() == 1, ntx)
        if label == 'iphone13':
            pg.get_by_test_id('transit-fallback').scroll_into_view_if_needed(); pg.screenshot(path=OUT + f'preview_{label}_night_nearby.png')
        ov = pg.evaluate('document.documentElement.scrollWidth - document.documentElement.clientWidth')
        check(f'[{label}] v2.2.6 심야 안내 가로 넘침 없음', ov <= 0, str(ov))
        check(f'[{label}] 페이지 오류 없음', not errs, str(errs)[:200])
        ctx.close()
    b.close()
print('\n'.join(res)); n = sum(r.startswith('FAIL') for r in res)
print(f'{len(res) - n} passed, {n} failed'); sys.exit(1 if n else 0)
