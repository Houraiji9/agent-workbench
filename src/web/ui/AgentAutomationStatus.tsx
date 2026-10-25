import React from 'react';
import type { R, Tone } from '../lib/flow.js';
import { Pill } from './kit.js';

const labels: Record<string, string> = { queued: '等待调用', launching: '正在启动', running: '调用中', completed: '调用已结束', failed: '调用失败', interrupted: '调用已中断' };
const tones: Record<string, Tone> = { queued: 'quiet', launching: 'working', running: 'working', completed: 'quiet', failed: 'problem', interrupted: 'problem' };
export const automationActive = (job?: R | null) => !!job && ['queued', 'launching', 'running'].includes(job.status);

export function AgentAutomationStatus({ job }: { job?: R | null }) {
  if (!job) return null;
  const stopUnconfirmed = job.cancel_requested && job.recovery_required;
  return <section className="agent-automation" aria-label="Agent 调用状态">
    <div className="agent-client-heading"><strong>{job.role === 'review' ? '独立审查调用' : '执行调用'}</strong><Pill tone={tones[job.status] || 'quiet'}>{stopUnconfirmed ? '已请求停止，待核实结束' : labels[job.status] || '状态待确认'}</Pill></div>
    <div role="status" aria-live="polite">
      {job.reason && <p>{job.reason}</p>}
      {automationActive(job) && <p className="muted small">工作台正在处理本次调用，收到执行者或审查者回执后会更新任务进度。</p>}
      {stopUnconfirmed && <p className="muted small">停止请求已记录，尚未确认原客户端结束，请继续查看状态。</p>}
      {job.status === 'completed' && <p className="muted small">本次客户端进程已结束。交付、审查通过与验收仍以各自的正式记录为准。</p>}
      {job.process_end_evidence === 'user_attested' && <p className="muted small">原调用结束已由用户核实并记录。</p>}
    </div>
    <p className="muted small">客户端：{job.client || '未记录'} · {job.session_id ? '已记录原会话' : '尚未取得会话编号'}</p>
    {(job.session_id || job.job_id) && <details className="fold"><summary>调用记录</summary><dl className="facts">{job.session_id && <><dt>会话</dt><dd>{job.session_id}</dd></>}{job.job_id && <><dt>调用</dt><dd>{job.job_id}</dd></>}</dl></details>}
  </section>;
}
