import React, { useState } from 'react';
import { api } from '../api.js';
import { useStore } from '../app/store.js';
import type { R } from '../lib/flow.js';
import { automationActive } from './AgentAutomationStatus.js';
import { Dialog, Field, Notice } from './kit.js';
import {processRecoveryText} from '../../shared/review-presentation.js';

type Operation = { mode: 'cancel' | 'recovery'; job: R };

export function AgentAutomationControls({ task, jobs = [] }: { task: R; jobs?: R[] }) {
  const s = useStore();
  const [operation, setOperation] = useState<Operation | null>(null);
  const [reason, setReason] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const [pending, setPending] = useState(false);
  const all = new Map(jobs.map(job => [job.job_id, job]));
  if (task.automation?.job_id && !all.has(task.automation.job_id)) all.set(task.automation.job_id, task.automation);
  const active = [...all.values()].filter(job => automationActive(job) && !job.cancel_requested);
  const recovery = [...all.values()].filter(job => job.recovery_required);
  const begin = (mode: Operation['mode'], job: R) => { setReason(''); setConfirmed(false); setOperation({ mode, job }); };
  const close = () => { if (!pending) setOperation(null); };
  const submit = async () => {
    if (!operation || pending || reason.trim().length < 5 || (operation.mode === 'recovery' && !confirmed)) return;
    const { mode, job } = operation;
    setPending(true);
    await s.act(async () => {
      const result = await api('/tasks/' + task.id + (mode === 'cancel' ? '/agent-cancel' : '/agent-recovery'), {
        job_id: job.job_id, expected_revision: task.revision, reason: reason.trim(), ...(mode === 'recovery' ? { confirmed: true } : {}),
      });
      setOperation(null);
      return result;
    }, mode === 'cancel' ? '已提交停止请求，请查看调用状态' : '核实结果已记录，旧执行不会自动重跑；后续审查按任务原有策略安排');
    setPending(false);
  };
  if (!active.length && !recovery.length && !operation) return null;
  const recovering = operation?.mode === 'recovery';
  return <section className="agent-automation" aria-label="Agent 调用操作">
    {active.map(job => <div className="agent-control-row" key={job.job_id}>
      <span>{job.role === 'review' ? '独立审查调用' : '执行调用'} · {job.client || '客户端未记录'}</span>
      <button className="btn small danger" disabled={s.busy || pending} onClick={() => begin('cancel', job)}>停止调用</button>
    </div>)}
    {recovery.length > 0 && <details className="fold">
      <summary>高级恢复（遗留调用 {recovery.length}）</summary>
      <p className="muted small">工作台自动核验已记录的进程状态。缺少可核验的进程信息时，可从原客户端补充实际结束记录；仍在运行的进程需要先结束。</p>
      {recovery.map(job => <div className="agent-recovery-row" key={job.job_id}>
        <strong>{job.run_id === task.current_run_id ? '当前执行的遗留调用' : '较早执行的遗留调用'} · {job.client || '客户端未记录'}</strong>
        {job.reason && <p>{job.reason}</p>}
        {processRecoveryText(job)&&<p className="muted small">{processRecoveryText(job)}</p>}
        <dl className="facts"><dt>调用</dt><dd>{job.job_id}</dd><dt>所属执行</dt><dd>{job.run_id || '未记录'}</dd></dl>
        <button className="btn small" disabled={s.busy || pending} onClick={() => begin('recovery', job)}>确认原调用已结束</button>
      </div>)}
    </details>}
    {operation && <Dialog title={recovering ? '核实遗留调用' : '停止这次调用'} onClose={close} footer={<>
      <button className="btn ghost" disabled={pending} onClick={close}>返回</button>
      <button className={'btn ' + (recovering ? 'primary' : 'danger')} disabled={s.busy || pending || reason.trim().length < 5 || (recovering && !confirmed)} onClick={() => void submit()}>{pending ? '正在提交…' : recovering ? '保存核实结果' : '确认停止调用'}</button>
    </>}>
      <p>{operation.job.role === 'review' ? '独立审查调用' : '执行调用'} · {operation.job.client || '客户端未记录'}</p>
      <Notice tone="warn">{recovering ? '这里只补充系统无法自动核验的结束事实，记录来源为你的核实说明；系统能核实的进程退出会自动记录。若原进程仍存在，不能把它记为已结束。保存后不会重跑旧执行；已交付且开启自动审查的任务按原有策略继续。' : '工作台将请求停止这次调用。原有交付与审查回执保留，本次停止不会自动重试。'}</Notice>
      {recovering && <label className="check"><input type="checkbox" checked={confirmed} disabled={pending} onChange={e => setConfirmed(e.target.checked)} />我已核实原调用已经结束</label>}
      <Field label={recovering ? '核实方式与原因' : '停止原因'} hint="请至少填写 5 个字，说明会保存在调用记录中。"><textarea rows={3} maxLength={2000} value={reason} disabled={pending} onChange={e => setReason(e.target.value)} /></Field>
    </Dialog>}
  </section>;
}
