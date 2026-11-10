"""미리보기 빌드(frontend/dist-preview) — 시간표 탭 '수업 검색으로 추가' 점검(네트워크 차단)
실행: cd frontend && npm run build:preview  →  python test/preview_courses.py"""
import re, sys
from pathlib import Path
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent.parent
URL = (ROOT / 'frontend' / 'dist-preview' / 'index.html').as_uri() + '#timetable'
OUT = ROOT / 'test' / 'screenshots'
res = []
def check(n, c, d=''): res.append(('PASS' if c else 'FAIL') + f' {n} {d}')
flat = lambda s: re.sub(r'\s+', ' ', s).strip()

def row(pg, name, sec):
    return pg.locator('[data-testid="course-row"]').filter(has_text=name).filter(has_text=f'{sec}분반').first

with sync_playwright() as p:
    b = p.chromium.launch()
    for label, args in [('desktop', dict(viewport={'width': 1440, 'height': 1000})), ('iphone13', dict(**p.devices['iPhone 13']))]:
        ctx = b.new_context(**args)
        ctx.route('**/*', lambda r: r.abort() if r.request.url.startswith('http') else r.continue_())
        pg = ctx.new_page(); errs = []
        pg.on('pageerror', lambda e: errs.append(str(e)))
        pg.goto(URL)
        search = pg.locator('section[aria-label="수업 검색"] input[type="search"]'); search.wait_for(timeout=10000)
        check(f'[{label}] 강의 목록 출처: 미리보기 샘플(실제 목록 아님)', '실제 목록 아님' in pg.locator('[data-testid="course-meta"]').inner_text())
        search.fill('회로이론')
        n = pg.locator('[data-testid="course-row"]').count()
        check(f'[{label}] 과목명 검색 결과(분반별)', n == 6, str(n))
        # 겹치는 분반: 목 16:30-18:00 ↔ 예시 시간표 캡스톤디자인(목 15:00-17:50)
        r1 = row(pg, '회로이론II', '01'); r1.click()
        blocks = pg.locator('[data-testid="preview-block"]')
        check(f'[{label}] 누르면 시간표에 점선 미리보기(요일 2칸)', blocks.count() == 2, str(blocks.count()))
        check(f'[{label}] 겹치는 칸은 빨강 + 겹치는 수업 이름', pg.locator('[data-testid="preview-block"][data-conflict="true"]').count() == 1 and '캡스톤디자인' in r1.inner_text(), flat(r1.inner_text()))
        check(f'[{label}] 겹치면 버튼이 "바꿔서 추가"', r1.get_by_role('button', name='바꿔서 추가').count() == 1)
        if label == 'desktop': pg.screenshot(path=str(OUT / 'preview_courses_desktop_select.png'))
        # 바꿔서 추가 → '겹치는 과목을 빼고 추가할까요?' → 취소하면 그대로
        capstone = pg.locator('[data-block]', has_text='캡스톤디자인')
        r1.get_by_role('button', name='바꿔서 추가').click()
        dlg = pg.locator('[data-testid="replace-dialog"]'); dlg.wait_for(timeout=3000)
        check(f'[{label}] 확인 창: 겹치는 과목과 겹치는 칸', pg.get_by_role('dialog').get_by_text('겹치는 과목을 빼고 추가할까요?').count() == 1 and '캡스톤디자인' in dlg.inner_text() and '목 15:00-17:50 겹침' in dlg.inner_text(), flat(dlg.inner_text()))
        if label == 'desktop': pg.screenshot(path=str(OUT / 'preview_courses_desktop_confirm.png'))
        pg.get_by_role('dialog').get_by_role('button', name='취소').click()
        check(f'[{label}] 취소 → 아무것도 안 바뀜', dlg.count() == 0 and capstone.count() == 1 and pg.locator('[data-block]', has_text='회로이론II').count() == 0)
        # 빼고 추가 → 캡스톤디자인이 빠지고 회로이론II 01(월·목)이 들어감, 겹치는 수업 없음
        r1.get_by_role('button', name='바꿔서 추가').click()
        pg.get_by_role('dialog').get_by_role('button', name='빼고 추가').click()
        check(f'[{label}] 빼고 추가 → 먼저 있던 과목이 빠지고 새 강의가 들어감', capstone.count() == 0 and pg.locator('[data-block]', has_text='회로이론II').count() == 2)
        overlap = pg.evaluate('''() => { const out = []; document.querySelectorAll('[aria-label$="요일 칸 — 눌러서 수업 추가"]').forEach((col) => {
            const bs = [...col.querySelectorAll('[data-block]')].map((b) => b.getBoundingClientRect());
            bs.forEach((a, i) => bs.slice(i + 1).forEach((b) => { if (a.top < b.bottom - 3 && b.top < a.bottom - 3) out.push(col.getAttribute('aria-label')); })); }); return out; }''')
        check(f'[{label}] 시간표에 겹치는 칸 없음', not overlap, str(overlap))
        note = pg.locator('[data-testid="replace-notice"]')
        check(f'[{label}] 안내 + 되돌리기', note.count() == 1 and '겹치던 과목(캡스톤디자인)은 뺐어요' in note.inner_text(), flat(note.inner_text()) if note.count() else '')
        if label == 'desktop': pg.screenshot(path=str(OUT / 'preview_courses_desktop_replaced.png'))
        note.get_by_role('button', name='되돌리기').click()
        check(f'[{label}] 되돌리기 → 원래 시간표', capstone.count() == 1 and pg.locator('[data-block]', has_text='회로이론II').count() == 0 and note.count() == 0)
        # 겹치지 않는 분반 추가 → 요일·시간·강의실 그대로
        before = pg.locator('[data-block]').count()
        r4 = row(pg, '회로이론II', '04'); r4.get_by_role('button', name='추가').click()
        added = pg.locator('[data-block]', has_text='회로이론II')
        check(f'[{label}] 추가 → 시간표에 들어감(금 09:00-12:00 · 미래관 337)', added.count() == 1 and pg.locator('[data-block]').count() == before + 1 and '미래관 337' in added.first.inner_text(), flat(added.first.inner_text()) if added.count() else '')
        check(f'[{label}] 추가한 분반은 "추가됨"', '추가됨' in row(pg, '회로이론II', '04').inner_text())
        # 야간(화 18:00-21:00) → 표가 21시까지 넓어짐 · 토요일 수업 → 토 칸
        search.fill('데이터베이스'); row(pg, '데이터베이스', '01').get_by_role('button', name='추가').click()
        check(f'[{label}] 야간 수업이면 표가 21시까지', pg.locator('span.num', has_text=re.compile(r'^20$')).count() >= 1)
        search.fill('현대사회'); row(pg, '현대사회와윤리', '01').get_by_role('button', name='추가').click()
        check(f'[{label}] 토요일 수업이면 토 칸이 생김', pg.get_by_text('토', exact=True).count() >= 1)
        if label == 'desktop': pg.screenshot(path=str(OUT / 'preview_courses_desktop_added.png'), full_page=True)
        # 빼기 → 그 강의의 모든 요일이 빠짐
        row(pg, '현대사회와윤리', '01').get_by_role('button', name='빼기').click()
        check(f'[{label}] 빼기 → 토요일 칸도 사라짐', pg.get_by_text('토', exact=True).count() == 0)
        search.fill('원격'); 
        check(f'[{label}] 시간 미정 강의는 추가 못 함(안내)', row(pg, 'AI와 함께하는 글쓰기', '01').get_by_role('button', name='추가').is_disabled())
        ov = pg.evaluate('document.documentElement.scrollWidth - document.documentElement.clientWidth')
        check(f'[{label}] 가로 넘침 없음', ov <= 0, str(ov))
        if label == 'iphone13':
            search.fill('회로이론'); row(pg, '회로이론II', '01').click()
            pg.screenshot(path=str(OUT / 'preview_courses_iphone13.png'), full_page=True)
        check(f'[{label}] 페이지 오류 없음', not errs, str(errs)[:200])
        ctx.close()
    b.close()
print('\n'.join(res)); n = sum(r.startswith('FAIL') for r in res)
print(f'{len(res) - n} passed, {n} failed'); sys.exit(1 if n else 0)
