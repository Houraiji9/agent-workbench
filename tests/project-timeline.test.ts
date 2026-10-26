import {test} from 'node:test';
import assert from 'node:assert/strict';
import {projectTimelineGraph} from '../src/shared/project-timeline.ts';
test('timeline adds explicit job parent, artifact review and closeout receipt relationships',()=>{
  const result=projectTimelineGraph({project_id:'P',tasks:[{id:'T',project_id:'P',title:'Task'}],runs:[{id:'R',task_id:'T',closeout:{id:'CO',artifact_hashes:['hash']}}],jobs:[{id:'J',run_id:'R',session_id:'S'},{id:'J2',run_id:'R',parent_job_id:'J',closeout_id:'CO'}],sessions:[{id:'S',run_id:'R'},{id:'S2',project_id:'P',parent_session_id:'S'}],artifacts:[{id:'A',run_id:'R',sha256:'hash'}],reviews:[{id:'V',run_id:'R',artifact_hashes:['hash'],verdict:'passed'}],events:[{id:'E',run_id:'R',disposition:'applied',event_type:'closeout_completed',data:{closeout_id:'CO'}}]});
  for(const [from,to,kind] of [['job:J','job:J2','parent_child'],['session:S','session:S2','parent_child'],['artifact:A','review:V','review_artifact'],['artifact:A','closeout:CO','closeout_artifact'],['closeout:CO','closeout_event:E','closeout_receipt']])assert.ok(result.edges.some(e=>e.from===from&&e.to===to&&e.kind===kind));
  assert.equal(result.unresolved.length,0);assert.equal(result.snapshot,false);
});
test('identical titles and timestamps never infer relations; typed IDs prevent collisions',()=>{
  const graph=projectTimelineGraph({project_id:'P',tasks:[{id:'same',project_id:'P',title:'Identical'}],runs:[{id:'same',task_id:'same'}],sessions:[{id:'other',project_id:'P',title:'Identical',started_at:'same'}],jobs:[{id:'J',project_id:'P',parent_job_id:'missing'}]});
  assert.ok(graph.nodes.some(n=>n.id==='task:same'));assert.ok(graph.nodes.some(n=>n.id==='run:same'));assert.equal(graph.edges.some(e=>e.from==='session:other'),false);assert.equal(graph.unresolved[0].from,'job:missing');
});
test('project scope excludes unrelated records and revoked reviews retain actual state',()=>{
  const graph=projectTimelineGraph({project_id:'P',tasks:[{id:'T',project_id:'P'},{id:'X',project_id:'X'}],runs:[{id:'R',task_id:'T'},{id:'RX',task_id:'X'}],reviews:[{id:'V',run_id:'R',verdict:'passed',revoked_at:'2026-01-01'}],artifacts:[{id:'AX',run_id:'RX'}],events:[{id:'bad',run_id:'R',disposition:'rejected',event_type:'closeout_completed'}]});
  assert.equal(graph.nodes.some(n=>n.record_id==='AX'||n.record_id==='X'||n.record_id==='bad'),false);assert.equal(graph.nodes.find(n=>n.record_id==='V')?.label,'已撤销审查');
});
test('delegation IDs produce explicit report edges while absolute artifact paths remain unverified display data',()=>{
  const graph=projectTimelineGraph({project_id:'P',tasks:[{id:'T',project_id:'P'}],runs:[{id:'R',task_id:'T'}],delegations:[{id:'D1',run_id:'R',goal:'First',artifacts:['G:/example.txt'],actual_model:'reported',requested_model:'requested'},{id:'D2',run_id:'R',parent_id:'D1'}]});
  const node=graph.nodes.find(n=>n.id==='delegation:D1')!;assert.equal(node.source,'executor_reported');assert.equal(node.control_level,'instructions_only');assert.deepEqual(node.artifact_paths,['G:/example.txt']);assert.equal(node.actual_model,'reported');assert.ok(graph.edges.some(e=>e.from==='delegation:D1'&&e.to==='delegation:D2'));assert.equal(graph.nodes.some(n=>n.kind==='artifact'),false);
});
test('user acceptance requires the recorded confirmation timestamp and binds the confirmed Run, not current status',()=>{
  const result=projectTimelineGraph({project_id:'P',tasks:[{id:'unconfirmed',project_id:'P',status:'accepted',acceptance_record:{run_id:'R0'}},{id:'pending',project_id:'P',status:'awaiting_confirmation'},{id:'confirmed',project_id:'P',status:'accepted',current_run_id:'R-new',acceptance_record:{run_id:'R-confirmed',confirmed_at:'2026-10-25T12:00:00Z'}}],runs:[{id:'R0',task_id:'unconfirmed'},{id:'R-confirmed',task_id:'confirmed'},{id:'R-new',task_id:'confirmed'}]});
  assert.equal(result.nodes.filter(n=>n.kind==='acceptance').length,1);const acceptance=result.nodes.find(n=>n.kind==='acceptance')!;assert.equal(acceptance.task_id,'confirmed');assert.equal(acceptance.occurred_at,'2026-10-25T12:00:00Z');assert.ok(result.edges.some(e=>e.kind==='user_acceptance'&&e.from==='run:R-confirmed'&&e.to===acceptance.id));assert.equal(result.edges.some(e=>e.kind==='user_acceptance'&&e.from==='run:R-new'),false);
});
test('request to plan to task follows real IDs even when titles and timestamps are identical',()=>{
  const result=projectTimelineGraph({project_id:'P',requests:[{id:'Q1',project_id:'P',text:'same',created_at:'2026-10-25T12:00:00Z'},{id:'Q2',project_id:'P',text:'same',created_at:'2026-10-25T12:00:00Z'},{id:'Q-other',project_id:'other',text:'same'}],plans:[{id:'PL1',request_id:'Q1',task_ids:['T1']},{id:'PL-other',request_id:'Q-other',task_ids:['T-other']}],tasks:[{id:'T1',project_id:'P',request_id:'Q1',title:'same'},{id:'T2',project_id:'P',request_id:'Q2',title:'same'},{id:'T-other',project_id:'other',request_id:'Q-other',title:'same'}]});
  for(const [from,to] of [['request:Q1','plan:PL1'],['plan:PL1','task:T1'],['request:Q2','task:T2']])assert.ok(result.edges.some(e=>e.from===from&&e.to===to));assert.equal(result.edges.some(e=>e.from==='plan:PL1'&&e.to==='task:T2'),false);assert.equal(result.nodes.some(n=>['Q-other','PL-other','T-other'].includes(n.record_id)),false);
});
test('hiding historical tasks also hides their jobs, including legacy jobs linked only by Run ID',()=>{
  const base={project_id:'P',tasks:[{id:'active',project_id:'P',status:'running'},{id:'ended',project_id:'P',status:'accepted'},{id:'other',project_id:'other',status:'running'}],runs:[{id:'R-active',task_id:'active'},{id:'R-ended',task_id:'ended'},{id:'R-other',task_id:'other'}],jobs:[{id:'J-active',project_id:'P',task_id:'active',run_id:'R-active'},{id:'J-ended',project_id:'P',task_id:'ended',run_id:'R-ended'},{id:'J-legacy-ended',project_id:'P',run_id:'R-ended'},{id:'J-other',project_id:'other',task_id:'other',run_id:'R-other'},{id:'J-legacy-other',project_id:'P',run_id:'R-other'}]};
  const current=projectTimelineGraph({...base,include_history:false});assert.ok(current.nodes.some(n=>n.id==='job:J-active'));for(const id of ['J-ended','J-legacy-ended','J-other','J-legacy-other'])assert.equal(current.nodes.some(n=>n.record_id===id),false,'must hide '+id);
  const history=projectTimelineGraph({...base,include_history:true});assert.ok(history.nodes.some(n=>n.record_id==='J-legacy-ended'));assert.equal(history.nodes.some(n=>n.record_id==='J-other'||n.record_id==='J-legacy-other'),false);
});
test('actual and requested models stay distinct on job records; role ownership is not inferred from similar labels',()=>{
  const result=projectTimelineGraph({project_id:'P',tasks:[{id:'T',project_id:'P',agent_id:'executor',reviewer_id:'reviewer'}],runs:[{id:'R',task_id:'T'}],review_assignments:[{id:'RA',run_id:'R',reviewer_id:'reviewer'}],jobs:[{id:'execution',task_id:'T',run_id:'R',role:'execution',agent_id:'executor',requested_model:'requested-main',actual_model:'actual-main'},{id:'review',task_id:'T',run_id:'R',role:'review',agent_id:'reviewer',review_assignment_id:'RA',requested_model:'requested-review',actual_model:'actual-review'}]});
  const execution=result.nodes.find(n=>n.id==='job:execution')!,review=result.nodes.find(n=>n.id==='job:review')!;assert.equal(execution.agent,'executor');assert.equal(review.agent,'reviewer');assert.equal(review.actual_model,'actual-review');assert.equal(review.requested_model,'requested-review');assert.ok(result.edges.some(e=>e.from==='review_assignment:RA'&&e.to==='job:review'));assert.equal(result.edges.some(e=>e.from==='review_assignment:RA'&&e.to==='job:execution'),false);
});

