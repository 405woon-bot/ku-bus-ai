import { Component, StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.jsx';
import { clearState } from './lib/platform.js';
import { MODE } from './hooks/useAppState.js';
import { bootstrapIdentity } from './lib/identity.js';
import { consumeDeletedFlag } from './lib/wipe.js';
import './index.css';

/** 화면 오류가 나도 빈 화면 대신 안내와 복구 버튼을 보여 줍니다(저장된 데이터가 깨진 경우 등). */
class ErrorBoundary extends Component {
  constructor(p) { super(p); this.state = { error: null }; }
  static getDerivedStateFromError(error) { return { error }; }
  componentDidCatch(error) { console.error(error); }
  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="gutter mx-auto grid max-w-lg gap-3 py-16">
        <h1 className="text-xl font-bold">화면을 그리다 오류가 났어요</h1>
        <p className="text-sm text-ink-muted">저장된 시간표 데이터가 예상과 다를 수 있어요. 처음 상태로 되돌리면 다시 열립니다. ({String(this.state.error.message || this.state.error)})</p>
        <button type="button" className="h-10 justify-self-start rounded-[10px] bg-primary px-4 text-sm font-semibold text-white" onClick={() => { clearState(); location.reload(); }}>처음 상태로 되돌리기</button>
      </div>
    );
  }
}

// v2.2.5 '내 데이터 모두 삭제' 뒤 새로 열렸는지(주소의 ?deleted=1 — 읽고 바로 지움)
const deleted = consumeDeletedFlag();
// 홈 화면 앱이 처음 열릴 때: 주소의 이어받기 코드로 Safari에서 쓰던 사용자를 먼저 받아 온 뒤 화면을 그림(최대 6초)
const boot = MODE === 'api' ? bootstrapIdentity().catch(() => ({})) : Promise.resolve({});
boot.then((handoff) => {
  createRoot(document.getElementById('root')).render(<StrictMode><ErrorBoundary><App handoff={handoff} deleted={deleted} /></ErrorBoundary></StrictMode>);
});
