// 项目登记、资料编辑、目录关联、授权文件夹、项目记忆与图解预览。
import React, { useState } from 'react';
import { Download, ShieldPlus } from 'lucide-react';
import { api } from '../../api.js';
import { useStore } from '../../app/store.js';
import type { R } from '../../lib/flow.js';
import { fullDate } from '../../lib/format.js';
import { Dialog, Field, Notice } from '../../ui/kit.js';
import { useSubmit } from './useSubmit.js';
import { DeliveryProfileFields, ImportanceField, deliverySummary } from '../../ui/DeliveryProfileFields.js';
import type { DeliveryProfile } from '../../../core/delivery-profile.ts';
import { deliveryForView } from '../../../shared/delivery-view.js';

const Foot = ({ onClose, saving, label, disabled }: { onClose(): void; saving: boolean; label: string; disabled?: boolean }) => <footer className="dialog-foot inline">
  <button type="button" className="btn ghost" onClick={onClose}>取消</button>
  <button type="submit" className="btn primary" disabled={saving || disabled}>{saving ? '正在保存…' : label}</button>
</footer>;

const outside = (msg: string) => /超出授权/.test(msg);

export function RegisterProjectDialog({ preset, onClose }: { preset?: R; onClose(): void }) {
  const s = useStore();
  const [mode, setMode] = useState<'register' | 'create'>('register');
  const [name, setName] = useState(preset?.name || '');
  const [path, setPath] = useState(preset?.path || '');
  const [goal, setGoal] = useState('');
  const { error, setError, saving, run } = useSubmit();
  const submit = () => run(async () => {
    const p = await api('/projects', { name, path, goal, create: mode === 'create' });
    s.go({ page: 'projects', id: p.id });
    return p;
  }, '项目已登记');
  const authorize = () => run(async () => {
    const p = await api('/projects/authorize', { name, path, goal, create: mode === 'create' });
    s.go({ page: 'projects', id: p.id });
    return p;
  }, '项目已登记，授权范围仅包含所选文件夹');
  return <Dialog title={preset ? '登记为项目' : '添加项目'} sub="登记已有文件夹，或在授权范围里新建一个。" onClose={onClose} label="添加项目">
    <form className="form" onSubmit={e => { e.preventDefault(); void submit(); }}>
      {!preset && <div className="seg" role="radiogroup" aria-label="方式">
        <button type="button" role="radio" aria-checked={mode === 'register'} className={mode === 'register' ? 'on' : ''} onClick={() => setMode('register')}>登记已有文件夹</button>
        <button type="button" role="radio" aria-checked={mode === 'create'} className={mode === 'create' ? 'on' : ''} onClick={() => setMode('create')}>新建文件夹</button>
      </div>}
      <Field label="项目名称"><input data-autofocus required maxLength={199} value={name} onChange={e => setName(e.target.value)} placeholder="例如：记账 APP" /></Field>
      <Field label={mode === 'create' ? '新文件夹的完整路径' : '文件夹的完整路径'} hint={<>在资源管理器地址栏里复制即可，例如 {s.data.authorized_roots[0]}</>}>
        <input required value={path} onChange={e => setPath(e.target.value)} placeholder="E:\项目\..." />
      </Field>
      <Field label="项目目标（可选）"><textarea rows={3} maxLength={5000} value={goal} onChange={e => setGoal(e.target.value)} placeholder="一两句话说清楚这个项目要做成什么" /></Field>
      {error && <Notice tone="error">{outside(error) ? <>这个文件夹还不在工作台的授权范围里。授权后，规划者和执行者才能在其中工作。
        <span className="notice-actions"><button type="button" className="btn small" disabled={saving} onClick={() => void authorize()}><ShieldPlus size={15} />{saving ? '正在授权…' : '授权这个文件夹并登记'}</button></span></> : error}</Notice>}
      <Foot onClose={onClose} saving={saving} label={mode === 'create' ? '新建并登记' : '登记项目'} />
    </form>
  </Dialog>;
}

export function AddRootDialog({ preset, onClose }: { preset?: string; onClose(): void }) {
  const [path, setPath] = useState(preset || '');
  const { error, saving, run } = useSubmit();
  return <Dialog title="授权一个文件夹" sub="选择允许工作台管理项目的文件夹。" onClose={onClose} label="授权文件夹">
    <form className="form" onSubmit={e => { e.preventDefault(); void run(() => api('/settings/roots', { path }), '文件夹已加入授权范围'); }}>
      <Field label="文件夹的完整路径" hint="不能是整个磁盘、系统目录或用户主目录。工作台自己的数据目录、.git 和凭据始终受保护。"><input data-autofocus required value={path} onChange={e => setPath(e.target.value)} placeholder="E:\项目\..." /></Field>
      {error && <Notice tone="error">{error}</Notice>}
      <Foot onClose={onClose} saving={saving} label="授权" />
    </form>
  </Dialog>;
}