test('handoffs use the current Run and distinguish planned models and user action from acceptance',()=>{
 const graph=projectTimelineGraph({project_id:'P',tasks:[{id:'T',project_id:'P',title:'交付',status:'awaiting_confirmation',current_run_id:'R'}],runs:[{id:'OLD',task_id:'T',agent_id:'old',actual_model:'old-model'},{id:'R',task_id:'T',agent_id:'executor',requested_model:'planned'}],artifacts:[{id:'old',run_id:'OLD',current:true},{id:'A',run_id:'R',label:'交付文件',current:true},{id:'retired',run_id:'R',current:false}]});
 const card=graph.handoffs[0];assert.equal(card.owner,'executor');assert.equal(card.requested_model,'planned');assert.equal(card.actual_model,null);assert.deepEqual(card.outputs,[{id:'A',label:'交付文件'}]);assert.equal(card.user_action,true);assert.match(card.next_step,/确认验收/);assert.equal(graph.nodes.some(n=>n.kind==='acceptance'),false);
});
test('handoffs show active reviewer assignment and preserve missing output',()=>{
 const graph=projectTimelineGraph({project_id:'P',tasks:[{id:'T',project_id:'P',status:'in_review',current_run_id:'R',reviewer_id:'original'}],runs:[{id:'R',task_id:'T',agent_id:'author'}],review_assignments:[{id:'removed',run_id:'R',status:'cancelled',reviewer_id:'removed'},{id:'RA',run_id:'R',status:'running',reviewer_id:'reviewer',requested_model:'review-plan',actual_model:'review-actual'}]});
 const card=graph.handoffs[0];assert.equal(card.owner,'reviewer');assert.equal(card.requested_model,'review-plan');assert.equal(card.actual_model,'review-actual');assert.deepEqual(card.outputs,[]);assert.equal(card.user_action,false);assert.match(card.next_step,/审查报告/);
});

