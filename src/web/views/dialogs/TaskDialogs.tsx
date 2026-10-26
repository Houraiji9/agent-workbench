// 需求、计划、回执、审查、确认、改派、取消与成果预览。
import React, { useEffect, useId, useRef, useState } from 'react';
import { isModelRetired } from '../../../shared/model-policy.js';
import { Copy, Download, CircleCheckBig } from 'lucide-react';
import { api } from '../../api.js';
import { useStore } from '../../app/store.js';
import type { R } from '../../lib/flow.js';
import { bytes, fullDate } from '../../lib/format.js';
import { Dialog, Field, Notice } from '../../ui/kit.js';
import { MarkdownText } from '../../ui/TextView.js';
import { userAcceptanceItems } from '../../../core/acceptance.js';
import { useSubmit, parseJson } from './useSubmit.js';
import {copyOrderText,copyRework} from '../actions.js';
import {ArtifactLocation} from '../../ui/ArtifactLocation.js';

const Foot = ({ onClose, saving, label, cancel = '取消', disabled }: { onClose(): void; saving: boolean; label: string; cancel?: string; disabled?: boolean }) => <>
  <button type="button" className="btn ghost" onClick={onClose}>{cancel}</button>
  <button type="submit" className="btn primary" disabled={saving || disabled}>{saving ? '正在保存…' : label}</button>
</>;

export {RequestDialog} from './RequestDialog.js';

export function ImportPlanDialog({ onClose }: { onClose(): void }) {
  const [text, setText] = useState('');
  const { error, saving, run } = useSubmit();
  return <Dialog title="粘贴 Codex 的计划" sub="通常 Codex 会通过工作台接口直接提交；只有它把计划发给你时才需要粘贴。" onClose={onClose} label="导入计划">
    <form className="form" onSubmit={e => { e.preventDefault(); void run(() => api('/plans', parseJson(text)), '计划已收下，任务已经排好'); }}>
      <Field label="计划内容（JSON）" hint="工作台会检查执行者职责、依赖、路径和预算，不符合要求会说明原因。">
        <textarea data-autofocus className="mono" required rows={14} value={text} onChange={e => setText(e.target.value)} />
      </Field>
      {error && <Notice tone="error">{error}</Notice>}
      <footer className="dialog-foot inline"><Foot onClose={onClose} saving={saving} label="导入计划" /></footer>
    </form>
  </Dialog>;
}

export function ReceiptDialog({ onClose }: { onClose(): void }) {
  const s = useStore();
  const [text, setText] = useState('');
  const { error, setError, saving, run } = useSubmit();
  return <Dialog title="导入回执" sub="云端 Agent 没法写入本机时，会把回执内容发给你，粘贴到这里即可。" onClose={onClose} label="导入回执">
    <form className="form" onSubmit={e => { e.preventDefault(); void run(async () => {
      const r = await api('/receipts', parseJson(text));
      if (r.disposition === 'rejected') { setError('回执已留档，但没有改变状态：' + r.error); throw new Error('回执已留档，但没有改变状态：' + r.error); }
      s.toast(r.disposition === 'pending' ? '回执已收下，等前面的回报到齐后处理' : '回执已核对并记入');
      return r;
    }); }}>
      <Field label="回执内容（JSON）">
        <textarea data-autofocus className="mono" required rows={12} value={text} onChange={e => setText(e.target.value)} />
      </Field>
      {error && <Notice tone="error">{error}</Notice>}
      <footer className="dialog-foot inline"><Foot onClose={onClose} saving={saving} label="导入回执" /></footer>
    </form>
  </Dialog>;
}

