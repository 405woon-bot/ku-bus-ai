import { useId } from 'react';
import { Button, Chip, SampleTag } from './ui.jsx';

// 서울 시각으로 표시(서버 시각은 ISO, 브라우저 시간대와 관계없이)
const two = (n) => String(n).padStart(2, '0');
const kst = (ms) => new Date(ms + 9 * 3600_000);
const hhmm = (iso) => { if (!iso) return ''; const d = kst(Date.parse(iso)); return `${two(d.getUTCHours())}:${two(d.getUTCMinutes())}`; };
const hhmmss = (ms) => { const d = kst(ms); return `${two(d.getUTCHours())}:${two(d.getUTCMinutes())}:${two(d.getUTCSeconds())}`; };
const NeedChip = ({ children }) => <span data-testid="push-status" className="inline-flex h-6 items-center whitespace-nowrap rounded-md border-[1.5px] border-dashed border-[#E0A64A] bg-warn-soft px-2 text-xs font-bold text-warn">{children}</span>;
const StatusChip = ({ level, children }) => <span data-testid="push-status"><Chip level={level}>{children}</Chip></span>;

/**
 * 설정 · '알림 · 앱을 닫아도 받기'(백그라운드 알림). 실제로 받아 보기 전까지는 '확인 필요'.
 * @param {{ mode, info, push: ReturnType<import('../hooks/usePush.js').usePush>, onOpenGuide: () => void, prefsNotify: boolean }} p
 */
