import React from 'react';
import {taskHandoff} from '../../shared/task-handoff.js';
import type {R} from '../lib/flow.js';

export function TaskHandoff({task}:{task:R}){
 const h=taskHandoff(task),c=task.context_contract;
 return <section className="block" aria-label="方案与交接">
   <h2>方案与交接</h2>
   <p className="muted small">大脑出方案 → 执行者交成果 → 审查者检查本轮内容 → 执行者收尾</p>
   {h.plan.path&&<p>方案文件：<code style={{overflowWrap:'anywhere'}}>{h.plan.path}</code>{h.plan.range&&`（${h.plan.range.start_line}–${h.plan.range.end_line} 行）`}</p>}
   {h.plan.content&&<details className="fold"><summary>查看方案内容</summary><pre className="pre">{h.plan.content}</pre></details>}
   <p>成果存放：<code style={{overflowWrap:'anywhere'}}>{h.output_dir||task.allowed_paths?.[0]||'由执行者在项目内记录实际位置'}</code></p>
   {!!c?.review_focus?.length&&<p>本轮审查：{c.review_focus.join('；')}</p>}
   {!!(c?.required?.length||c?.supplemental?.length)&&<details className="fold"><summary>按需资料</summary>{(['executor','reviewer'] as const).map(role=><div key={role}><h3>{role==='executor'?'执行者':'审查者'}</h3><ul className="plain-list">{taskHandoff(task,role).files.map((f:R,i:number)=><li key={i}><span>{f.kind==='supplemental'?'补读':'首读'} · </span><code style={{overflowWrap:'anywhere'}}>{f.path}</code>{f.range&&`（${f.range.start_line}–${f.range.end_line} 行）`}{f.reason&&<p className="muted small">{f.reason}</p>}</li>)}</ul></div>)}</details>}
 </section>;
}
