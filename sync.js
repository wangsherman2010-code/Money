// 家庭同步：和你自己 VPS 上的 server/server.js 对接。
// 思路：每次保存时和上次的快照比对，找出新增/修改/删除的记录，打上时间戳，排队上传；
// 服务器按“后改的为准”合并，再把别人改过的发回来。没网时照常记账，下次有网再同步。

const SKEY = 'voice-ledger.sync.v1';
const load = () => { try { return JSON.parse(localStorage.getItem(SKEY)) || {}; } catch { return {}; } };

export function createSync(api) {
  // api: getRecords, setRecords, getMemory, setMemory, getMeta, setMeta, getConfig, onChange, onStatus
  let st = { seq: 0, dirty: {}, tombs: {}, memDirty: {}, memTombs: {}, metaT: 0, metaDirty: false, lastSync: 0, ...load() };
  const persist = () => { try { localStorage.setItem(SKEY, JSON.stringify(st)); } catch { /* 存储满 */ } };

  const strip = r => { const { updatedAt, by, ...rest } = r; return JSON.stringify(rest); };
  let recSnap = new Map(api.getRecords().map(r => [r.id, strip(r)]));
  let memSnap = new Map(Object.entries(api.getMemory()).map(([k, v]) => [k, JSON.stringify({ ...v, t: 0 })]));
  let metaSnap = JSON.stringify(api.getMeta());

  const enabled = () => { const c = api.getConfig(); return !!(c.url && c.token); };

  // 保存后调用：找出本机的改动
  function noteRecords() {
    const now = Date.now(), me = api.getConfig().member, seen = new Set();
    let touched = false;
    for (const r of api.getRecords()) {
      seen.add(r.id);
      const s = strip(r);
      if (recSnap.get(r.id) !== s) {
        recSnap.set(r.id, s);
        r.updatedAt = now;
        if (!r.by && me) r.by = me;
        st.dirty[r.id] = 1; delete st.tombs[r.id]; touched = true;
      }
    }
    for (const id of [...recSnap.keys()]) if (!seen.has(id)) { recSnap.delete(id); st.tombs[id] = now; delete st.dirty[id]; touched = true; }
    if (touched) { persist(); schedule(); }
    return touched; // true 表示记录被打了时间戳，需要再存一次
  }
  function noteMemory() {
    const now = Date.now(), mem = api.getMemory(), seen = new Set();
    let touched = false;
    for (const [k, v] of Object.entries(mem)) {
      seen.add(k);
      const s = JSON.stringify({ ...v, t: 0 });
      if (memSnap.get(k) !== s) { memSnap.set(k, s); v.t = now; st.memDirty[k] = 1; delete st.memTombs[k]; touched = true; }
    }
    for (const k of [...memSnap.keys()]) if (!seen.has(k)) { memSnap.delete(k); st.memTombs[k] = now; delete st.memDirty[k]; touched = true; }
    if (touched) { persist(); schedule(); }
    return touched;
  }
  function noteMeta() {
    const s = JSON.stringify(api.getMeta());
    if (s !== metaSnap) { metaSnap = s; st.metaT = Date.now(); st.metaDirty = true; persist(); schedule(); }
  }

  // 第一次连上服务器：把本机已有的数据都排进上传队列；分类等设置以服务器上已有的为准
  function prepareJoin() {
    const me = api.getConfig().member;
    st = { seq: 0, dirty: {}, tombs: {}, memDirty: {}, memTombs: {}, metaT: 0, metaDirty: true, lastSync: 0 };
    const now = Date.now();
    for (const r of api.getRecords()) { if (!r.by && me) r.by = me; r.updatedAt = r.updatedAt || now; st.dirty[r.id] = 1; }
    for (const [k, v] of Object.entries(api.getMemory())) { v.t = v.t || now; st.memDirty[k] = 1; }
    api.setRecords(api.getRecords());
    persist();
  }
  function reset() { st = { seq: 0, dirty: {}, tombs: {}, memDirty: {}, memTombs: {}, metaT: 0, metaDirty: false, lastSync: 0 }; persist(); }

  let timer = null, running = null, again = false;
  function schedule(delay = 1500) {
    if (!enabled()) return;
    clearTimeout(timer);
    timer = setTimeout(() => syncNow(), delay);
  }

  async function syncNow() {
    if (!enabled()) return { ok: false, error: 'not configured' };
    if (running) { again = true; return running; }
    running = (async () => {
      const cfg = api.getConfig();
      const recs = api.getRecords(), byId = new Map(recs.map(r => [r.id, r]));
      const pushRecords = [
        ...Object.keys(st.dirty).map(id => byId.get(id)).filter(Boolean),
        ...Object.entries(st.tombs).map(([id, t]) => ({ id, deleted: true, updatedAt: t })),
      ];
      const mem = api.getMemory();
      const pushMemory = [
        ...Object.keys(st.memDirty).filter(k => mem[k]).map(k => ({ k, v: mem[k], t: mem[k].t || Date.now() })),
        ...Object.entries(st.memTombs).map(([k, t]) => ({ k, deleted: true, t })),
      ];
      const pushMeta = st.metaDirty && st.metaT ? { value: api.getMeta(), t: st.metaT } : null;
      // 记下这次上传的版本，回来时只清掉没有再被改过的
      const sentRec = Object.fromEntries(pushRecords.map(r => [r.id, r.updatedAt]));
      const sentMem = Object.fromEntries(pushMemory.map(m => [m.k, m.t]));
      const sentMetaT = st.metaT;
      api.onStatus({ state: 'syncing' });
      try {
        const res = await fetch(cfg.url.replace(/\/+$/, '') + '/api/sync', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + cfg.token },
          body: JSON.stringify({ since: st.seq, push: { records: pushRecords, memory: pushMemory, meta: pushMeta } }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw Object.assign(new Error(data.error || `HTTP ${res.status}`), { status: res.status });

        // 清掉已上传的改动
        for (const [id, t] of Object.entries(sentRec)) {
          if (st.dirty[id] && byId.get(id)?.updatedAt === t) delete st.dirty[id];
          if (st.tombs[id] === t) delete st.tombs[id];
        }
        for (const [k, t] of Object.entries(sentMem)) {
          if (st.memDirty[k] && api.getMemory()[k]?.t === t) delete st.memDirty[k];
          if (st.memTombs[k] === t) delete st.memTombs[k];
        }
        if (st.metaT === sentMetaT) st.metaDirty = false;

        // 合并别人的改动（本机还没上传、而且更新的改动保留本机的）
        let changed = false;
        const list = api.getRecords(), idx = new Map(list.map((r, i) => [r.id, i]));
        for (const r of data.records || []) {
          const i = idx.get(r.id), local = i != null ? list[i] : null;
          if (st.dirty[r.id] && local && (local.updatedAt || 0) > (r.updatedAt || 0)) continue;
          if (st.tombs[r.id] && st.tombs[r.id] > (r.updatedAt || 0)) continue;
          const { rev, ...clean } = r;
          if (r.deleted) {
            if (i != null) { list[i] = null; changed = true; }
            recSnap.delete(r.id);
          } else if (!local || (local.updatedAt || 0) < (r.updatedAt || 0)) {
            delete clean.deleted;
            if (i != null) list[i] = clean; else { list.push(clean); idx.set(r.id, list.length - 1); }
            recSnap.set(r.id, strip(clean)); changed = true;
          }
        }
        const memNow = api.getMemory();
        let memChanged = false;
        for (const m of data.memory || []) {
          if (st.memDirty[m.k] && (memNow[m.k]?.t || 0) > m.t) continue;
          if (m.deleted) { if (memNow[m.k]) { delete memNow[m.k]; memChanged = true; } memSnap.delete(m.k); }
          else if (!memNow[m.k] || (memNow[m.k].t || 0) < m.t) { memNow[m.k] = { ...m.v, t: m.t }; memSnap.set(m.k, JSON.stringify({ ...m.v, t: 0 })); memChanged = true; }
        }
        let metaChanged = false;
        if (data.meta && data.meta.t > st.metaT) {
          st.metaT = data.meta.t; st.metaDirty = false;
          api.setMeta(data.meta.value); metaSnap = JSON.stringify(api.getMeta()); metaChanged = true;
        } else if (!data.meta && st.seq === 0 && !st.metaT) {
          // 服务器还没有分类等设置：把本机的传上去
          st.metaT = Date.now(); st.metaDirty = true; again = true;
        }
        if (changed) api.setRecords(list.filter(Boolean));
        if (memChanged) api.setMemory(memNow);
        st.seq = data.seq || st.seq;
        st.lastSync = Date.now();
        persist();
        if (changed || memChanged || metaChanged) api.onChange();
        api.onStatus({ state: 'ok', at: st.lastSync, pending: pendingCount() });
        return { ok: true, pulled: (data.records || []).length };
      } catch (e) {
        const error = e instanceof TypeError ? api.offlineText() : e.message; // 没网 / 服务器连不上
        api.onStatus({ state: 'error', error, status: e.status, pending: pendingCount() });
        return { ok: false, error, status: e.status };
      } finally {
        running = null;
        if (again) { again = false; schedule(300); }
      }
    })();
    return running;
  }

  const pendingCount = () => Object.keys(st.dirty).length + Object.keys(st.tombs).length;

  // 回到 App、联网、每 30 秒（App 在前台时）自动同步
  document.addEventListener('visibilitychange', () => { if (!document.hidden) schedule(200); });
  addEventListener('online', () => schedule(200));
  setInterval(() => { if (!document.hidden) schedule(0); }, 30_000);

  return { noteRecords, noteMemory, noteMeta, syncNow, schedule, prepareJoin, reset, enabled, pendingCount, state: () => st };
}

export async function ping(url) {
  const res = await fetch(url.replace(/\/+$/, '') + '/api/ping', { cache: 'no-store' });
  const data = await res.json();
  if (!data?.ok || data.app !== 'voice-ledger') throw new Error('not a ledger server');
  return data;
}
