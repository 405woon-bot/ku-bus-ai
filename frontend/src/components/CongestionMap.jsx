import { useEffect, useRef, useState } from 'react';
import MAP from '../data/miniMap.json';
import { BUILDINGS } from '@shared/campusData.js';
import { routeColor } from '../lib/palette.js';

// 2D 정체 지도(캔버스): OSM 도로·건물 위에 정체 구간, 하차 정류장, 건물까지 도보 경로, (예시) 버스 위치를 그립니다.
const C = { bg: '#F9F9F9', park: '#D0E2C2', campus: '#EEF3F8', primary: '#206DEF', primaryLine: '#C7DAFB', road: '#FECA7D', roadEdge: '#E7AD55',
  minorEdge: '#D9D9D9', panel: '#FFFFFF', building: '#DCE9F1', buildingEdge: '#BFD1DD', text: '#222222', muted: '#888888', bus: '#4A92EB',
  ok: '#1E7B45', warn: '#E09A2B', danger: '#D0342C' };
const MAJOR = new Set(['trunk', 'trunk_link', 'primary', 'primary_link', 'secondary', 'tertiary', 'tertiary_link']);
const HEADWAY = { 171: 7, 1711: 9, 1112: 10 }; // 예시 배차(분)

const pts = (a) => { const o = []; for (let i = 0; i < a.length; i += 2) o.push([a[i], a[i + 1]]); return o; };
function nearestOn(p, line) {
  let best = { d: Infinity, i: 0, t: 0 };
  for (let i = 0; i < line.length - 1; i++) {
    const [ax, az] = line[i], [bx, bz] = line[i + 1], dx = bx - ax, dz = bz - az, L = dx * dx + dz * dz || 1;
    const t = Math.max(0, Math.min(1, ((p[0] - ax) * dx + (p[1] - az) * dz) / L));
    const d = Math.hypot(ax + dx * t - p[0], az + dz * t - p[1]);
    if (d < best.d) best = { d, i, t };
  }
  return best;
}
const len = (path) => path.slice(1).reduce((s, q, i) => s + Math.hypot(q[0] - path[i][0], q[1] - path[i][1]), 0);
/** 정류장에서 같은 이름 도로를 따라 거슬러 올라가는 경로(더 긴 쪽) */
function corridorFrom(name, stop) {
  let best = null;
  for (const r of MAP.roads) if (r.n === name) { const line = pts(r.p), n = nearestOn(stop, line); if (!best || n.d < best.n.d) best = { line, n }; }
  if (!best) return null;
  const { line, n } = best, P = [line[n.i][0] + (line[n.i + 1][0] - line[n.i][0]) * n.t, line[n.i][1] + (line[n.i + 1][1] - line[n.i][1]) * n.t];
  const fwd = [P, ...line.slice(n.i + 1)], back = [P, ...line.slice(0, n.i + 1).reverse()];
  return len(fwd) >= len(back) ? fwd : back;
}
function along(path, d) {
  for (let i = 0; i < path.length - 1; i++) {
    const s = Math.hypot(path[i + 1][0] - path[i][0], path[i + 1][1] - path[i][1]);
    if (d <= s) { const t = d / (s || 1); return [path[i][0] + (path[i + 1][0] - path[i][0]) * t, path[i][1] + (path[i + 1][1] - path[i][1]) * t]; }
    d -= s;
  }
  return path[path.length - 1];
}

