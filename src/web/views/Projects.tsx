// 项目：总览卡片 + 从 Agent 会话里发现的文件夹；单个项目分为进展、成果、图解、经验、文件夹五个页签。
import React, { useState } from 'react';
import { Plus, FolderOpen, Copy, PencilLine, Link2, Download, Network, ArrowLeft, Lightbulb, FolderSearch, FileText, MessagesSquare, Archive, RotateCcw } from 'lucide-react';
import {canEditRequest} from '../../shared/request-policy.js';
import { api } from '../api.js';
import { useStore } from '../app/store.js';
import { type R, relayOf, requestRelay, isYourTurn, isTheirTurn, byUrgency, folderSuggestions } from '../lib/flow.js';
import { relative, fullDate, bytes } from '../lib/format.js';
import { Pill, RelayTrack, Empty, Tabs, Section, Notice } from '../ui/kit.js';
import { startPlanning, copyPlanning } from './actions.js';
import { agentLabel } from './dialogs/ResourceDialogs.js';
import {ArtifactLocation} from '../ui/ArtifactLocation.js';
import {ExecutionList,OrderStep,OrderStatus} from '../ui/ExecutionOrder.js';
import {RequestPreview} from '../ui/RequestPreview.js';

function projectStats(data: R, id: string) {
  const tasks = (data.tasks as R[]).filter(t => t.project_id === id);
  return {
    tasks,
    yours: tasks.filter(isYourTurn).length + (data.requests as R[]).filter(q => q.project_id === id && q.status === 'awaiting_planning').length,
    working: tasks.filter(isTheirTurn).length,
    done: tasks.filter(t => t.status === 'accepted').length,
  };
}

export function Projects() {
  const s = useStore();
  const { data } = s;
  const suggestions = folderSuggestions(data.sessions, data.projects);
  const [query,setQuery]=useState(''),[limit,setLimit]=useState(24);const archived=s.route.tab==='archived';
  const projects=(data.projects as R[]).filter(p=>!!p.archived===archived&&[p.name,p.goal,...p.paths].join(' ').toLowerCase().includes(query.trim().toLowerCase())).sort((a,b)=>String(b.updated_at).localeCompare(String(a.updated_at)));
  return <div className="page-wrap">
    <header className="page-head">
      <div><h1>项目</h1><p>每个项目的任务、成果、图解和经验都收在一起。</p></div>
      <button className="btn primary" onClick={() => s.openDialog('project-register')}><Plus size={18} />添加项目</button>
    </header>
    <Tabs label="项目状态" value={archived?'archived':'active'} onChange={tab=>{setLimit(24);s.go({page:'projects',tab})}} tabs={[[ 'active','当前项目'],['archived','已归档']]}/>
    <input className="filter-input" aria-label="搜索项目" placeholder="搜索项目名称、目标或文件夹" value={query} onChange={e=>{setQuery(e.target.value);setLimit(24)}}/>
    {!projects.length&&<Empty title={query?'没有找到匹配项目':archived?'暂无已归档项目':'暂无当前项目'}/>}
    <div className="project-grid">
      {projects.slice(0,limit).map(p => {
        const st = projectStats(data, p.id);
        const last = st.tasks.map(t => t.updated_at).sort().pop() || p.updated_at;
        return <button key={p.id} className="project-card" onClick={() => s.go({ page: 'projects', id: p.id })}>
          <div className="pc-head"><strong>{p.name}</strong>{p.archived&&<Pill tone="quiet">已归档</Pill>}{st.yours > 0 && <Pill tone="you">{st.yours} 件等你</Pill>}</div>
          <p className="pc-goal">{p.goal || '还没写项目目标'}</p>
          <dl className="pc-stats">
            <div><dt>进行中</dt><dd>{st.working}</dd></div>
            <div><dt>已完成</dt><dd>{st.done}</dd></div>
            <div><dt>全部任务</dt><dd>{st.tasks.length}</dd></div>
          </dl>
          <p className="pc-foot"><span>{p.stage || '阶段未填写'}</span><span>{relative(last, s.tz)}有动静</span></p>
        </button>;
      })}
    </div>

    {projects.length>limit&&<button className="btn ghost" onClick={()=>setLimit(limit+24)}>显示更多（共 {projects.length} 个）</button>}
    {!archived&&!query&&suggestions.length > 0 && <Section title={<><FolderSearch size={19} />Agent 最近在这些文件夹工作过</>} label="发现的文件夹">
      <p className="muted">从会话记录中发现的项目。登记后，相关会话会自动归入项目。</p>
      <div className="suggest-list">
        {suggestions.map(f => <div key={f.path} className="suggest">
          <div><strong>{f.name}</strong><code>{f.path}</code><small>{f.count} 个会话 · {f.agents.map(a => agentLabel(s.name, a)).join('、')} · 最近 {relative(f.last, s.tz)}</small></div>
          <button className="btn small" onClick={() => s.openDialog('project-register', { preset: { name: f.name, path: f.path } })}>登记为项目</button>
        </div>)}
      </div>
    </Section>}
  </div>;
}

