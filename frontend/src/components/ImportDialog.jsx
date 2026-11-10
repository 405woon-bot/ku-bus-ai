import { useEffect, useMemo, useRef, useState } from 'react';
import { DAYS } from '@shared/time.js';
import { BUILDINGS } from '@shared/campusData.js';
import { parseTimetableText } from '@shared/parseTimetableText.js';
import { blocksToClasses, detectTimetable, imageToCanvas, loadImage } from '../lib/detectTimetableImage.js';
import { ocrBlocks } from '../lib/ocr.js';
import { COURSE_COLORS } from '../lib/palette.js';
import { SAMPLE_TEXT } from '../data/sampleTimetable.js';
import SAMPLE_CAPTURE from '../data/sampleCapture.js';
import { Button, Chip, IconCheck, IconImage, IconText, IconX, Modal, Segmented, inputCls } from './ui.jsx';

const SORTED = [...BUILDINGS].sort((a, b) => a.name.localeCompare(b.name, 'ko'));
const small = 'h-9 rounded-lg border border-line bg-panel px-2 text-[13px] outline-none focus:border-primary';

/** 같은 과목명 → 같은 색 */
function withColors(items, existing) {
  const map = new Map(existing.map((c) => [c.name, c.color]));
  let next = existing.length;
  return items.map((it) => {
    if (!map.has(it.name)) map.set(it.name, next++ % COURSE_COLORS.length);
    return { ...it, color: map.get(it.name) };
  });
}