export function ReviewDialog({ detail, onClose }: { detail: R; onClose(): void }) {
  const s = useStore();
  const [t] = useState(detail.task);
  const [artifacts] = useState<R[]>(() => detail.artifacts.filter((a: R) => a.run_id === detail.task.current_run_id && a.current));
  const [performed, setPerformed] = useState(false);
  const [verdict, setVerdict] = useState('');
  const [evidence, setEvidence] = useState('');
  const [findings, setFindings] = useState('');
  const { error, saving, run } = useSubmit();
  return <Dialog title="登记审查结果" sub={`任务：${t.title}。审查者：${s.name(t.reviewer_id)}。只登记这项任务的审查。`} onClose={onClose} label="登记审查结果">
    <form className="form" onSubmit={e => { e.preventDefault(); void run(() => api('/reviews', {
      task_id:t.id, revision:t.revision, run_id: t.current_run_id, reviewer_id: t.reviewer_id, performed, evidence, findings, verdict,
      artifact_hashes: artifacts.map(a => a.sha256),
    }), '审查结果已登记'); }}>
      <fieldset className="radio-cards" aria-label="审查结论">
        <legend className="field-label">它的结论</legend>
        <label className={verdict === 'passed' ? 'on ok' : ''}><input type="radio" name="verdict" required checked={verdict === 'passed'} onChange={() => setVerdict('passed')} />通过</label>
        <label className={verdict === 'changes_requested' ? 'on bad' : ''}><input type="radio" name="verdict" checked={verdict === 'changes_requested'} onChange={() => setVerdict('changes_requested')} />需要修改</label>
      </fieldset>
      <Field label="审查依据" hint="比如它的会话编号、审查报告放在哪里。至少 10 个字。"><textarea required minLength={10} rows={3} value={evidence} onChange={e => setEvidence(e.target.value)} /></Field>
      <Field label="它提出的问题（可选）"><textarea rows={3} value={findings} onChange={e => setFindings(e.target.value)} /></Field>
      <label className="check"><input type="checkbox" required checked={performed} onChange={e => setPerformed(e.target.checked)} />我确认独立审查者已审查这项任务的当前成果</label>
      <details className="fold"><summary>这次审查对应的文件（{artifacts.length} 个）</summary>
        {artifacts.map(a => <p key={a.id} className="small"><b>{a.label}</b><br /><code className="hash">{a.sha256}</code></p>)}
        <p className="muted small">本次审查对应当前交付版本。</p>
      </details>
      {error && <Notice tone="error">{error}</Notice>}
      <footer className="dialog-foot inline"><Foot onClose={onClose} saving={saving} label="登记结果" /></footer>
    </form>
  </Dialog>;
}

export function GrokReviewDialog({detail,onClose}:{detail:R;onClose():void}){
  const [task]=useState(detail.task),[session,setSession]=useState('');
  const {error,saving,run}=useSubmit();
  return <Dialog title="读取 Grok 审查" sub={task.title} onClose={onClose} label="读取 Grok 审查">
    <form className="form" onSubmit={e=>{e.preventDefault();void run(()=>api('/reviews/grok',{run_id:task.current_run_id,session_id:session.trim()}),'Grok 审查已核验并登记')}}>
      <p>填写实际完成审查的 Grok 会话编号。工作台会读取原始结论，核对任务和交付版本。</p>
      <Field label="Grok 会话编号"><input required value={session} onChange={e=>setSession(e.target.value)} placeholder="审查工具返回的 sessionId"/></Field>
      <p className="muted small">执行 Agent 可通过工作台接口自动回传，无需你粘贴报告。旧报告没有版本绑定时，需要先由 Grok 补充确认。</p>
      {error&&<Notice tone="error">{error}</Notice>}
      <footer className="dialog-foot inline"><Foot onClose={onClose} saving={saving} label="读取并登记"/></footer>
    </form>
  </Dialog>;
}

export function RevokeReviewDialog({detail,review,onClose}:{detail:R;review:R;onClose():void}){
  const [task]=useState(detail.task),[reason,setReason]=useState('');
  const {error,saving,run}=useSubmit();
  return <Dialog title="撤回误登记的审查" sub={task.title} onClose={onClose} label="撤回审查">
    <form className="form" onSubmit={e=>{e.preventDefault();void run(()=>api('/reviews/'+review.id+'/revoke',{run_id:task.current_run_id,revision:task.revision,reason}),'误登记已撤回，原记录和原因已保留')}}>
      <p>这条记录将保留，并注明已撤回。如果它是最新审查，任务会恢复为等待审查。</p>
      <Field label="撤回原因"><textarea required minLength={5} maxLength={2000} value={reason} onChange={e=>setReason(e.target.value)} placeholder="例如：误贴了另一项任务的报告"/></Field>
      {error&&<Notice tone="error">{error}</Notice>}
      <footer className="dialog-foot inline"><Foot onClose={onClose} saving={saving} label="撤回这条审查"/></footer>
    </form>
  </Dialog>;
}

