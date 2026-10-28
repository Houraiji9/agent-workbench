import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {knownAgentSession} from '../src/core/agent-session.ts';
import {recoverNativeReview} from '../src/core/native-review-recovery.ts';
import {bindReviewContextSession} from '../src/core/review-context.ts';
import type {Workbench} from '../src/core/workbench.ts';

type Row=Record<string,any>;
function job(id:string,extra:Row={}):Row{
  return {id,task_id:'task-one',run_id:'run-one',review_id:'review-one',role:'review',phase:'review',route:{client:'grok',model:'same-model'},status:'interrupted',session_id:null,resume_session_id:null,process_may_be_running:false,process_end_evidence:'tracked_process_absent',...extra};
}
function memory(jobs:Row[],extra:Record<string,Row[]>={}){
  const tables:Record<string,Row[]>={agent_jobs:jobs,runs:[{id:'run-one',task_id:'task-one',agent_id:'executor-one'}],review_assignments:[{id:'review-one',run_id:'run-one',reviewer_id:'reviewer-one'}],...extra};
  let writes=0;
  const wb={
    maybe:(table:string,id:string)=>tables[table]?.find(row=>row.id===id)||null,
    get:(table:string,id:string)=>{const row=tables[table]?.find(row=>row.id===id);assert(row,'Missing synthetic '+table+' / '+id);return row;},
    put:()=>{writes++;},
  } as unknown as Workbench;
  return {wb,tables,writes:()=>writes};
}

test('known session requires observed session_id; a bare or missing-parent resume target is never evidence',()=>{
  for(const extra of [{},{resume_session_id:'unobserved'},{resume_session_id:'unobserved',previous_job_id:'missing'},{session_id:17}]){
    const current=job('current',extra),f=memory([current]);assert.equal(knownAgentSession(f.wb,current),null);
  }
  const current=job('observed',{session_id:'observed-native',status:'running',process_may_be_running:true});
  assert.equal(knownAgentSession(memory([current]).wb,current),'observed-native','knowing an observed ID alone does not assert the process stopped');
});

test('observed native session is followed through multiple interrupted attempts without changing any stored evidence',()=>{
  const origin=job('origin',{session_id:'native-one',status:'failed',process_end_evidence:'owned_child_exit'});
  const first=job('first',{resume_session_id:'native-one',previous_job_id:origin.id});
  const second=job('second',{resume_session_id:'native-one',previous_job_id:first.id});
  const f=memory([origin,first,second]),before=JSON.stringify(f.tables);
  assert.equal(knownAgentSession(f.wb,second),'native-one');assert.equal(JSON.stringify(f.tables),before);assert.equal(f.writes(),0);
});

test('a different resume identity at either intermediate or final hop cannot borrow an observed session',()=>{
  const origin=job('origin',{session_id:'native-one'});
  for(const [firstTarget,lastTarget] of [['foreign','native-one'],['native-one','foreign']]){
    const first=job('first',{resume_session_id:firstTarget,previous_job_id:origin.id});
    const last=job('last',{resume_session_id:lastTarget,previous_job_id:first.id});
    assert.equal(knownAgentSession(memory([origin,first,last]).wb,last),null);
  }
});

test('lineage refuses another task, role, client, model or provider even if the native session target matches',()=>{
  for(const patch of [{task_id:'other-task'},{role:'execution'},{route:{client:'claude',model:'same-model'}},{route:{client:'grok',model:'other-model'}},{route:{client:'grok',model:'same-model',provider:'other-provider'}}]){
    const origin=job('origin',{session_id:'native-one',...patch}),current=job('current',{resume_session_id:'native-one',previous_job_id:origin.id});
    assert.equal(knownAgentSession(memory([origin,current]).wb,current),null,JSON.stringify(patch));
  }
});

test('cancel or session mismatch at any lineage hop makes that session unusable',()=>{
  for(const index of [0,1,2])for(const flag of [{session_mismatch:true},{cancel_requested_at:'2026-10-28T00:00:00Z'}]){
    const jobs=[job('origin',{session_id:'native-one'}),job('first',{resume_session_id:'native-one',previous_job_id:'origin'}),job('last',{resume_session_id:'native-one',previous_job_id:'first'})];
    Object.assign(jobs[index],flag);assert.equal(knownAgentSession(memory(jobs).wb,jobs[2]),null);
  }
});

test('self-references and multi-job cycles terminate without accepting the requested session',()=>{
  const self=job('self',{resume_session_id:'native-one',previous_job_id:'self'});assert.equal(knownAgentSession(memory([self]).wb,self),null);
  const first=job('first',{resume_session_id:'native-one',previous_job_id:'last'}),last=job('last',{resume_session_id:'native-one',previous_job_id:'first'});
  assert.equal(knownAgentSession(memory([first,last]).wb,last),null);
});

