import React from 'react';
import {Copy,CircleCheckBig} from 'lucide-react';
import {useStore} from '../app/store.js';
import {reviewSkippedTask} from '../lib/flow.js';
import type {R} from '../lib/flow.js';
import {waitingForDependencies} from '../../shared/execution-order.js';
import {copyOrder,openTrial,copyReviewHandoff} from '../views/actions.js';
import {CopyBox,Dialog} from './kit.js';
import './quick-actions.css';

export function canCopyCurrentOrder(t:R){return !!t.current_run_id&&!['accepted','cancelled','rework_linked'].includes(t.status)&&!waitingForDependencies(t)}

/** 工具入口只取回当前单据，不派发、不接单，也不催促重复转交。 */
export function TaskQuickActions({task:t,trial=true,copy=true,initial=false,review=true}:{task:R;trial?:boolean;copy?:boolean;initial?:boolean;review?:boolean}){
 const s=useStore();
 return <span className="task-quick-actions">
  {review&&['submitted','in_review'].includes(t.status)&&!['completed','awaiting_decision'].includes(t.review_stage)&&!reviewSkippedTask(t)&&<button className="btn small" disabled={s.busy} onClick={()=>void copyReviewHandoff(s,t)}><Copy size={14}/>交给审查者</button>}
  {trial&&t.status==='awaiting_confirmation'&&<button className="btn small" disabled={s.busy} onClick={()=>void openTrial(s,t)}><CircleCheckBig size={14} aria-hidden="true"/>试用确认</button>}
  {copy&&canCopyCurrentOrder(t)&&<button className="btn small ghost" disabled={s.busy} onClick={()=>void copyOrder(s,t)}><Copy size={14} aria-hidden="true"/>复制当前执行单</button>}
  {copy&&initial&&t.status==='ready'&&!t.current_run_id&&!waitingForDependencies(t)&&<button className="btn small ghost" disabled={s.busy} onClick={()=>void copyOrder(s,t)}><Copy size={14} aria-hidden="true"/>生成并复制执行单</button>}
 </span>;
}

export function OrderCopyDialog({task,text,onClose}:{task:R;text:string;onClose():void}){
 const s=useStore();
 return <Dialog title="手动复制执行资料" sub="剪贴板暂不可用，选中下面的完整文本即可手动复制。复制不会派发任务或记录接单。" onClose={onClose} footer={<button className="btn" onClick={onClose}>关闭</button>}>
  <p className="quick-action-context">{s.pname(task.project_id)} · {task.title}</p>
  <CopyBox label="手动复制执行资料全文" text={text} rows={12}/>
 </Dialog>;
}