export default function PushPanel({ info, push, onOpenGuide, prefsNotify }) {
  const titleId = useId();
  const p = push;
  const confirmed = Boolean(p.confirmedAt);
  const lastTest = p.push?.lastTest, lastAlarm = p.push?.lastAlarm;
  const testAcked = Boolean(p.testSentAt && lastTest?.ackAt && Date.parse(lastTest.ackAt) >= p.testSentAt - 5000);
  const slow = Boolean(p.testSentAt && !testAcked && (p.pollDone || Date.now() - p.testSentAt > 60000));

  let right = null, desc = null;
  switch (p.state) {
    case 'checking': right = <StatusChip level="muted">확인 중…</StatusChip>; desc = '이 기기의 알림 구독을 서버와 맞추는 중이에요.'; break;
    case 'unsupported':
      right = <StatusChip level="muted">지원 안 됨</StatusChip>;
      desc = info.ios ? '아이폰은 iOS 16.4 이상에서 홈 화면 앱으로 열어야 알림을 받을 수 있어요. 설정 → 일반 → 소프트웨어 업데이트를 확인해 주세요.'
        : info.android ? '이 브라우저(앱 안의 화면 등)는 백그라운드 알림을 지원하지 않아요. 크롬에서 열어 주세요.' : '이 브라우저는 백그라운드 알림을 지원하지 않아요. 크롬 · 엣지 · 사파리 최신 버전에서 열어 주세요.';
      break;
    case 'need-install':
      right = <Button size="sm" variant="primary" onClick={onOpenGuide}>{info.browser === 'safari' ? '방법 보기' : 'Safari로 열기 안내'}</Button>;
      desc = info.browser === 'safari' ? '아이폰은 홈 화면에 추가한 앱에서만 알림을 받을 수 있어요(iOS 16.4 이상). 추가한 뒤 홈 화면 아이콘으로 열어 여기서 켜 주세요.'
        : `${info.inAppName || '이 브라우저'} 안에서는 홈 화면에 추가할 수 없어요. Safari로 열어 홈 화면에 추가해 주세요.`;
      break;
    case 'off':
      right = <Button size="sm" variant="primary" disabled={p.busy} onClick={p.enable}>{p.busy ? '켜는 중…' : '알림 켜기'}</Button>;
      desc = info.ios ? '누르면 아이폰이 “알림 허용”을 물어요. 허용하면 앱을 닫아도 출발 시각에 알림이 와요.' : '누르면 알림 허용을 물어요. 허용하면 앱을 닫아도 출발 시각에 알림이 와요.';
      break;
    case 'denied':
      right = <StatusChip level="danger">차단됨</StatusChip>;
      desc = info.ios ? '아이폰 설정 → 알림 → KU BUS에서 ‘알림 허용’을 켠 뒤 앱을 다시 열어 주세요.' : '주소창 왼쪽 자물쇠(사이트 정보) → 알림 → 허용으로 바꾼 뒤 새로 고쳐 주세요.';
      break;
    case 'needs-tap':
      right = <Button size="sm" variant="primary" disabled={p.busy} onClick={p.enable}>알림 다시 켜기</Button>;
      desc = '이 기기의 알림 구독이 끊겼어요. 버튼을 누르면 다시 등록해요.';
      break;
    case 'no-vapid':
      right = <StatusChip level="danger">서버 키 없음</StatusChip>;
      desc = `${p.error || '서버에 푸시 키(VAPID)가 없어요.'} Render 환경변수 VAPID_PUBLIC_KEY · VAPID_PRIVATE_KEY · VAPID_SUBJECT를 확인해 주세요.`;
      break;
    case 'on':
      right = (
        <div className="flex flex-wrap items-center gap-2">
          {confirmed ? <StatusChip level="ok">수신 확인됨 · {hhmm(p.confirmedAt)}</StatusChip> : <NeedChip>켜짐 · 확인 필요</NeedChip>}
          <Button size="sm" disabled={p.busy} onClick={p.test}>{p.busy ? '보내는 중…' : confirmed ? '다시 보내기' : '테스트 알림 보내기'}</Button>
        </div>
      );
      desc = confirmed
        ? `앱을 열 때마다 구독을 확인해 끊겼으면 자동으로 다시 등록해요${p.push?.device?.seenAt ? ` · 마지막 확인 ${hhmm(p.push.device.seenAt)}` : ''}${p.renewedAt ? ' · 방금 자동으로 다시 등록했어요' : ''}`
        : p.testSentAt
          ? (slow ? '알림이 안 왔나요? 방해 금지 · 집중 모드, 휴대폰 설정 → 알림 → KU BUS를 확인한 뒤 다시 보내 보세요. 앱을 닫아 둔 상태에서 와야 해요.'
            : `보냄 ${hhmmss(p.testSentAt)} — 알림이 오면 자동으로 ‘수신 확인됨’으로 바뀌어요. 앱을 닫고 기다려 보세요.`)
          : `누르고 바로 앱을 닫아 보세요. 10초 안에 알림이 오면 성공이에요.${p.renewedAt ? ' · 방금 자동으로 다시 등록했어요' : ''}`;
      break;
    default:
      right = <Button size="sm" onClick={p.enable}>다시 시도</Button>;
      desc = p.error || '알림을 켜지 못했어요.';
  }
  if (p.error && p.state === 'on') desc = `${desc} (${p.error})`;

  return (
    <section aria-labelledby={titleId} className="grid grid-cols-1 gap-2">
      <h2 id={titleId} className="px-1 text-[13px] font-bold text-ink-muted">알림 · 앱을 닫아도 받기</h2>
      <div data-testid="push-panel" data-state={p.state} data-confirmed={confirmed ? '1' : ''} className="divide-y divide-line rounded-2xl border border-line bg-panel shadow-card">
        <div className="px-4 py-3.5">
          <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
            <p className="text-[15px] font-semibold">백그라운드 알림</p>
            {right}
          </div>
          <p className="mt-1 text-xs leading-relaxed text-ink-muted">{desc}</p>
          {p.sample && <p className="mt-1.5 flex flex-wrap items-center gap-1.5 text-xs text-ink-muted"><SampleTag>예시 · 실제 알림 아님</SampleTag>미리보기에는 서버가 없어 흐름만 보여 줘요</p>}
          {!prefsNotify && p.state === 'on' && <p className="mt-1 text-xs font-semibold text-warn">위 ‘출발 알림’이 꺼져 있어 출발 알림은 오지 않아요(테스트 알림은 와요).</p>}
        </div>
        {p.state === 'on' && (lastAlarm || !p.sample) && (
          <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 px-4 py-3">
            <p className="text-[13px] text-ink-muted" data-testid="push-last-alarm">
              {lastAlarm
                ? <>마지막 출발 알림 <b className="font-semibold text-ink">{hhmm(lastAlarm.sentAt)}</b> 보냄 · {lastAlarm.sent ? (lastAlarm.ackAt ? '휴대폰 수신 확인됨' : '수신 확인 안 됨') : '보낼 기기 없음'}</>
                : '아직 보낸 출발 알림이 없어요. 수업이 있는 날 출발 시각 전에 와요.'}
            </p>
            <Button size="sm" variant="ghost" disabled={p.busy} onClick={p.disable}>이 기기 알림 끄기</Button>
          </div>
        )}
      </div>
    </section>
  );
}