test('lineage is bounded at 100 jobs, including a real observed session at the oldest hop',()=>{
  for(const length of [100,101]){
    const jobs=Array.from({length},(_,i)=>job('job-'+i,i?{resume_session_id:'native-one',previous_job_id:'job-'+(i-1)}:{session_id:'native-one'}));
    assert.equal(knownAgentSession(memory(jobs).wb,jobs.at(-1)!),length===100?'native-one':null);
  }
});

test('a new reviewer cannot launder another reviewer session through an unlaunched failed resume attempt',()=>{
  const origin=job('origin',{session_id:'native-one',review_id:'review-origin'}),middle=job('middle',{resume_session_id:'native-one',previous_job_id:'origin'}),last=job('last',{resume_session_id:'native-one',previous_job_id:'middle'});
  const f=memory([origin,middle,last],{review_assignments:[{id:'review-origin',run_id:'run-one',reviewer_id:'reviewer-other'},{id:'review-one',run_id:'run-one',reviewer_id:'reviewer-one'}]});
  assert.equal(knownAgentSession(f.wb,middle),null);assert.equal(knownAgentSession(f.wb,last),null);
});

test('different executor identity across same-task Runs cannot inherit a native session through resume lineage',()=>{
  const origin=job('origin',{role:'execution',session_id:'native-one',run_id:'run-origin'}),middle=job('middle',{role:'execution',resume_session_id:'native-one',previous_job_id:'origin'}),last=job('last',{role:'execution',resume_session_id:'native-one',previous_job_id:'middle'});
  const f=memory([origin,middle,last],{runs:[{id:'run-origin',task_id:'task-one',agent_id:'executor-other'},{id:'run-one',task_id:'task-one',agent_id:'executor-one'}]});
  assert.equal(knownAgentSession(f.wb,last),null);
});

test('same reviewer or executor may continue across same-task assignments and Runs',()=>{
  for(const role of ['review','execution']){
    const origin=job('origin',{role,session_id:'native-one',run_id:'run-origin',review_id:'review-origin'}),current=job('current',{role,resume_session_id:'native-one',previous_job_id:'origin'});
    const f=memory([origin,current],{runs:[{id:'run-origin',task_id:'task-one',agent_id:'executor-one'},{id:'run-one',task_id:'task-one',agent_id:'executor-one'}],review_assignments:[{id:'review-origin',run_id:'run-origin',reviewer_id:'reviewer-one'},{id:'review-one',run_id:'run-one',reviewer_id:'reviewer-one'}]});
    assert.equal(knownAgentSession(f.wb,current),'native-one');
  }
});

test('a lineage hop without either current or previous actor evidence is not a verified identity match',()=>{
  for(const role of ['review','execution'])for(const missing of ['origin','current']){
    const origin=job('origin',{role,session_id:'native-one',run_id:'run-origin',review_id:'review-origin'}),current=job('current',{role,resume_session_id:'native-one',previous_job_id:'origin'});
    const f=memory([origin,current],{runs:[{id:'run-origin',task_id:'task-one',agent_id:missing==='origin'?null:'executor-one'},{id:'run-one',task_id:'task-one',agent_id:missing==='current'?null:'executor-one'}],review_assignments:[{id:'review-origin',reviewer_id:missing==='origin'?null:'reviewer-one'},{id:'review-one',reviewer_id:missing==='current'?null:'reviewer-one'}]});
    assert.equal(knownAgentSession(f.wb,current),null);
  }
});

test('tracked process absence never permits formal native report import or verified review context binding',()=>{
  const runId='R-'+randomUUID(),jobId='AJ-'+randomUUID(),reviewId='RA-'+randomUUID();
  const current=job(jobId,{run_id:runId,review_id:reviewId,session_id:'native-one',exit_code:0,process_end_evidence:'tracked_process_absent'});
  const f=memory([current],{runs:[{id:runId,task_id:'task-one',agent_id:'executor-one'}],tasks:[{id:'task-one',current_run_id:runId,status:'submitted'}],review_assignments:[{id:reviewId,run_id:runId,reviewer_id:'reviewer-one',session_id:'native-one',context_cache:[]}]});
  assert.throws(()=>recoverNativeReview(f.wb,{run_id:runId,job_id:jobId}),/尚未确认正常结束/);
  assert.throws(()=>bindReviewContextSession(f.wb,reviewId,jobId),/尚无本次调用的可靠实际会话证据/);assert.equal(f.writes(),0);
});