function TextImport({ text, setText, parsed }) {
  return (
    <div className="grid gap-3">
      <label className="grid gap-1.5">
        <span className="text-[13px] font-semibold">시간표 텍스트</span>
        <textarea value={text} onChange={(e) => setText(e.target.value)} rows={6} spellCheck={false}
          className="w-full rounded-[10px] border border-line px-3 py-2 font-mono text-[13px] leading-relaxed outline-none focus:border-primary focus:ring-[3px] focus:ring-primary-soft"
          placeholder={SAMPLE_TEXT} />
      </label>
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" onClick={() => setText(SAMPLE_TEXT)}><IconText className="h-4 w-4" />예시 넣기</Button>
        <span className="text-xs text-ink-muted">한 줄에 수업 하나: 과목명 · 요일(월~금) · 시각(09:00-10:15) 또는 교시(3-4교시, 월1,2) · 건물 강의실</span>
      </div>
      {parsed.length > 0 && (
        <div className="overflow-x-auto rounded-xl border border-line">
          <table className="w-full min-w-[520px] text-[13px]">
            <thead className="bg-surface text-left text-xs text-ink-muted"><tr><th className="px-3 py-2 font-semibold">상태</th><th className="px-3 py-2 font-semibold">과목명</th><th className="px-3 py-2 font-semibold">요일</th><th className="px-3 py-2 font-semibold">시간</th><th className="px-3 py-2 font-semibold">건물·강의실</th></tr></thead>
            <tbody className="divide-y divide-line">
              {parsed.map((e, i) => (
                <tr key={i} className={e.ok ? '' : 'bg-danger-soft/50'}>
                  <td className="px-3 py-2">{e.ok ? <Chip level="ok"><IconCheck className="h-3.5 w-3.5" />인식</Chip> : <Chip level="danger"><IconX className="h-3.5 w-3.5" />확인</Chip>}</td>
                  <td className="px-3 py-2 font-semibold">{e.name}</td>
                  {e.ok ? <><td className="px-3 py-2">{DAYS[e.day]}</td><td className="num px-3 py-2 text-[14px]">{e.start}–{e.end}</td><td className="px-3 py-2">{e.building || <span className="text-ink-muted">미지정(도보 5분)</span>} {e.room}</td></>
                    : <td colSpan={3} className="px-3 py-2 text-danger">{e.line}번째 줄: {e.error}</td>}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function ImageImport({ rows, setRows }) {
  const [det, setDet] = useState(null);
  const [startHour, setStartHour] = useState(9);
  const [err, setErr] = useState('');
  const [ocr, setOcr] = useState({ state: 'idle', msg: '' });
  const [drag, setDrag] = useState(false);
  const canvasRef = useRef(null), fileRef = useRef(null);

  async function open(url) {
    setErr(''); setOcr({ state: 'idle', msg: '' });
    try {
      const cv = imageToCanvas(await loadImage(url));
      canvasRef.current = cv;
      const d = detectTimetable(cv);
      setDet({ ...d, url: cv.toDataURL('image/png'), W: cv.width, H: cv.height });
      setRows(blocksToClasses(d.blocks, d.grid, startHour).map((b, i) => ({ ...b, name: `수업 ${i + 1}`, building: '', room: '', include: true })));
      if (!d.blocks.length) setErr('색 블록을 찾지 못했어요. 시간표 부분만 보이게 자른 캡처를 올려 보세요.');
    } catch (e) { setErr(e.message); }
  }
  useEffect(() => {
    if (!det) return;
    setRows((rs) => blocksToClasses(det.blocks, det.grid, startHour).map((b, i) => ({ ...rs[i], ...b })));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [startHour]);
  const readFile = (file) => {
    if (!file || !file.type.startsWith('image/')) { setErr('이미지 파일(PNG, JPG)을 골라 주세요.'); return; }
    const fr = new FileReader(); fr.onload = () => open(fr.result); fr.readAsDataURL(file);
  };
  async function runOcr() {
    setOcr({ state: 'run', msg: 'OCR 엔진을 불러오는 중…' });
    try {
      const res = await ocrBlocks(canvasRef.current, det.blocks, (i, n) => setOcr({ state: 'run', msg: `글자 읽는 중 ${i}/${n}` }));
      setRows((rs) => rs.map((r, i) => ({ ...r, name: res[i]?.name || r.name, building: res[i]?.building || r.building, room: res[i]?.room || r.room })));
      setOcr({ state: 'done', msg: '읽은 글자를 확인하고 틀린 부분을 고쳐 주세요.' });
    } catch (e) { setOcr({ state: 'error', msg: `${e.message}. 과목명을 직접 입력해 주세요.` }); }
  }
  const upd = (i, patch) => setRows((rs) => rs.map((r, k) => (k === i ? { ...r, ...patch } : r)));

  if (!det) {
    return (
      <div className="grid gap-3">
        <div onDragOver={(e) => { e.preventDefault(); setDrag(true); }} onDragLeave={() => setDrag(false)}
          onDrop={(e) => { e.preventDefault(); setDrag(false); readFile(e.dataTransfer.files[0]); }}
          className={`grid place-items-center gap-3 rounded-2xl border-2 border-dashed px-6 py-10 text-center ${drag ? 'border-primary bg-primary-soft' : 'border-line bg-surface'}`}>
          <IconImage className="h-9 w-9 text-ink-muted" />
          <div>
            <p className="font-bold">에브리타임 시간표 캡처를 끌어 놓거나 골라 주세요</p>
            <p className="mt-1 text-xs text-ink-muted">색 블록의 위치로 요일·시간을 읽고, 과목명은 OCR(베타)로 읽거나 직접 입력합니다.</p>
          </div>
          <div className="flex flex-wrap justify-center gap-2">
            <Button variant="primary" onClick={() => fileRef.current?.click()}>이미지 고르기</Button>
            <Button onClick={() => open(SAMPLE_CAPTURE)}>샘플 캡처로 해 보기</Button>
          </div>
          <input ref={fileRef} type="file" accept="image/*" className="sr-only" onChange={(e) => readFile(e.target.files[0])} aria-label="시간표 캡처 이미지 파일" />
        </div>
        {err && <p className="rounded-lg bg-danger-soft px-3 py-2 text-sm text-danger">{err}</p>}
        <p className="text-xs text-ink-muted">이미지는 이 브라우저 안에서만 처리하고 서버로 보내지 않습니다.</p>
      </div>
    );
  }
  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)]">
      <div className="grid content-start gap-2">
        <div className="relative overflow-hidden rounded-xl border border-line">
          <img src={det.url} alt="올린 시간표 캡처" className="block w-full" />
          {rows.map((r, i) => r.box && (
            <div key={i} className={`absolute rounded-md border-2 ${r.include ? 'border-primary' : 'border-ink-muted/50 opacity-60'}`}
              style={{ left: `${(r.box.x / det.W) * 100}%`, top: `${(r.box.y / det.H) * 100}%`, width: `${(r.box.w / det.W) * 100}%`, height: `${(r.box.h / det.H) * 100}%` }}>
              <span className="num absolute -left-px -top-px rounded-br-md bg-primary px-1 text-[11px] font-bold text-white">{i + 1}</span>
            </div>
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-2 text-xs text-ink-muted">
          <label className="flex items-center gap-1.5">첫 가로줄 시각
            <select className={small} value={startHour} onChange={(e) => setStartHour(+e.target.value)}>{[7, 8, 9, 10, 11, 12].map((h) => <option key={h} value={h}>{h}시</option>)}</select>
          </label>
          <span>격자 인식: 가로줄 {det.found.hLines}개 · 세로줄 {det.found.vLines}개</span>
          <Button size="sm" variant="ghost" onClick={() => { setDet(null); setRows([]); }}>다른 이미지</Button>
        </div>
      </div>
      <div className="grid content-start gap-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="text-[13px] font-semibold">찾은 수업 {rows.length}개 — 내용을 확인해 주세요</span>
          <Button size="sm" onClick={runOcr} disabled={ocr.state === 'run'}>OCR로 과목명 읽기 (베타)</Button>
        </div>
        {ocr.msg && <p className={`rounded-lg px-3 py-2 text-xs ${ocr.state === 'error' ? 'bg-warn-soft text-warn' : 'bg-primary-soft text-primary-active'}`}>{ocr.msg}</p>}
        <ul className="grid max-h-[46vh] gap-2 overflow-y-auto pr-1">
          {rows.map((r, i) => (
            <li key={i} className={`grid gap-2 rounded-xl border p-2.5 ${r.include ? 'border-line' : 'border-line bg-surface opacity-70'}`}>
              <div className="flex items-center gap-2">
                <input type="checkbox" checked={r.include} onChange={(e) => upd(i, { include: e.target.checked })} aria-label={`${i + 1}번 수업 포함`} className="h-4 w-4 accent-[#206DEF]" />
                <span className="num w-5 text-center text-sm font-bold text-primary">{i + 1}</span>
                <input className={`${small} min-w-0 flex-1`} value={r.name} onChange={(e) => upd(i, { name: e.target.value })} aria-label={`${i + 1}번 과목명`} />
              </div>
              <div className="flex flex-wrap items-center gap-1.5 pl-7">
                <select className={small} value={r.day} onChange={(e) => upd(i, { day: +e.target.value })} aria-label="요일">{DAYS.map((d, k) => <option key={d} value={k}>{d}</option>)}</select>
                <input type="time" step="300" className={small} value={r.start} onChange={(e) => upd(i, { start: e.target.value })} aria-label="시작" />
                <span className="text-ink-muted">–</span>
                <input type="time" step="300" className={small} value={r.end} onChange={(e) => upd(i, { end: e.target.value })} aria-label="종료" />
                <select className={small} value={r.building} onChange={(e) => upd(i, { building: e.target.value })} aria-label="건물">
                  <option value="">건물</option>{SORTED.map((b) => <option key={b.name} value={b.name}>{b.name}</option>)}
                </select>
                <input className={`${small} w-16`} value={r.room} onChange={(e) => upd(i, { room: e.target.value })} placeholder="강의실" aria-label="강의실" />
              </div>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

/** 시간표 가져오기: 텍스트 붙여 넣기 / 캡처 이미지 인식 */
export default function ImportDialog({ initialTab = 'text', classes, onImport, onClose }) {
  const [tab, setTab] = useState(initialTab);
  const [text, setText] = useState('');
  const [rows, setRows] = useState([]);
  const [replace, setReplace] = useState(initialTab === 'image');
  const parsed = useMemo(() => parseTimetableText(text), [text]);
  const items = tab === 'text'
    ? parsed.filter((e) => e.ok).map(({ name, day, start, end, building, room }) => ({ name, day, start, end, building, room }))
    : rows.filter((r) => r.include && r.name.trim()).map(({ name, day, start, end, building, room }) => ({ name: name.trim(), day, start, end, building, room }));
  const commit = () => onImport(withColors(items, replace ? [] : classes), replace);
  return (
    <Modal wide title="시간표 가져오기" onClose={onClose}
      footer={<>
        <label className="mr-auto flex items-center gap-2 text-[13px]"><input type="checkbox" className="h-4 w-4 accent-[#206DEF]" checked={replace} onChange={(e) => setReplace(e.target.checked)} />기존 시간표를 지우고 바꾸기</label>
        <Button onClick={onClose}>취소</Button>
        <Button variant="primary" disabled={!items.length} onClick={commit}>{items.length ? `${items.length}개 ${replace ? '바꾸기' : '추가'}` : '가져올 수업 없음'}</Button>
      </>}>
      <div className="grid gap-4">
        <Segmented label="가져오기 방식" value={tab} onChange={setTab} options={[{ value: 'text', label: '텍스트 붙여 넣기' }, { value: 'image', label: '캡처 이미지' }]} />
        {tab === 'text' ? <TextImport text={text} setText={setText} parsed={parsed} /> : <ImageImport rows={rows} setRows={setRows} />}
      </div>
    </Modal>
  );
}
