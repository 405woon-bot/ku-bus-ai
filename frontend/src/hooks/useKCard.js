import { useCallback, useEffect, useRef, useState } from 'react';
import { deleteKCard, loadKCard, saveKCard } from '../lib/kcard.js';

/**
 * K•CARD+ 캡처 이미지(이 기기에만 저장). 앱을 열 때 미리 읽어 두어 '도착했어요!'를 누르면 바로 띄움
 * @returns {{ status:'loading'|'none'|'ready', url, meta, error, busy, save(file):Promise<boolean>, remove():Promise<void> }}
 */
export function useKCard() {
  const [st, setSt] = useState({ status: 'loading', url: null, meta: null, error: null, busy: false });
  const urlRef = useRef(null);
  const keep = (url) => { // 바뀐 이미지 주소만 남기고 예전 blob 주소는 풀어 줌
    const old = urlRef.current;
    urlRef.current = url;
    if (old && old !== url && old.startsWith('blob:')) URL.revokeObjectURL(old);
  };
  useEffect(() => {
    let alive = true;
    loadKCard().then((r) => {
      if (!alive) { if (r?.url?.startsWith('blob:')) URL.revokeObjectURL(r.url); return; }
      keep(r?.url || null);
      setSt({ status: r ? 'ready' : 'none', url: r?.url || null, meta: r?.meta || null, error: null, busy: false });
    }, () => alive && setSt({ status: 'none', url: null, meta: null, error: null, busy: false }));
    return () => { alive = false; keep(null); };
  }, []);
  const save = useCallback(async (file) => {
    setSt((s) => ({ ...s, busy: true, error: null }));
    try {
      const r = await saveKCard(file);
      keep(r.url);
      setSt({ status: 'ready', url: r.url, meta: r.meta, error: null, busy: false });
      return true;
    } catch (e) {
      setSt((s) => ({ ...s, busy: false, error: e?.message || '이미지를 저장하지 못했어요' }));
      return false;
    }
  }, []);
  const remove = useCallback(async () => {
    await deleteKCard();
    keep(null);
    setSt({ status: 'none', url: null, meta: null, error: null, busy: false });
  }, []);
  return { ...st, save, remove };
}
