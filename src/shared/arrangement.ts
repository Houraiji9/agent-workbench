// 执行安排（执行者、主模型、子代理）在任务不同阶段如何生效。页面与服务端共用同一判断。
type Row=Record<string,any>;

export type ArrangementPhase='direct'|'replace_unstarted'|'next_version'|'pending'|'closed';

const activeJob=(j:Row)=>j.process_may_be_running||['queued','launching','running'].includes(j.status);

export function arrangementPhase(t:Row,run:Row|null|undefined,jobs:Row[]=[]):ArrangementPhase{
  if(['accepted','rework_linked'].includes(t.status)||t.request_withdrawn)return 'closed';
  if(!t.current_run_id)return t.status==='ready'?'direct':'closed';
  const busy=jobs.some(j=>j.task_id===t.id&&activeJob(j));
  if(busy||!run)return 'pending';
  if(!run.has_started&&['awaiting_dispatch','dispatched'].includes(run.status)&&['ready','awaiting_dispatch','dispatched'].includes(t.status))return 'replace_unstarted';
  if(['failed','cancelled'].includes(run.status)&&['failed','cancelled','changes_requested'].includes(t.status))return 'next_version';
  if(run.status==='submitted'&&t.status==='changes_requested')return 'next_version';
  return 'pending';
}

/** 一句话说明保存后何时生效；不暗示正在运行的客户端会被热切换。 */
export const arrangementEffect:Record<ArrangementPhase,string>={
  direct:'还没生成执行单：保存后，生成执行单时直接采用。',
  replace_unstarted:'执行单已生成但还没有执行者接单：保存会作废这张未开始的执行单并按新安排重新生成，旧执行单留档。若已把旧单发给 Agent，请告诉它不要执行（旧单的回执会被拒绝）。',
  next_version:'本次执行已结束或需要修改：保存会按新安排生成下一版执行单，已有交付、审查和记录都保留，不会自动启动。',
  pending:'本次执行仍在进行，正在运行的客户端不能热切换模型。保存后作为“下一版安排”，下一次生成执行单（返修、重试、停止后重新开始）时采用；当前这轮不受影响。',
  closed:'任务已结束，安排只留档查看。',
};

export const arrangementSave:Record<ArrangementPhase,string>={
  direct:'保存安排',replace_unstarted:'作废未开始的执行单并重新生成',next_version:'按新安排生成下一版执行单',pending:'保存为下一版安排',closed:'',
};