export function ProjectView({ id }: { id: string }) {
  const s = useStore();
  const { data, route } = s;
  const p = (data.projects as R[]).find(x => x.id === id);
  if (!p) return <div className="page-wrap"><Empty title="找不到这个项目" action={<button className="btn" onClick={() => s.go({ page: 'projects' })}>回到项目列表</button>} /></div>;
  const st = projectStats(data, p.id);
  const runIds = new Set((data.runs as R[]).filter(r => st.tasks.some(t => t.id === r.task_id)).map(r => r.id));
  const files = (data.artifacts as R[]).filter(a => runIds.has(a.run_id));
  const diagrams = (data.diagrams as R[]).filter(d => d.project_id === p.id);
  const memories = (data.memories as R[]).filter(m => m.project_id === p.id);
  const tab = route.tab || 'progress';
  return <div className="page-wrap">
    <button className="crumb" onClick={() => s.go({ page: 'projects',tab:p.archived?'archived':'active' })}><ArrowLeft size={15} />全部项目</button>
    <header className="page-head project-head">
      <div>
        <h1>{p.name}{p.archived&&<> <Pill tone="quiet">已归档</Pill></>}</h1>
        <p>{p.goal || '还没写项目目标'}</p>
        <div className="head-facts">
          <span><small>现在阶段</small>{p.stage || '未填写'}</span>
          <span><small>下一步</small>{p.next_step || '未填写'}</span>
        </div>
      </div>
      <div className="head-actions">
        <button className="btn" onClick={() => s.openDialog('project-edit', { project: p })}><PencilLine size={16} />编辑资料</button>
        <button className="btn" onClick={()=>s.openDialog('project-archive',{project:p})}>{p.archived?<RotateCcw size={16}/>:<Archive size={16}/>} {p.archived?'恢复项目':'归档项目'}</button>
        <button className="btn primary" disabled={!!p.archived} onClick={() => s.openDialog('request', { projectId: p.id })}><Plus size={17} />提需求</button>
      </div>
    </header>
    <Tabs label="项目内容" value={tab} onChange={s.setTab} tabs={[['progress', '进展', st.yours || undefined], ['files', '成果', files.length || undefined], ['diagrams', '图解', diagrams.length || undefined], ['memory', '经验', memories.length || undefined], ['folders', '文件夹与资料']]} />
    {tab === 'progress' && <Progress project={p} tasks={st.tasks} />}
    {tab === 'files' && <Files files={files} />}
    {tab === 'diagrams' && <Diagrams project={p} diagrams={diagrams} />}
    {tab === 'memory' && <Memories project={p} memories={memories} />}
    {tab === 'folders' && <Folders project={p} />}
  </div>;
}

