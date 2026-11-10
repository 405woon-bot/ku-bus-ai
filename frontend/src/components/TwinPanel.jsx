import { useState } from 'react';
import CongestionMap from './CongestionMap.jsx';
import PREVIEW_3D from '../data/preview3d.js';
import { Card, IconCube, IconExternal, SampleTag, Segmented } from './ui.jsx';

export const LINK_3D = 'KU_Bus_3D_V4.html';

const Toggle = ({ on, onClick, children, dot }) => (
  <button type="button" aria-pressed={on} onClick={onClick}
    className={`inline-flex h-8 items-center gap-1.5 rounded-full border px-3 text-[13px] font-semibold transition-colors ${on ? 'border-primary bg-primary-soft text-primary-active' : 'border-line bg-panel text-ink-muted'}`}>
    <span className="h-2.5 w-2.5 rounded-full" style={{ background: on ? dot : '#D9D9D9' }} />{children}
  </button>
);

/** 디지털 트윈 연동 패널: 2D 정체 지도 ↔ 3D 디지털 트윈 */
export default function TwinPanel({ live, plan, routes, nowMin }) {
  const [view, setView] = useState('map');
  const [layers, setLayers] = useState({ congestion: true, buses: true, walk: true });
  const flip = (k) => setLayers((l) => ({ ...l, [k]: !l[k] }));
  return (
    <Card id="twin" title="디지털 트윈" aside={<Segmented size="sm" label="보기" value={view} onChange={setView} options={[{ value: 'map', label: '정체 지도' }, { value: 'three', label: '3D 트윈' }]} />}>
      {view === 'map' ? (
        <div className="grid gap-3 px-5 py-4">
          <div className="flex flex-wrap items-center gap-2">
            <Toggle on={layers.congestion} onClick={() => flip('congestion')} dot="#D0342C">정체 구간</Toggle>
            <Toggle on={layers.buses} onClick={() => flip('buses')} dot="#4A92EB">버스 위치(예시)</Toggle>
            <Toggle on={layers.walk} onClick={() => flip('walk')} dot="#206DEF">도보 경로</Toggle>
            {live?.source === 'mock' && <span className="ml-auto"><SampleTag /></span>}
            {live?.source === 'seoul' && <span className="ml-auto text-xs text-ink-muted">정체 구간: 서울시 구간 속도로 추정 · 버스 위치 표시는 예시</span>}
          </div>
          <CongestionMap live={live} plan={plan} routes={routes} layers={layers} nowMin={nowMin} />
          <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-ink-muted">
            <span className="flex items-center gap-1.5"><i className="h-1.5 w-5 rounded bg-danger" />정체(+5분 이상)</span>
            <span className="flex items-center gap-1.5"><i className="h-1.5 w-5 rounded" style={{ background: '#E09A2B' }} />서행(+2~4분)</span>
            <span className="flex items-center gap-1.5"><i className="h-1.5 w-5 rounded bg-ok/60" />원활(내 노선 구간)</span>
          </div>
        </div>
      ) : (
        <div className="grid gap-3 px-5 py-4">
          <img src={PREVIEW_3D} alt="KU Bus 3D 디지털 트윈 V4의 캠퍼스 전경" className="aspect-[16/10] w-full rounded-xl border border-line object-cover" loading="lazy" />
          <p className="text-sm">OSM 실제 지도로 만든 국민대 3D 디지털 트윈(V4)에서 캠퍼스·도로·버스를 입체로 볼 수 있어요. 3D의 버스는 가상 운행입니다.</p>
          <div className="flex flex-wrap gap-2">
            <a href={LINK_3D} target="_blank" rel="noopener" className="inline-flex h-10 items-center gap-2 rounded-[10px] bg-primary px-3.5 text-sm font-semibold text-white hover:bg-primary-active"><IconCube className="h-4 w-4" />3D 트윈 새 탭에서 열기<IconExternal className="h-4 w-4" /></a>
          </div>
          <p className="rounded-lg bg-surface px-3 py-2 text-xs text-ink-muted">연동 계획: 이 화면의 정체 구간·내 노선·하차 정류장을 window.postMessage(&#123; type: 'ku-bus:overlay' &#125;)로 3D에 보내 도로를 색칠하고 해당 정류장으로 카메라를 옮깁니다. 3D 쪽 수신 코드는 아직 붙이지 않았습니다.</p>
        </div>
      )}
    </Card>
  );
}