export function AcceptDialog({ detail, onClose }: { detail: R; onClose(): void }) {
  const s=useStore();
  const formId=useId();
  const [t] = useState(detail.task);
  const [items] = useState<string[]>(() => userAcceptanceItems(detail.task));
  const [hashes] = useState<string[]>(() => detail.artifacts.filter((a: R) => a.run_id === detail.task.current_run_id && a.current).map((a: R) => a.sha256));
  const [checks, setChecks] = useState<boolean[]>(() => items.map(() => false));
  const [preview,setPreview]=useState<R|null>(null);
  const { error, saving, run } = useSubmit();
  const current=detail.artifacts.filter((a:R)=>a.run_id===t.current_run_id&&a.current);
  if(preview)return <ArtifactDialog key={preview.id} artifact={preview} onClose={()=>setPreview(null)} backLabel="返回试用确认"/>;
  return <Dialog title="试用后确认完成" sub="打开成果并亲自试用后，再逐项确认。" onClose={onClose} label="确认完成" footer={<>
    <button type="button" className="btn danger" disabled={saving||!hashes.length} onClick={()=>s.openDialog('reject',{detail})}>不通过，退回修改</button>
    <button type="button" className="btn ghost" disabled={saving} onClick={onClose}>稍后再说</button>
    <button type="submit" form={formId} className="btn primary" disabled={saving||!hashes.length||!checks.every(Boolean)}>{saving?'正在保存…':'确认结果符合需求'}</button>
  </>}>
    <div className="trial-context"><span className="muted small">{s.pname(t.project_id)}</span><strong>{t.title}</strong></div>
    <section aria-label="本次可查看的成果"><h3 className="trial-section-title">本次成果（{current.length}）</h3>
      <div className="trial-artifacts">{current.map((a:R)=><div className="trial-artifact" key={a.id}>
        <button className="link" type="button" onClick={()=>setPreview(a)}>查看成果：{a.label}</button>
        <ArtifactLocation artifact={a} compact/>
      </div>)}</div>
      {!current.length&&<Notice tone="warn">本次成果尚未就绪，请稍后再确认。</Notice>}
    </section>
    <form id={formId} className="form" onSubmit={e => { e.preventDefault(); if(saving||!hashes.length||!checks.every(Boolean))return; void run(() => api('/tasks/' + t.id + '/accept', {
      revision: t.revision, artifact_hashes: hashes, mode: 'user_experience', user_checks: checks,
    }), '已确认完成，成果已归档'); }}>
      <h3 className="trial-section-title">请你逐项确认</h3><div className="confirm-list">
        {items.map((a, i) => <label key={i} className="check big"><input type="checkbox" required checked={checks[i]} onChange={e => setChecks(c => c.map((x, n) => n === i ? e.target.checked : x))} />{a}</label>)}
      </div>
      {!t.user_acceptance?.length && <p className="muted small">这项任务没有单独写确认项，以上是通用的确认内容。</p>}
      
      {error && <Notice tone="error">{error}</Notice>}
    </form>
  </Dialog>;
}

export function RejectDialog({detail,onClose}:{detail:R;onClose():void}){
 const s=useStore(),[t]=useState(detail.task),[note,setNote]=useState(''),[saved,setSaved]=useState<R|null>(null);
 const [hashes]=useState(()=>detail.artifacts.filter((a:R)=>a.run_id===t.current_run_id&&a.current).map((a:R)=>a.sha256));
 const {error,saving,run}=useSubmit();
 if(saved)return <Dialog title="已记录不通过" onClose={onClose} footer={<button className="btn ghost" onClick={onClose}>关闭</button>}><p className="lead">把返工要求发给 {s.name(s.executorOf(saved))}，让它按你的意见修改。</p><blockquote className="agent-says">{note}</blockquote><button className="btn primary" disabled={s.busy} onClick={()=>void copyRework(s,saved)}><Copy size={16}/>复制返工要求</button></Dialog>;
 return <Dialog title="不通过，退回修改" sub={`这次的成果和记录都会保留；写下意见后，复制返工要求发给 ${s.name(s.executorOf(t))}。`} onClose={onClose}><form className="form" onSubmit={e=>{e.preventDefault();void run(async()=>{const r=await api('/tasks/'+t.id+'/reject',{revision:t.revision,run_id:t.current_run_id,note,artifact_hashes:hashes});setSaved(r.task);return r},'已记录不通过',false)}}><Field label="哪里不符合你的要求？"><textarea data-autofocus required rows={5} maxLength={10000} placeholder="用自己的话说明，例如：卡片太高，按钮不容易找到。" value={note} onChange={e=>setNote(e.target.value)}/></Field>{error&&<Notice tone="error">{error}</Notice>}<footer className="dialog-foot inline"><Foot onClose={onClose} saving={saving} label="确认不通过" disabled={!note.trim()}/></footer></form></Dialog>;
}

