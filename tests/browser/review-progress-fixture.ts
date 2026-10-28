import crypto from 'node:crypto';
import {setup,event} from '../helpers.ts';
import {exportReviewOrder,startReview} from '../../src/core/review-workflow.ts';
import {jobView} from '../../src/core/agent-orchestration.ts';
export function seedReviewProgress(wb:any,root:string){
 for(const variant of ['双人审查','一人待继续','三人审查']){
  const s=setup(wb,root);const t=wb.get('tasks',s.tid);t.title='测试0416：'+variant;wb.put('tasks',t,{project_id:t.project_id});wb.event(event(root,s.tid,s.rid,1));wb.event(event(root,s.tid,s.rid,2,'submitted',{result:'隔离合成数据，用于多人审查状态展示回归，不是真实审查。'}));
  for(const [index,reviewer] of (variant==='三人审查'?['claude','grok-build','zcode']:['claude','grok-build']).entries()){
   const order=exportReviewOrder(wb,{run_id:s.rid,reviewer_id:reviewer,expected_revision:wb.get('tasks',s.tid).revision,reason:'合成并行审查展示',delivery_mode:'manual'},{role:'user'});
   if(index===2)continue;
   startReview(wb,{review_id:order.review_id,identity:reviewer});
   const failed=index===1&&variant!=='双人审查';const job={id:'AJ-'+crypto.randomUUID(),run_id:s.rid,task_id:s.tid,review_id:order.review_id,role:'review',phase:'review',status:failed?'failed':'running',route:{client:'grok',model:'synthetic'},process_may_be_running:!failed,process_end_evidence:failed?'owned_child_exit':'unknown',reason:failed?'合成客户端拒绝终端检查命令，未收到报告':'合成客户端活动',created_at:new Date().toISOString(),exit_code:failed?1:null};
   wb.put('agent_jobs',job,{run_id:s.rid});const task=wb.get('tasks',s.tid);task.automation=jobView(job);task.review_route={client:'grok',model:'synthetic'};wb.put('tasks',task,{project_id:task.project_id});
   const a=wb.get('review_assignments',order.review_id);a.route=job.route;wb.put('review_assignments',a,{run_id:s.rid});
  }
 }
}
