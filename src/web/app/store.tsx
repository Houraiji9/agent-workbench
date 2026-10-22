// 全局状态：账本快照、路由、任务抽屉、对话框、提示与实时同步。
import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { api, setCsrf } from '../api.js';
import type { R } from '../lib/flow.js';
import { snapshotRefresh } from './snapshot.js';

export interface Route { page: string; id?: string; tab?: string; task?: string }

export function parseHash(hash: string): Route {
  const [pathPart, queryPart = ''] = hash.replace(/^#\/?/, '').split('?');
  const [page = 'today', id] = pathPart.split('/').filter(Boolean).map(decodeURIComponent);
  const q = new URLSearchParams(queryPart);
  const pages = ['today', 'requests', 'projects', 'team', 'resources', 'records', 'settings'];
  return { page: pages.includes(page) ? page : 'today', id, tab: q.get('tab') || undefined, task: q.get('task') || undefined };
}

export function routeHash(r: Route): string {
  const q = new URLSearchParams();
  if (r.tab) q.set('tab', r.tab);
  if (r.task) q.set('task', r.task);
  const qs = q.toString();
  return '#/' + r.page + (r.id ? '/' + encodeURIComponent(r.id) : '') + (qs ? '?' + qs : '');
}

export interface DialogState { name: string; props?: R }
export interface ToastState { id: number; text: string; kind: 'ok' | 'error' }

export interface Store {
  data: R;
  tz: string;
  route: Route;
  go(r: Partial<Route> & { page: string }): void;
  setTab(tab: string): void;
  openTask(id: string): void;
  closeTask(): void;
  dialog: DialogState | null;
  openDialog(name: string, props?: R): void;
  closeDialog(): void;
  busy: boolean;
  act<T>(fn: () => Promise<T>, ok?: string): Promise<T | null>;
  refresh(): Promise<void>;
  toast(text: string, kind?: 'ok' | 'error'): void;
  copy(text: string, ok?: string): Promise<boolean>;
  name(agentId: string | null | undefined): string;
  pname(projectId: string | null | undefined): string;
  executorOf(task: R): string;
  live: 'connecting' | 'live' | 'retrying';
  changeTick: number;
  theme: string;
  setTheme(t: string): void;
}

const Ctx = createContext<Store>(null as unknown as Store);
export const useStore = () => useContext(Ctx);

function readTheme(): string {
  try { return localStorage.getItem('wb-theme') || 'light'; } catch { return 'light'; }
}

export function StoreProvider({ children, fallback }: { children: (ready: boolean) => React.ReactNode; fallback?: (error: string) => React.ReactNode }) {
  const [data, setData] = useState<R | null>(null);
  const [bootError, setBootError] = useState('');
  const [route, setRoute] = useState<Route>(() => parseHash(location.hash));
  const [dialog, setDialog] = useState<DialogState | null>(null);
  const [busy, setBusy] = useState(false);
  const [toasts, setToasts] = useState<ToastState[]>([]);
  const [live, setLive] = useState<Store['live']>('connecting');
  const [changeTick, setChangeTick] = useState(0);
  const [theme, setThemeState] = useState(readTheme);
  const mounted = useRef(true);
  const streamReady = useRef(false);
  const toastSeq = useRef(0);

  const toast = useCallback((text: string, kind: 'ok' | 'error' = 'ok') => {
    const id = ++toastSeq.current;
    setToasts(list => [...list.filter(t => t.kind === 'error').slice(-2), { id, text, kind }]);
    setTimeout(() => setToasts(list => list.filter(t => t.id !== id)), kind === 'ok' ? 4200 : 9000);
  }, []);

  const refresher = useRef<ReturnType<typeof snapshotRefresh<R>> | null>(null);
  if (!refresher.current) refresher.current = snapshotRefresh(
    signal => api('/state', undefined, signal),
    value => { if (mounted.current) { setData(value); setChangeTick(t => t + 1); if (streamReady.current) setLive('live'); } },
    () => { if (mounted.current) setLive('retrying'); },
  );
  const refresh = useCallback(() => refresher.current!(), []);

  // 启动：建立页面会话与操作凭据，然后挂实时同步。
  useEffect(() => {
    mounted.current = true;
    let es: EventSource | undefined, disposed = false, timer: ReturnType<typeof setTimeout> | undefined;
    const connect = () => {
      if (disposed) return;
      if (timer) clearTimeout(timer);
      const current = new EventSource('/api/events'); es = current;
      const active = () => !disposed && es === current;
      current.addEventListener('ready', () => {
        if (!active()) return;
        streamReady.current = true;
        // ready 只证明连接恢复；取回完整快照后才能宣称页面已同步。
        void refresh().catch(() => {});
      });
      current.addEventListener('changed', () => { if (active()) void refresh().catch(() => {}); });
      current.onerror = () => {
        if (!active()) return;
        streamReady.current = false; setLive('retrying'); current.close(); es = undefined;
        if (timer) clearTimeout(timer);
        timer = setTimeout(connect, 3000);
      };
    };
    api('/bootstrap').then(v => {
      if (disposed) return;
      setCsrf(v.csrf);
      const { csrf: _c, ...rest } = v;
      setData(rest);
      connect();
    }).catch(e => { if (!disposed) setBootError((e as Error).message); });
    return () => { disposed = true; mounted.current = false; streamReady.current = false; es?.close(); if (timer) clearTimeout(timer); };
  }, [refresh]);

  // 连接仍在但快照读取失败时也会重试，不必等下一次数据变动。
  useEffect(() => {
    if (live !== 'retrying') return;
    let pending = false;
    const timer = setInterval(() => {
      if (streamReady.current && !pending) { pending = true; void refresh().catch(() => {}).finally(() => { pending = false; }); }
    }, 3000);
    return () => clearInterval(timer);
  }, [live, changeTick, refresh]);

  useEffect(() => {
    const onHash = () => setRoute(parseHash(location.hash));
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    try { localStorage.setItem('wb-theme', theme); } catch { /* 浏览器存储不可用时只影响本次外观 */ }
  }, [theme]);

  const navigate = useCallback((r: Route) => {
    const next = routeHash(r);
    if (location.hash !== next) location.hash = next;
    setRoute(r);
  }, []);

  const store = useMemo<Store | null>(() => {
    if (!data) return null;
    const agents = new Map<string, R>(data.agents.map((a: R) => [a.id, a]));
    const projects = new Map<string, R>(data.projects.map((p: R) => [p.id, p]));
    const runs = new Map<string, R>(data.runs.map((r: R) => [r.id, r]));
    const name = (id: string | null | undefined) => (id ? agents.get(id)?.name || id : '未指定');
    return {
      data, tz: data.timezone || 'America/Los_Angeles', route,
      go: r => navigate({ page: r.page, id: r.id, tab: r.tab, task: r.task }),
      setTab: tab => navigate({ ...route, tab }),
      openTask: id => navigate({ ...route, task: id }),
      closeTask: () => navigate({ ...route, task: undefined }),
      dialog,
      openDialog: (name, props) => setDialog({ name, props }),
      closeDialog: () => setDialog(null),
      busy,
      act: async (fn, ok) => {
        setBusy(true);
        try {
          const r = await fn();
          try { await refresh(); if (ok) toast(ok); }
          catch { toast('操作已保存，但页面暂未更新，正在重试同步。请不要重复提交。', 'error'); }
          return r;
        } catch (e) {
          toast((e as Error).message || '操作没有完成', 'error');
          return null;
        } finally { setBusy(false); }
      },
      refresh,
      toast,
      copy: async (text, ok = '已复制') => {
        try { await navigator.clipboard.writeText(text); toast(ok); return true; }
        catch { toast('系统不允许写入剪贴板，请在文本框里手动复制', 'error'); return false; }
      },
      name,
      pname: id => (id ? projects.get(id)?.name || '未知项目' : '未关联项目'),
      executorOf: t => (t.current_run_id && runs.get(t.current_run_id)?.agent_id) || t.agent_id,
      live, changeTick, theme, setTheme: setThemeState,
    };
  }, [data, route, dialog, busy, live, changeTick, theme, navigate, refresh, toast]);

  if (!store) return <>{fallback ? fallback(bootError) : null}</>;
  return <Ctx.Provider value={store}>
    {children(true)}
    <div className="toasts" aria-live="polite">
      {toasts.map(t => <div key={t.id} className={'toast ' + t.kind} role={t.kind === 'error' ? 'alert' : 'status'}>
        <span>{t.text}</span>
        {t.kind === 'error' && <button className="toast-close" aria-label="关闭提示" onClick={() => setToasts(l => l.filter(x => x.id !== t.id))}>×</button>}
      </div>)}
    </div>
  </Ctx.Provider>;
}