export function RetryDialog({ detail, onClose }: { detail: R; onClose(): void }) {
  const s = useStore();
  const [t] = useState(detail.task);
  const options = (s.data.agents as R[]).filter(a => !a.archived && a.allowed_kinds.includes(t.work_kind) && a.id !== t.reviewer_id);
  const [agent, setAgent] = useState(() => {
    const current = s.executorOf(t), merged = (s.data.agents as R[]).find(a => a.id === current)?.merged_into || current;
    return options.some(a => a.id === merged) ? merged : '';
  });
  const currentRun = detail.runs.find((r:R) => r.id === t.current_run_id);
  const [model, setModel] = useState(currentRun ? (currentRun.requested_model ?? '') : (t.requested_model ?? ''));
  const models = (s.data.model_catalog || []).find((g:R) => g.agent_id === agent)?.models.filter((m:R) => !isModelRetired(m,s.tz) && (agent !== 'antigravity' || !m.id.startsWith('Claude ') || t.work_kind === 'frontend_light')) || [];
  const modelValue = models.some((m:R) => m.id === model) ? model : '';
  const { error, saving, run } = useSubmit();
  const blocked = !!t.current_run_id && !['submitted', 'failed', 'cancelled'].includes(detail.runs.find((r: R) => r.id === t.current_run_id)?.status);
  return <Dialog title="换人或重新做一次" sub="会新开一次执行，之前的执行单、回执和成果都保留。" onClose={onClose} label="重新执行">
    <form className="form" onSubmit={e => { e.preventDefault(); if (blocked || !options.some(a => a.id === agent)) return; void run(async () => {
      const r = await api('/tasks/' + t.id + '/export', { version: t.version, new_run: true, agent_id: agent, expected_revision: t.revision, requested_model: modelValue || null });
      s.closeDialog();
      await copyOrderText(s,r.entry, `新的执行单已复制，发给 ${s.name(agent)} 后记得点“我已经发给它”`,t);
      return r;
    },undefined,false); }}>
      <fieldset className="agent-pick" aria-label="交给谁">
        <legend className="field-label">交给谁</legend>
        {options.map(a => <label key={a.id} className={agent === a.id ? 'on' : ''}>
          <input type="radio" name="agent" checked={agent === a.id} onChange={() => {setAgent(a.id);setModel('')}} />
          <span><b>{a.name}</b><small>{a.scope}</small></span>
        </label>)}
      </fieldset>
      {agent && <Field label="指定模型（可选）"><select value={modelValue} onChange={e=>setModel(e.target.value)}><option value="">由执行者选择</option>{models.map((m:R)=><option key={m.id} value={m.id}>{m.name}</option>)}</select></Field>}
      {blocked && <Notice tone="warn">当前执行还没结束。先取消这次执行，再重新打开这里派单。旧记录都会保留；如果对方仍在工作，也请在它的对话里告诉它停下。
        <span className="notice-actions"><button type="button" className="btn small" onClick={() => s.openDialog('cancel', { detail })}>先取消当前执行</button></span>
      </Notice>}
      {error && <Notice tone="error">{error}</Notice>}
      <footer className="dialog-foot inline"><Foot onClose={onClose} saving={saving} disabled={blocked || !options.some(a => a.id === agent)} label="新开一次并复制执行单" /></footer>
    </form>
  </Dialog>;
}