function Progress({ project, tasks }: { project: R; tasks: R[] }) {
  const s = useStore();
  const requests = (s.data.requests as R[]).filter(q => q.project_id === project.id && ['draft','awaiting_planning'].includes(q.status));
  const active = tasks.filter(t => !['accepted', 'cancelled', 'rework_linked'].includes(t.status)).sort(byUrgency);
  const finished = tasks.filter(t => ['accepted', 'cancelled', 'rework_linked'].includes(t.status)).sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)));
  const [showAll, setShowAll] = useState(false);
  if (!tasks.length && !requests.length) return <Empty icon={<Lightbulb size={28} />} title="这个项目还没有任务" action={!project.archived&&<button className="btn primary" onClick={() => s.openDialog('request', { projectId: project.id })}>提第一个需求</button>}>提一个需求，Codex 会把它拆成任务。</Empty>;
  return <>
    {requests.length > 0 && <Section title="需求">
      <div className="row-list">{requests.map(q => <div key={q.id} className="row static req-row">
        <Pill tone={q.status==='draft'?'quiet':'you'}>{q.status==='draft'?'待开始':'等待规划'}</Pill>
        <div className="row-main"><RequestPreview request={q}/><small>{relative(q.updated_at||q.created_at, s.tz)}更新</small></div>
        {!project.archived&&<span className="row-tools">
          {q.status==='awaiting_planning'&&<button className="btn small" disabled={s.busy} onClick={() => void copyPlanning(s, q)}><Copy size={15} />复制规划请求</button>}
          {q.status==='draft'&&<button className="btn small" disabled={s.busy} onClick={()=>void startPlanning(s,q)}>现在开始</button>}
          <button className="btn small" onClick={()=>s.openDialog('request',{request:q})}><PencilLine size={15}/>编辑</button>
          <button className="btn small ghost" onClick={()=>s.openDialog('request-action',{request:q,action:'delete'})}>删除</button>
        </span>}
      </div>)}</div>
    </Section>}
    {active.length > 0 && <Section title="执行顺序" label="执行顺序">
      <ExecutionList tasks={active}/>
    </Section>}
    {finished.length > 0 && <Section title="已经结束">
      <div className="row-list">{(showAll ? finished : finished.slice(0, 6)).map(t => <TaskRow key={t.id} t={t} />)}</div>
      {finished.length > 6 && !showAll && <button className="btn ghost" onClick={() => setShowAll(true)}>显示全部 {finished.length} 项</button>}
    </Section>}
  </>;
}

export function TaskRow({ t }: { t: R }) {
  const s = useStore();
  const who = s.executorOf(t);
  const relay = relayOf(t, s.name, who);
  return <button className="row" onClick={() => s.openTask(t.id)}>
    <RelayTrack relay={relay} compact />
    <span className="row-main"><strong>{t.title}</strong><small>{relay.headline}</small></span>
    <span className="row-side"><OrderStep task={t}/><OrderStatus task={t}/></span>
  </button>;
}

function Files({ files }: { files: R[] }) {
  const s = useStore();
  const runs = new Map<string, R>((s.data.runs as R[]).map(r => [r.id, r]));
  const tasks = new Map<string, R>((s.data.tasks as R[]).map(t => [t.id, t]));
  const [q, setQ] = useState('');
  const shown = files.filter(f => !q || (f.label + (tasks.get(runs.get(f.run_id)?.task_id)?.title || '')).toLowerCase().includes(q.toLowerCase()))
    .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
  if (!files.length) return <Empty icon={<FileText size={28} />} title="还没有成果">执行者交付后，文件会归档在这里，随时可以打开。</Empty>;
  return <>
    <input className="filter-input" placeholder="按文件名或任务筛选" value={q} onChange={e => setQ(e.target.value)} aria-label="筛选成果" />
    <div className="file-grid">
      {shown.map(f => { const t = tasks.get(runs.get(f.run_id)?.task_id); return <div key={f.id} className="file-card"><button className="artifact-preview" onClick={() => s.openDialog('artifact', { artifact: f })}>
        <span className="file-ext">{(f.extension || '?').replace('.', '').toUpperCase() || '文件'}</span>
        <strong>{f.label}</strong>
        <small>{t?.title || '未知任务'}</small>
        <small>{bytes(f.size)} · {relative(f.created_at, s.tz)}{t && t.current_run_id !== f.run_id ? ' · 之前的执行' : ''}</small>
      </button><ArtifactLocation artifact={f} compact/></div>; })}
    </div>
  </>;
}

function Diagrams({ project, diagrams }: { project: R; diagrams: R[] }) {
  const s = useStore();
  const [busy, setBusy] = useState(false);
  const list = [...diagrams].sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
  const generate = async () => {
    setBusy(true);
    const d = await s.act(() => api('/diagrams', { project_id: project.id }), '项目总览图已生成并保存');
    setBusy(false);
    if (d) s.openDialog('diagram', { diagram: d });
  };
  return <>
    <div className="banner">
      <Network size={22} />
      <div><strong>用一张图看懂项目</strong><p>“项目总览”由 Archify 根据已保存的任务在本机画出。架构图、流程图可以让 Codex 读代码后通过工作台接口提交。每张图保留生成那一刻的内容。</p></div>
      <button className="btn primary" disabled={busy} onClick={() => void generate()}>{busy ? '正在生成并检查…' : '生成项目总览'}</button>
    </div>
    {list.length ? <div className="diagram-grid">{list.map(d => <button key={d.id} className="diagram-card" onClick={() => s.openDialog('diagram', { diagram: d })}>
      <Network size={20} /><strong>{d.title}</strong><small>{d.source === 'ledger_snapshot' ? '任务总览' : 'Codex 绘制'} · {fullDate(d.created_at, s.tz)}</small>
    </button>)}</div> : <Empty title="还没有图解">点上面的按钮生成第一张。</Empty>}
  </>;
}

