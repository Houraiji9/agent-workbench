import {recoveredReviewInvocation,processRecoveryText} from '../../shared/review-presentation.js';
import React from 'react';
import type { R, Tone } from '../lib/flow.js';
import { Pill } from './kit.js';

const labels: Record<string, string> = { queued: '等待调用', launching: '正在启动', running: '调用中', completed: '调用已结束', failed: '调用失败', interrupted: '调用已中断' };
const tones: Record<string, Tone> = { queued: 'quiet', launching: 'working', running: 'working', completed: 'quiet', failed: 'problem', interrupted: 'problem' };
export const automationActive = (job?: R | null) => !!job && ['queued', 'launching', 'running'].includes(job.status);

export function AgentAutomationStatus({ job }: { job?: R | null }) {
  if (!job) return null;
  const recovered=recoveredReviewInvocation(job);
  const waiting=job.role==='review'&&!recovered&&['failed','interrupted'].includes(job.status);
  const stopUnconfirmed = job.cancel_requested && job.recovery_required;
  const processText=processRecoveryText(job);
  return <section className="agent-automation" aria-label="Agent 调用状态">
    <div className="agent-client-heading"><strong>{job.role === 'review' ? '独立审查调用' : '执行调用'}</strong><Pill tone={recovered?'quiet':waiting?'you':tones[job.status] || 'quiet'}>{recovered?'审查报告已补登记':stopUnconfirmed ? '已请求停止，待核实结束' : waiting?'本次调用未返回报告':labels[job.status] || '状态待确认'}</Pill></div>
    <div role="status" aria-live="polite">
      {recovered?<p>审查报告已补登记，可按当前任务继续。</p>:waiting?<p>可继续原会话或手动交接审查单。各成员的审查进度见下方。</p>:job.reason&&<p>{job.reason}</p>}
      {waiting&&job.process_may_be_running===true&&<p>进程状态仍在核验；手动导入已有报告仍可使用。</p>}
      {automationActive(job) && <p className="muted small">工作台正在处理本次调用，收到执行者或审查者回执后会更新任务进度。</p>}
      {processText&&<p className="muted small">{processText}</p>}
      {stopUnconfirmed && <p className="muted small">停止请求已记录，工作台会自动核验已记录的进程状态。</p>}
      {job.status === 'completed' && <p className="muted small">本次客户端进程已结束。交付、审查通过与验收仍以各自的正式记录为准。</p>}
    </div>
    {waiting&&<details className="fold"><summary>本次调用原因与退出记录</summary><p>{job.reason||'尚未记录具体原因'}</p><p>退出码：{job.exit_code??'未知'}</p></details>}
    {recovered&&<details className="fold"><summary>原调用失败与补登记记录</summary><p>{labels[job.status]||job.status}：{job.reason||'未记录失败原因'}</p><dl className="facts"><dt>退出码</dt><dd>{job.exit_code??'未知'}</dd><dt>已登记审查</dt><dd>{job.recovery.review_id}</dd><dt>补登记时间</dt><dd>{job.recovery.recovered_at}</dd><dt>进程结束证据</dt><dd>{job.recovery.process_end_evidence}</dd></dl></details>}
    <p className="muted small">客户端：{job.client || '未记录'} · {job.session_id ? '已记录原会话' : '尚未取得会话编号'}</p>
    {(job.session_id || job.job_id) && <details className="fold"><summary>调用记录</summary><dl className="facts">{job.session_id && <><dt>会话</dt><dd>{job.session_id}</dd></>}{job.job_id && <><dt>调用</dt><dd>{job.job_id}</dd></>}</dl></details>}
  </section>;
}