export function EditProjectDialog({ project, onClose }: { project: R; onClose(): void }) {
  const [p] = useState(project);
  const [profile, setProfile] = useState<DeliveryProfile>(() => deliveryForView(p, p));
  const [importance, setImportance] = useState<'normal'|'critical'>((p.importance || 'normal') as 'normal'|'critical');
  const [v, setV] = useState({ name: p.name, goal: p.goal || '', stage: p.stage || '', next_step: p.next_step || '', source_root:p.source_root||p.paths[0]||'', workflow_mode:p.workflow_mode||'compact' });
  const { error, saving, run } = useSubmit();
  const set = (k: keyof typeof v) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => setV({ ...v, [k]: e.target.value });
  const portable = profile.deployment.mode === 'local' && profile.deployment.verification === 'portable_manifest';
  return <Dialog title="编辑项目资料" sub="用自己的话写就行，规划 Agent 规划时会读到。" onClose={onClose} label="编辑项目资料">
    <form className="form delivery-form" onInvalidCapture={e=>{
      // Native validation must reveal a required field before the browser focuses it.
      let ancestor=(e.target as HTMLElement).parentElement;
      while(ancestor&&ancestor!==e.currentTarget){if(ancestor instanceof HTMLDetailsElement)ancestor.open=true;ancestor=ancestor.parentElement;}
    }} onSubmit={e => { e.preventDefault(); void run(() => api('/projects/' + p.id + '/edit', { version: p.version, changes: {...v,source_root:v.source_root||null,runtime_root:portable?profile.deployment.target:null,importance,delivery_profile:profile} }), '项目资料已保存'); }}>
      <Field label="项目名称"><input data-autofocus required maxLength={199} value={v.name} onChange={set('name')} /></Field>
      <Field label="项目目标"><textarea rows={3} maxLength={5000} value={v.goal} onChange={set('goal')} /></Field>
      <ImportanceField value={importance} onChange={setImportance}/>
      <div className="delivery-brief"><p title={deliverySummary(profile)}>默认交付：{deliverySummary(profile)}</p></div>
      <details className="fold"><summary>修改默认交付</summary>
        <DeliveryProfileFields value={profile} onChange={setProfile}/>
      </details>
      <details className="fold"><summary>项目近况（可选）</summary>
        <Field label="现在处在什么阶段"><input maxLength={200} value={v.stage} onChange={set('stage')} /></Field>
        <Field label="下一步打算"><textarea rows={2} maxLength={2000} value={v.next_step} onChange={set('next_step')} /></Field>
      </details>
      <details className="fold"><summary>开发设置</summary>
        <Field label="源码目录"><input value={v.source_root} onChange={set('source_root')} /></Field>
        <Field label="执行资料"><select value={v.workflow_mode} onChange={e=>setV({...v,workflow_mode:e.target.value})}><option value="compact">简版与同会话增量</option><option value="full">完整执行资料</option></select></Field>
        <p className="muted small">只可使用本项目已关联范围内的目录。此设置不改变已有执行单，也不取消独立审查要求。</p>
      </details>
      {error && <Notice tone="error">{error}</Notice>}
      <Foot onClose={onClose} saving={saving} label="保存" />
    </form>
  </Dialog>;
}

export function ArchiveProjectDialog({project,onClose}:{project:R;onClose():void}){
 const s=useStore(),{error,saving,run}=useSubmit();
 return <Dialog title={project.archived?'恢复项目':'归档项目'} onClose={onClose} label="项目归档">
 <p>{project.archived?'恢复后会回到当前项目列表，可以继续提需求。':'归档后收进“已归档”列表，任务、成果和草稿都会保留，随时可以恢复。'}</p>
 <p><strong>{project.name}</strong></p>{error&&<Notice tone="error">{error}</Notice>}
 <div className="dialog-foot inline"><button className="btn ghost" onClick={onClose}>取消</button><button className="btn primary" disabled={saving} onClick={()=>void run(async()=>{const r=await api('/projects/'+project.id+'/archive',{version:project.version,archived:!project.archived});s.go({page:'projects',tab:project.archived?'active':'archived'});return r},project.archived?'项目已恢复':'项目已归档')}>{project.archived?'恢复项目':'确认归档'}</button></div></Dialog>
}