const kindText: R = { decision: '决定', known_issue: '已知问题', failed_attempt: '走过的弯路', handoff: '接着做的入口' };
function Memories({ project, memories }: { project: R; memories: R[] }) {
  const s = useStore();
  const sorted = [...memories].sort((a, b) => (a.status === 'superseded' ? 1 : 0) - (b.status === 'superseded' ? 1 : 0) || String(b.created_at).localeCompare(String(a.created_at)));
  const source = (id: string) => (s.data.tasks as R[]).find(t => t.id === id)?.title || (s.data.sessions as R[]).find(x => x.id === id)?.title || id;
  return <>
    <div className="banner quiet">
      <Lightbulb size={22} />
      <div><strong>项目经验</strong><p>记下已确定的决定、遇到的问题和下次继续的位置。</p></div>
      <button className="btn" onClick={() => s.openDialog('memory', { projectId: project.id })}><Plus size={16} />记一条</button>
    </div>
    {sorted.length ? <div className="memory-list">{sorted.map(m => <article key={m.id} className={'memory m-' + m.status}>
      <div className="memory-top"><b>{kindText[m.kind] || m.kind}</b><Pill tone={m.status === 'confirmed' ? 'done' : m.status === 'candidate' ? 'review' : 'quiet'}>{m.status === 'confirmed' ? '已确认' : m.status === 'candidate' ? '候选' : '已被取代'}</Pill></div>
      <p>{m.content}</p>
      <small>来自：{source(m.source_id)} · {relative(m.created_at, s.tz)}</small>
    </article>)}</div> : <Empty title="还没有记录">完成任务后，记一条经验，下次接着做会轻松很多。</Empty>}
  </>;
}

function Folders({ project }: { project: R }) {
  const s = useStore();
  const sessions = (s.data.sessions as R[]).filter(x => x.project_id === project.id).sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)));
  return <>
    <Section title="项目文件夹">
      <div className="path-list">{project.paths.map((path: string, i: number) => <div key={path} className="path-row">
        <FolderOpen size={18} /><code>{path}</code>
        <span className="path-actions">
          {i === 0 && <button className="btn small" onClick={() => void s.act(() => api('/projects/' + project.id + '/open', {}), '已在资源管理器中打开')}>打开</button>}
          <button className="btn small ghost" onClick={() => void s.copy(path, '路径已复制')}><Copy size={14} />复制</button>
        </span>
      </div>)}</div>
      <div className="tool-row">
        <button className="btn small" onClick={() => s.openDialog('project-path', { project })}><Link2 size={15} />关联另一个文件夹</button>
        <a className="btn small" href={'/api/projects/' + project.id + '/context?download=1'} download><Download size={15} />导出项目上下文</a>
      </div>
      <p className="muted small">“导出项目上下文”会生成一个文件，里面有目标、任务、经验和最近会话，可以交给新的 Agent 快速了解项目。</p>
    </Section>
    <Section title={<><MessagesSquare size={18} />关联的会话 <span className="count">{sessions.length}</span></>} label="关联的会话">
      {sessions.length ? <div className="row-list">{sessions.slice(0, 20).map(x => <button key={x.id} className="row" onClick={() => s.openDialog('session', { session: x })}>
        <span className="row-main"><strong>{x.title || x.native_id}</strong><small>{agentLabel(s.name, x.agent)} · {relative(x.updated_at, s.tz)}</small></span>
      </button>)}</div> : <Notice>还没有会话归到这个项目。会话的工作文件夹和项目文件夹一致时会自动归入。</Notice>}
      {sessions.length > 20 && <button className="btn ghost" onClick={() => s.go({ page: 'records' })}>在“记录”里查看全部</button>}
    </Section>
  </>;
}
