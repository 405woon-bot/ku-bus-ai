import { Component, StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.jsx';
import { clearState } from './lib/platform.js';
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

createRoot(document.getElementById('root')).render(<StrictMode><ErrorBoundary><App /></ErrorBoundary></StrictMode>);