export function CancelDialog({ detail, onClose }: { detail: R; onClose(): void }) {
  const [t] = useState(detail.task);
  const { error, saving, run } = useSubmit();
  return <Dialog title="取消这项任务？" onClose={onClose} label="取消任务">
    <form className="form" onSubmit={e => { e.preventDefault(); void run(() => api('/tasks/' + t.id + '/action', { action: 'cancel', revision: t.revision }), '任务已取消，记录都保留着'); }}>
      <p>“{t.title}”会标记为已取消。已经发生的执行、回执和成果都会保留，之后仍可以换人重新做。</p>
      <p className="muted small">如果执行者还在做，请也在它的对话里告诉它停下——工作台无法替你通知它。</p>
      {error && <Notice tone="error">{error}</Notice>}
      <footer className="dialog-foot inline">
        <button type="button" className="btn ghost" onClick={onClose}>不取消</button>
        <button type="submit" className="btn danger" disabled={saving}>{saving ? '正在取消…' : '确认取消任务'}</button>
      </footer>
    </form>
  </Dialog>;
}

const imageExt = ['.png', '.jpg', '.jpeg', '.webp', '.gif'];
const htmlExt = ['.html', '.htm'];
const textExt = ['.md', '.txt', '.json', '.csv', '.diff', '.patch', ''];

export function ArtifactDialog({ artifact: a, onClose, backLabel }: { artifact: R; onClose(): void;backLabel?:string }) {
  const s = useStore();
  const [text, setText] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [raw, setRaw] = useState(false);
  const alive = useRef(true);
  const kind = imageExt.includes(a.extension) ? 'image' : htmlExt.includes(a.extension) ? 'html' : textExt.includes(a.extension) ? 'text' : 'file';
  useEffect(() => {
    alive.current = true;
    if (kind === 'text') fetch('/api/artifacts/' + a.id + '/content').then(async r => {
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || '读取失败');
      const t = await r.text();
      if (alive.current) setText(t.length > 250000 ? t.slice(0, 250000) + '\n\n（内容太长，只显示前一部分，请下载查看完整文件。）' : t);
    }).catch(e => { if (alive.current) setError((e as Error).message); });
    return () => { alive.current = false; };
  }, [a.id, kind]);
  const isMd = a.extension === '.md';
  const pretty = text !== null && a.extension === '.json' ? (() => { try { return JSON.stringify(JSON.parse(text), null, 2); } catch { return text; } })() : text;
  return <Dialog wide title={a.label} sub={`${bytes(a.size)} · ${fullDate(a.created_at, s.tz)}${a.source === 'author_submitted' ? ' · 执行者提交' : ''}`} onClose={onClose} label="查看成果"
    footer={<>
      {backLabel&&<button className="btn" onClick={onClose}>{backLabel}</button>}
      {isMd && <button className="btn ghost" onClick={() => setRaw(!raw)}>{raw ? '排版显示' : '显示原文'}</button>}
      <a className="btn" href={'/api/artifacts/' + a.id + '/content?download=1'} download><Download size={16} />下载文件</a>
    </>}>
    <ArtifactLocation key={a.id} artifact={a}/>
    {error && <Notice tone="error">{error}</Notice>}
    {kind === 'image' && <img className="preview-img" alt={a.label} src={'/api/artifacts/' + a.id + '/content'} />}
    {kind === 'html' && <><p className="muted small">网页成果在隔离环境中打开：脚本、表单和网络都已禁用。</p><iframe className="preview-frame" sandbox="" title={a.label} src={'/api/artifacts/' + a.id + '/content'} /></>}
    {kind === 'text' && (text === null && !error ? <p className="muted">正在读取…</p> : text !== null && (isMd && !raw ? <MarkdownText text={text} /> : <pre className="pre">{pretty}</pre>))}
    {kind === 'file' && <p>这种文件不能在工作台里预览，请下载后用对应的软件打开。</p>}
    <details className="fold"><summary>文件指纹与来源</summary><p className="small">SHA256 <code className="hash">{a.sha256}</code></p>{a.original_path && <p className="small">原始位置 <code>{a.original_path}</code></p>}</details>
  </Dialog>;
}