export function AddPathDialog({ project, onClose }: { project: R; onClose(): void }) {
  const [p] = useState(project);
  const [path, setPath] = useState('');
  const { error, saving, run } = useSubmit();
  return <Dialog title="关联另一个文件夹" sub={`项目“${p.name}”的文件分散在多处时使用。`} onClose={onClose} label="关联文件夹">
    <form className="form" onSubmit={e => { e.preventDefault(); void run(() => api('/projects/' + p.id + '/paths', { version: p.version, path }), '文件夹已关联'); }}>
      <Field label="文件夹的完整路径" hint="需要位于授权范围内，且没有被其他项目使用。"><input data-autofocus required value={path} onChange={e => setPath(e.target.value)} /></Field>
      {error && <Notice tone="error">{error}</Notice>}
      <Foot onClose={onClose} saving={saving} label="关联" />
    </form>
  </Dialog>;
}

const kinds: [string, string, string][] = [
  ['decision', '决定', '已经拍板的做法'],
  ['known_issue', '已知问题', '知道但还没解决的事'],
  ['failed_attempt', '走过的弯路', '试过但不行的方法'],
  ['handoff', '接着做的入口', '下次从哪里继续'],
];

export function MemoryDialog({ projectId, onClose }: { projectId: string; onClose(): void }) {
  const s = useStore();
  const tasks = (s.data.tasks as R[]).filter(t => t.project_id === projectId);
  const sessions = (s.data.sessions as R[]).filter(x => x.project_id === projectId).slice(-30);
  const memories = (s.data.memories as R[]).filter(m => m.project_id === projectId && !m.deleted_at && m.status !== 'superseded');
  const [kind, setKind] = useState('decision');
  const [status, setStatus] = useState('candidate');
  const [content, setContent] = useState('');
  const [source, setSource] = useState(tasks[tasks.length - 1]?.id || '');
  const [supersedes, setSupersedes] = useState('');
  const { error, saving, run } = useSubmit();
  return <Dialog title="记下一条项目经验" sub="每条都要说明来自哪项任务或会话，方便以后追溯。" onClose={onClose} label="记录项目经验">
    <form className="form" onSubmit={e => { e.preventDefault(); void run(() => api('/memories', { project_id: projectId, kind, status, content, source_id: source, ...(supersedes ? { supersedes } : {}) }), '已记下'); }}>
      <fieldset className="radio-cards four" aria-label="类型"><legend className="field-label">这是什么</legend>
        {kinds.map(([k, l, d]) => <label key={k} className={kind === k ? 'on' : ''}><input type="radio" name="kind" checked={kind === k} onChange={() => setKind(k)} /><b>{l}</b><small>{d}</small></label>)}
      </fieldset>
      <Field label="内容"><textarea data-autofocus required rows={4} maxLength={20000} value={content} onChange={e => setContent(e.target.value)} /></Field>
      <Field label="来自哪里">
        <select required value={source} onChange={e => setSource(e.target.value)}>
          <option value="">请选择</option>
          {tasks.length > 0 && <optgroup label="任务">{tasks.map(t => <option key={t.id} value={t.id}>{t.title}</option>)}</optgroup>}
          {sessions.length > 0 && <optgroup label="会话">{sessions.map(x => <option key={x.id} value={x.id}>{x.title}</option>)}</optgroup>}
        </select>
      </Field>
      <div className="seg" role="radiogroup" aria-label="确定程度">
        <button type="button" role="radio" aria-checked={status === 'candidate'} className={status === 'candidate' ? 'on' : ''} onClick={() => setStatus('candidate')}>先记为候选</button>
        <button type="button" role="radio" aria-checked={status === 'confirmed'} className={status === 'confirmed' ? 'on' : ''} onClick={() => setStatus('confirmed')}>我确认这是事实</button>
      </div>
      {memories.length > 0 && <Field label="它取代了哪条旧经验（可选）"><select value={supersedes} onChange={e => setSupersedes(e.target.value)}>
        <option value="">不取代</option>{memories.map(m => <option key={m.id} value={m.id}>{m.content.slice(0, 60)}</option>)}
      </select></Field>}
      {!tasks.length && !sessions.length && <Notice tone="warn">这个项目还没有任务或关联会话，暂时无法记录经验。</Notice>}
      {error && <Notice tone="error">{error}</Notice>}
      <Foot onClose={onClose} saving={saving} label="记下" disabled={!source} />
    </form>
  </Dialog>;
}

export function DiagramDialog({ diagram: d, onClose }: { diagram: R; onClose(): void }) {
  const s = useStore();
  return <Dialog wide title={d.title} sub={`${fullDate(d.created_at, s.tz)} 生成 · ${d.source === 'ledger_snapshot' ? '根据当时的任务记录' : 'Agent 绘制'}。图解保留生成那一刻的内容。`} onClose={onClose} label="项目图解"
    footer={<a className="btn" href={'/api/diagrams/' + d.id + '/content?download=1'} download><Download size={16} />下载图解</a>}>
    <iframe className="preview-frame tall" sandbox="allow-scripts" title={d.title} src={'/api/diagrams/' + d.id + '/content'} />
  </Dialog>;
}