export default function CongestionMap({ live, plan, routes, layers, nowMin }) {
  const wrap = useRef(null), cv = useRef(null);
  const [w, setW] = useState(320);
  useEffect(() => {
    setW(Math.max(240, Math.round(wrap.current.clientWidth)));
    const ro = new ResizeObserver(([e]) => setW(Math.max(240, Math.round(e.contentRect.width))));
    ro.observe(wrap.current); return () => ro.disconnect();
  }, []);
  const h = Math.round(Math.max(230, Math.min(360, w * 0.66)));
  const tick = Math.floor(nowMin * 4);
  useEffect(() => {
    const canvas = cv.current, dpr = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = w * dpr; canvas.height = h * dpr;
    const g = canvas.getContext('2d'); g.setTransform(dpr, 0, 0, dpr, 0, 0);
    const [x0, z0, x1, z1] = MAP.box, s = Math.min(w / (x1 - x0), h / (z1 - z0));
    const ox = (w - (x1 - x0) * s) / 2, oz = (h - (z1 - z0) * s) / 2;
    const X = (x) => (x - x0) * s + ox, Z = (z) => (z - z0) * s + oz;
    const ring = (r) => { g.moveTo(X(r[0]), Z(r[1])); for (let i = 2; i < r.length; i += 2) g.lineTo(X(r[i]), Z(r[i + 1])); g.closePath(); };
    const line = (p) => { g.beginPath(); g.moveTo(X(p[0]), Z(p[1])); for (let i = 2; i < p.length; i += 2) g.lineTo(X(p[i]), Z(p[i + 1])); };
    g.fillStyle = C.bg; g.fillRect(0, 0, w, h);
    g.fillStyle = C.park; for (const poly of MAP.wood) { g.beginPath(); poly.forEach(ring); g.fill('evenodd'); }
    g.beginPath(); MAP.campus.forEach(ring); g.fillStyle = C.campus; g.fill('evenodd');
    g.setLineDash([5, 4]); g.strokeStyle = C.primary; g.globalAlpha = 0.5; g.lineWidth = 1.2; g.stroke(); g.setLineDash([]); g.globalAlpha = 1;
    g.lineCap = 'round'; g.lineJoin = 'round';
    const ordered = [...MAP.roads].sort((a, b) => MAJOR.has(a.hw) - MAJOR.has(b.hw) || a.el - b.el);
    for (const pass of ['case', 'fill']) for (const r of ordered) {
      const major = MAJOR.has(r.hw), wpx = Math.max(r.w * s, major ? 3.2 : 1.8);
      line(r.p); g.strokeStyle = pass === 'case' ? (major ? C.roadEdge : C.minorEdge) : major ? C.road : C.panel;
      g.lineWidth = pass === 'case' ? wpx + 1.6 : wpx; g.stroke();
    }
    // 정체 구간
    const corr = new Set(routes.filter((r) => r.enabled !== false).map((r) => r.corridor));
    if (layers.congestion) for (const r of MAP.roads) {
      const d = live?.roadDelays?.[r.n];
      if (!(d >= 2) && !corr.has(r.n)) continue;
      line(r.p); g.strokeStyle = d >= 5 ? C.danger : d >= 2 ? C.warn : C.ok; g.globalAlpha = d >= 2 ? 0.9 : 0.55;
      g.lineWidth = Math.max(r.w * s, 3) + (d >= 2 ? 2 : 0); g.stroke(); g.globalAlpha = 1;
    }
    // 건물
    const target = plan?.cls?.building;
    for (const b of MAP.buildings) {
      g.beginPath(); b.p.forEach(ring);
      const hl = b.n && b.n === target;
      g.fillStyle = hl ? C.primaryLine : C.building; g.fill('evenodd');
      g.strokeStyle = hl ? C.primary : C.buildingEdge; g.lineWidth = hl ? 2 : 0.8; g.stroke();
    }
    const label = (t, x, y, color = C.text, font = '600 11px "IBM Plex Sans KR", "Noto Sans CJK KR", sans-serif') => {
      g.font = font; g.textAlign = 'center'; g.textBaseline = 'middle'; g.lineWidth = 3; g.strokeStyle = C.panel; g.strokeText(t, x, y); g.fillStyle = color; g.fillText(t, x, y);
    };
    // 도보 경로(하차 정류장 → 출입문 → 건물)
    const tb = target && BUILDINGS.find((b) => b.name === target);
    if (layers.walk && plan && tb) {
      const gate = plan.primary.gate, st = MAP.stops[gate].xy, gt = MAP.gates[gate];
      g.beginPath(); g.moveTo(X(st[0]), Z(st[1])); g.lineTo(X(gt[0]), Z(gt[1])); g.lineTo(X(tb.x), Z(tb.z));
      g.setLineDash([4, 3]); g.strokeStyle = C.primary; g.lineWidth = 2.2; g.stroke(); g.setLineDash([]);
      label(`도보 ${plan.primary.walkMin}분`, (X(gt[0]) + X(tb.x)) / 2, (Z(gt[1]) + Z(tb.z)) / 2 - 9, C.primary, '700 12px "IBM Plex Sans KR", sans-serif');
      label(target, X(tb.x), Z(tb.z) + 12, C.text, '700 11px "IBM Plex Sans KR", sans-serif');
    }
    // 하차 정류장
    for (const gate of ['정문', '후문']) {
      const [sx, sz] = MAP.stops[gate].xy, x = X(sx), y = Z(sz);
      g.fillStyle = C.bus; g.beginPath(); g.roundRect(x - 7, y - 7, 14, 14, 4); g.fill(); g.strokeStyle = C.panel; g.lineWidth = 1.5; g.stroke();
      label(`${gate} · ${MAP.stops[gate].name}`, x, y + 16);
    }
    // 버스 위치(예시): 다음 차 도착까지 남은 시간만큼 정류장에서 떨어진 곳
    if (layers.buses) routes.filter((r) => r.enabled !== false).forEach((r, k) => {
      const path = corridorFrom(r.corridor, MAP.stops[r.gate].xy); if (!path) return;
      const lr = live?.routes?.find((x) => x.id === r.id), hw = HEADWAY[r.no] || 8;
      const eta = hw - (nowMin % hw), speed = 230 * (r.usualMin / (lr?.liveMin || r.usualMin));
      const [bx, bz] = along(path, Math.min(len(path) - 5, eta * speed)), x = X(bx), y = Z(bz) - k * 2;
      g.beginPath(); g.arc(x, y, 9, 0, Math.PI * 2); g.fillStyle = routeColor(r.type); g.fill(); g.strokeStyle = C.panel; g.lineWidth = 2; g.stroke();
      g.fillStyle = C.panel; g.font = '700 9px "Barlow Semi Condensed", sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText(r.no.slice(-3), x, y + 0.5);
      label(`${r.no} · ${Math.ceil(eta)}분`, x, y - 15, C.text, '700 11px "IBM Plex Sans KR", sans-serif');
    });
    g.font = '500 10px "IBM Plex Sans KR", sans-serif'; g.textAlign = 'right'; g.textBaseline = 'bottom'; g.fillStyle = C.muted; g.fillText(MAP.attribution, w - 6, h - 4);
  }, [w, h, live, plan, routes, layers, tick, nowMin]);
  return <div ref={wrap} className="w-full min-w-0"><canvas ref={cv} style={{ width: '100%', height: h }} className="block rounded-xl border border-line" role="img"
    aria-label="캠퍼스 주변 정체 지도: 정체 구간, 정문·후문 하차 정류장, 건물까지 도보 경로, 예시 버스 위치" /></div>;
}
