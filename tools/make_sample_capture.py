"""데모용 '시간표 캡처' 이미지 생성(에브리타임 화면을 흉내 낸 일반 격자 시간표, 로고·상표 없음)."""
from PIL import Image, ImageDraw, ImageFont
import base64, io, sys
F = '/usr/share/fonts/opentype/noto/NotoSansCJK-Bold.ttc'; FR = '/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc'
W, TOP, LEFT, HOUR, HOURS = 750, 40, 40, 78, 9
H = TOP + HOUR * HOURS + 1
colW = (W - LEFT - 1) / 5
im = Image.new('RGB', (W, H), 'white'); d = ImageDraw.Draw(im)
fd, ft, fb, fs = ImageFont.truetype(FR, 16), ImageFont.truetype(FR, 14), ImageFont.truetype(F, 17), ImageFont.truetype(FR, 13)
LINE = (235, 235, 235)
for i, day in enumerate('월화수목금'):
    cx = LEFT + colW * (i + 0.5); d.text((cx, TOP / 2), day, font=fd, fill=(140, 140, 140), anchor='mm')
for h in range(HOURS + 1): d.line([(0, TOP + h * HOUR), (W, TOP + h * HOUR)], fill=LINE, width=1)
for i in range(6): x = round(LEFT + colW * i); d.line([(x, 0), (x, H)], fill=LINE, width=1)
for h in range(HOURS): d.text((LEFT - 6, TOP + h * HOUR + 4), str(9 + h), font=ft, fill=(150, 150, 150), anchor='ra')
classes = [  # (과목, 요일들, 시작, 끝, 강의실, 색)
  ('마케팅원론', [1, 3], '09:00', '10:15', '경영관 302', (240, 134, 118)),
  ('회계원리', [0, 2], '10:30', '11:45', '경상관 201', (255, 167, 38)),
  ('경영통계', [0], '13:00', '14:15', '국제관 305', (102, 187, 106)),
  ('조직행동론', [2], '13:00', '14:15', '경영관 410', (92, 160, 230)),
  ('비즈니스영어', [4], '10:00', '11:50', '국제관 201', (171, 104, 200)),
  ('재무관리', [3], '15:00', '16:15', '경영관 305', (38, 166, 154)),
]
tm = lambda s: int(s[:2]) * 60 + int(s[3:])
for name, days, s, e, room, col in classes:
    for dd in days:
        x0 = round(LEFT + colW * dd) + 1; x1 = round(LEFT + colW * (dd + 1)) - 1
        y0 = round(TOP + (tm(s) - 540) / 60 * HOUR) + 1; y1 = round(TOP + (tm(e) - 540) / 60 * HOUR) - 1
        d.rectangle([x0, y0, x1, y1], fill=col)
        d.text((x0 + 6, y0 + 5), name, font=fb, fill='white'); d.text((x0 + 6, y0 + 29), room, font=fs, fill=(255, 255, 255))
im = im.quantize(colors=48, method=Image.Quantize.MEDIANCUT).convert('RGB')
buf = io.BytesIO(); im.save(buf, 'PNG', optimize=True)
im.save('tools/sample_capture.png')
open('frontend/src/data/sampleCapture.js', 'w').write("// 데모용 합성 시간표 캡처(가상의 학생). tools/make_sample_capture.py로 생성\nexport default 'data:image/png;base64," + base64.b64encode(buf.getvalue()).decode() + "';\n")
# 3D 미리보기(V4 스크린샷 축소본)
src = Image.open('../KU_Bus_Web/build/shots/campus.jpg').convert('RGB').resize((560, 350), Image.LANCZOS)
b2 = io.BytesIO(); src.save(b2, 'JPEG', quality=72, optimize=True, progressive=True)
open('frontend/src/data/preview3d.js', 'w').write("// KU Bus 3D V4 캠퍼스 전경 스크린샷(축소본)\nexport default 'data:image/jpeg;base64," + base64.b64encode(b2.getvalue()).decode() + "';\n")
print('capture', len(buf.getvalue()), 'preview', len(b2.getvalue()), im.size)
