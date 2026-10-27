// 快速跳转（Ctrl+K）：找任务、项目、成员，或直接执行常用操作。
import React, { useMemo, useState } from 'react';
import { Search, CornerDownLeft } from 'lucide-react';
import { useStore } from '../app/store.js';
import type { R } from '../lib/flow.js';
import { statusText,taskDisplayStatus } from '../lib/flow.js';

interface Item { id: string; group: string; label: string; hint?: string; run(): void }

export function Palette({ onClose }: { onClose(): void }) {
  const s = useStore();
  const [q, setQ] = useState('');
  const [index, setIndex] = useState(0);
  const items = useMemo<Item[]>(() => {
    const go = (page: string, extra: R = {}) => () => { s.go({ page, ...extra }); onClose(); };
    const dlg = (name: string) => () => { onClose(); s.openDialog(name); };
    const base: Item[] = [
      { id: 'a-req', group: '操作', label: '提一个需求', hint: 'N', run: dlg('request') },
      { id: 'a-proj', group: '操作', label: '添加项目', run: dlg('project-register') },
      { id: 'a-plan', group: '操作', label: '粘贴规划 Agent 的计划', run: dlg('import-plan') },
      { id: 'a-rec', group: '操作', label: '导入执行回执', run: dlg('receipt') },
      { id: 'a-theme', group: '操作', label: s.theme === 'dark' ? '切换到浅色外观' : '切换到深色外观', run: () => { s.setTheme(s.theme === 'dark' ? 'light' : 'dark'); onClose(); } },
      { id: 'p-today', group: '页面', label: '今天', run: go('today') },
      { id: 'p-requests', group: '页面', label: '需求箱 · 待开始', run: go('requests') },
      { id: 'p-projects', group: '页面', label: '项目', run: go('projects') },
      { id: 'p-team', group: '页面', label: '团队', run: go('team') },
      { id: 'p-quota', group: '页面', label: '额度', run: go('resources', { tab: 'quota' }) },
      { id: 'p-plans', group: '页面', label: '订阅与日程', run: go('resources', { tab: 'plans' }) },
      { id: 'p-conn', group: '页面', label: '数据连接', run: go('resources', { tab: 'connections' }) },
      { id: 'p-records', group: '页面', label: '记录', run: go('records') },
      { id: 'p-settings', group: '页面', label: '设置与备份', run: go('settings') },
    ];
    const tasks: Item[] = (s.data.tasks as R[]).filter(t=>!s.data.projects.some((p:R)=>p.id===t.project_id&&p.shelved)).map(t => ({ id: 't-' + t.id, group: '任务', label: t.title, hint: statusText[taskDisplayStatus(t)], run: () => { onClose(); s.openTask(t.id); } }));
    const projects: Item[] = [...(s.data.projects as R[])].filter(p=>!p.shelved).sort((a, b) => String(b.created_at).localeCompare(String(a.created_at))).flatMap(p => [
      { id: 'pr-' + p.id, group: '项目', label: p.name, hint: p.archived?'已归档':p.stage, run: go('projects', { id: p.id }) },
      { id: 'pd-' + p.id, group: '项目', label: p.name + ' · 图解', run: go('projects', { id: p.id, tab: 'diagrams' }) },
    ]);
    const agents: Item[] = (s.data.agents as R[]).filter(a => !a.archived).map(a => ({ id: 'ag-' + a.id, group: '成员', label: a.name, hint: a.scope?.slice(0, 24), run: go('team', { id: a.id }) }));
    return [...base, ...projects, ...tasks, ...agents];
  }, [s, onClose]);
  const term = q.trim().toLowerCase();
  const shown = (term ? items.filter(i => (i.label + ' ' + (i.hint || '')).toLowerCase().includes(term)) : items).slice(0, term ? 30 : 12);
  const pick = (i: Item | undefined) => i?.run();
  return <div className="scrim top" onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}>
    <div className="palette" role="dialog" aria-modal="true" aria-label="快速跳转">
      <div className="palette-input">
        <Search size={19} />
        <input autoFocus value={q} placeholder="输入任务、项目、成员，或想做的事" aria-label="快速跳转"
          onChange={e => { setQ(e.target.value); setIndex(0); }}
          onKeyDown={e => {
            if (e.nativeEvent.isComposing || e.nativeEvent.keyCode === 229) return;
            if (e.key === 'Escape') { e.preventDefault(); onClose(); }
            if (e.key === 'ArrowDown') { e.preventDefault(); setIndex(i => Math.min(i + 1, shown.length - 1)); }
            if (e.key === 'ArrowUp') { e.preventDefault(); setIndex(i => Math.max(i - 1, 0)); }
            if (e.key === 'Enter') { e.preventDefault(); if (shown[index]) pick(shown[index]); else if (term) { onClose(); s.go({ page: 'records', id: 'q', tab: q.trim() }); } }
          }} />
      </div>
      <ul className="palette-list" role="listbox" aria-label="结果">
        {shown.map((i, n) => <li key={i.id} role="option" aria-selected={n === index} className={n === index ? 'on' : ''} onMouseEnter={() => setIndex(n)} onClick={() => pick(i)}>
          <span className="pg">{i.group}</span><span className="pl">{i.label}</span>{i.hint && <small>{i.hint}</small>}{n === index && <CornerDownLeft size={14} />}
        </li>)}
        {term && <li role="option" aria-selected={!shown.length} className={!shown.length ? 'on' : ''} onClick={() => { onClose(); s.go({ page: 'records', id: 'q', tab: q.trim() }); }}>
          <span className="pg">记录</span><span className="pl">在记录里搜索“{q.trim()}”</span>
        </li>}
      </ul>
      <p className="palette-tip">↑↓ 选择 · Enter 打开 · Esc 关闭</p>
    </div>
  </div>;
}