test('review reports attach to their explicit assignment while legacy reports fall back to Run',()=>{
 const graph=projectTimelineGraph({project_id:'P',tasks:[{id:'T',project_id:'P'}],runs:[{id:'R',task_id:'T'}],review_assignments:[{id:'RA',run_id:'R'}],reviews:[{id:'V',run_id:'R',review_id:'RA'},{id:'legacy',run_id:'R'},{id:'missing',run_id:'R',review_id:'missing-RA'}]});
 assert.ok(graph.edges.some(e=>e.from==='review_assignment:RA'&&e.to==='review:V'));assert.equal(graph.edges.some(e=>e.from==='run:R'&&e.to==='review:V'),false);assert.ok(graph.edges.some(e=>e.from==='run:R'&&e.to==='review:legacy'));assert.ok(graph.unresolved.some(e=>e.from==='review_assignment:missing-RA'&&e.to==='review:missing'));
});
test('manual review handoff asks the user to forward prepared order; active peer keeps ownership after another report',()=>{
 const input={project_id:'P',tasks:[{id:'T',project_id:'P',status:'submitted',review_stage:'awaiting_dispatch',current_run_id:'R',reviewer_id:'default'}],runs:[{id:'R',task_id:'T'}],review_assignments:[{id:'done',run_id:'R',reviewer_id:'completed',status:'completed'},{id:'pending',run_id:'R',reviewer_id:'peer',status:'awaiting_dispatch',delivery_mode:'manual'}]};
 let card=projectTimelineGraph(input).handoffs[0];assert.equal(card.owner,'peer');assert.equal(card.user_action,true);assert.match(card.next_step,/已准备的审查单/);
 input.review_assignments[1].status='running';input.tasks[0].status='in_review';input.tasks[0].review_stage='running';card=projectTimelineGraph(input).handoffs[0];assert.equal(card.owner,'peer');assert.equal(card.user_action,false);assert.match(card.next_step,/回传审查报告/);
});

test('same-session project handoff shares agent responsibility with the task view and keeps real user decisions',()=>{
 const base={id:'T',project_id:'P',status:'awaiting_dispatch',agent_id:'executor',current_run_id:'R',execution_route:null,automation:null,same_session_continuation:{run_id:'R',agent_id:'executor'}};
 const card=(extra:Record<string,any>={})=>projectTimelineGraph({project_id:'P',tasks:[{...base,...extra}],runs:[{id:'R',task_id:'T',agent_id:'executor'}]}).handoffs[0];
 const same=card();assert.equal(same.status,'awaiting_dispatch');assert.equal(same.display_status,'continuation_pending');assert.equal(same.owner,'executor');assert.equal(same.user_action,false);assert.match(same.next_step,/原会话继续返修.*无需再次转发/);assert.doesNotMatch(same.next_step,/发送执行单/);
 for(const extra of [{same_session_continuation:null},{same_session_continuation:{run_id:'old',agent_id:'executor'}},{same_session_continuation:{run_id:'R',agent_id:'other'}}]){assert.equal(card(extra).user_action,true);assert.match(card(extra).next_step,/发送执行单/);}
 const failed=card({automation:{status:'failed',role:'execution'}});assert.equal(failed.user_action,true);assert.match(failed.next_step,/阻碍/);
 const decision=card({pending_user_decision:{expires_at:new Date(Date.now()+60000).toISOString()}});assert.equal(decision.user_action,true);assert.match(decision.next_step,/确认事项/);
 const closing=card({status:'awaiting_closeout'});assert.equal(closing.user_action,false);assert.match(closing.next_step,/原会话继续收尾/);
});
