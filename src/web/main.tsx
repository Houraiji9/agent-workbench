import {pendingDecisions} from './ui/UserDecision.js';
// 工作台入口：左侧导航 + 顶部快捷栏 + 页面 + 任务抽屉 + 对话框。
import React, { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Sun, Moon, Search, Plus, Menu, X, House, FolderKanban, Users, Gauge, History, Settings as Cog, Inbox } from 'lucide-react';
import './styles.css';
const appIcon = new URL('./assets/workbench-icon.png', import.meta.url).href;
import { StoreProvider, useStore } from './app/store.js';
import { isYourTurn } from './lib/flow.js';
import { Requests } from './views/Requests.js';
import { Today } from './views/Today.js';
import { Projects, ProjectView } from './views/Projects.js';
import { Team } from './views/Team.js';
import { Resources } from './views/Resources.js';
import { Records } from './views/Records.js';
import { Settings } from './views/Settings.js';
import { TaskDrawer } from './views/TaskDrawer.js';
import { Dialogs } from './views/Dialogs.js';
import { Palette } from './views/Palette.js';

const NAV: [string, string, React.ComponentType<{ size?: number }>][] = [
  ['today', '今天', House],
  ['requests', '需求箱', Inbox],
  ['projects', '项目', FolderKanban],
  ['team', '团队', Users],
  ['resources', '额度与订阅', Gauge],
  ['records', '记录', History],
  ['settings', '设置', Cog],
];

function Shell() {
  const s = useStore();
  const [menu, setMenu] = useState(false);
  const [palette, setPalette] = useState(false);
  const { route, data } = s;
  const previousRoute = useRef(route);
  const decisions=pendingDecisions(data),decisionTasks=new Set(decisions.map(d=>d.task_id));
  const visible=(id:unknown)=>!data.projects.some((p:Record<string,unknown>)=>p.id===id&&(p.shelved||p.archived));
  const yours = decisions.length + data.tasks.filter((t:Record<string,any>)=>visible(t.project_id)&&!decisionTasks.has(t.id)&&isYourTurn(t)).length + data.requests.filter((q: Record<string, unknown>) => q.status === 'awaiting_planning' && visible(q.project_id)).length;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const typing = ['INPUT', 'TEXTAREA', 'SELECT'].includes((e.target as HTMLElement).tagName);
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); setPalette(true); return; }
      if (e.key === 'Escape' && !s.dialog && !palette && route.task) { s.closeTask(); return; }
      if (!typing && !s.dialog && !palette && !e.ctrlKey && !e.metaKey && !e.altKey && e.key.toLowerCase() === 'n') { e.preventDefault(); s.openDialog('request'); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [s, palette, route.task]);

  useEffect(() => {
    const previous = previousRoute.current;
    const memberChange = previous.page === 'team' && route.page === 'team'
      && (previous.tab || 'mine') === 'mine' && (route.tab || 'mine') === 'mine' && previous.id !== route.id;
    previousRoute.current = route;
    setMenu(false);
    if (!memberChange) window.scrollTo({top:0,behavior:'instant'});
  }, [route.page, route.id, route.tab]);
  useEffect(() => { document.title = '工作台' + (yours ? `（${yours} 件等你）` : ''); }, [yours]);

  const conn = data.integrations as Record<string, any>[];
  const page = route.page;
  let body: React.ReactNode;
  if (page === 'projects') body = route.id ? <ProjectView id={route.id} /> : <Projects />;
  else if (page === 'requests') body = <Requests />;
  else if (page === 'team') body = <Team />;
  else if (page === 'resources') body = <Resources />;
  else if (page === 'records') body = <Records key={route.id === 'q' ? 'q:' + route.tab : 'all'} />;
  else if (page === 'settings') body = <Settings />;
  else body = <Today />;

  return <div className={'shell' + (menu ? ' menu-open' : '')}>
    <a className="skip" href="#main">跳到主要内容</a>
    <aside className="side" aria-label="主导航">
      <div className="side-brand">
        <img className="app-mark" src={appIcon} alt="" aria-hidden="true"/>
        <div><strong>工作台</strong><small>Agent 接力台</small></div>
        <button className="icon-btn side-close" aria-label="收起菜单" onClick={() => setMenu(false)}><X size={20} /></button>
      </div>
      <nav>
        {NAV.map(([key, label, Icon]) => <button key={key} aria-label={label} title={label} className={"nav-item" + (page === key ? " on" : "")} aria-current={page === key ? 'page' : undefined} onClick={() => s.go({ page: key })}>
          <Icon size={19} /><span>{label}</span>
          {key === 'today' && yours > 0 && <span className="nav-badge" aria-label={`${yours} 件等你处理`}>{yours}</span>}
        </button>)}
      </nav>
      <div className="side-foot">
        <button className="conn-line" onClick={() => s.go({ page: 'resources', tab: 'connections' })} aria-label="查看数据连接">
          {conn.map(c => <span key={c.id} className={'conn c-' + c.status}><i />{c.name}</span>)}
        </button>
        <p className="side-note">数据只保存在这台电脑</p>
      </div>
    </aside>

    <div className="main-col">
      <header className="topbar">
        <button className="icon-btn menu-btn" aria-label="打开菜单" aria-expanded={menu} onClick={() => setMenu(true)}><Menu size={21} /></button>
        <button className="search-btn" onClick={() => setPalette(true)} aria-label="搜索或跳转（Ctrl+K）">
          <Search size={17} /><span>找任务、项目、记录或功能</span><kbd>Ctrl K</kbd>
        </button>
        <div className="top-actions">
          {s.live === 'retrying' && <span className="live-warn" role="status">实时同步中断，正在重连</span>}
          <button className="icon-btn" aria-label={s.theme === 'dark' ? '切换到浅色外观' : '切换到深色外观'} onClick={() => s.setTheme(s.theme === 'dark' ? 'light' : 'dark')}>
            {s.theme === 'dark' ? <Sun size={19} /> : <Moon size={19} />}
          </button>
          <button className="btn primary" onClick={() => s.openDialog('request')}><Plus size={18} />提需求</button>
        </div>
      </header>
      <main id="main" className={'page' + (page === 'team' && (!route.tab || route.tab === 'mine') ? ' team-page-shell' : '')} tabIndex={-1}>{body}</main>
    </div>
    {menu && <div className="side-scrim" onClick={() => setMenu(false)} />}

    {route.task && <TaskDrawer key={route.task} id={route.task} />}
    <Dialogs />
    {palette && <Palette onClose={() => setPalette(false)} />}
  </div>;
}

function Boot({ error }: { error: string }) {
  return <div className="boot">
    <img className="app-mark big" src={appIcon} alt="" aria-hidden="true"/>
    <h1>正在打开工作台</h1>
    <p>{error ? '没能读取本地数据：' + error : '读取项目、任务和额度…'}</p>
    {error && <button className="btn" onClick={() => location.reload()}>重新打开</button>}
  </div>;
}

createRoot(document.getElementById('root')!).render(
  <StoreProvider fallback={e => <Boot error={e} />}>{() => <Shell />}</StoreProvider>,
);
