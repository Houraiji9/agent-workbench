import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture,setup} from './helpers.ts';
import {appendTaskNote,appendTaskNoteInput} from '../src/core/task-notes.ts';

test('补充事实备注只追加历史和revision，保留已交付审查收尾及验收状态',()=>{
 const f=fixture();try{
  const s=setup(f.wb,f.root),t=f.wb.get('tasks',s.tid),r=f.wb.get('runs',s.rid);
  const review={id:'RA-note-test',run_id:r.id,status:'completed',reviewer_id:'claude'};
  f.wb.put('review_assignments',review,{run_id:r.id});
  f.wb.put('tasks',{...t,status:'awaiting_confirmation',review_stage:'passed'},{project_id:t.project_id});
  f.wb.put('runs',{...r,scope_revision:2,status:'submitted',review_decision:{id:'decision'},closeout:{id:'closeout',status:'completed',digest:'bound'},deployment:{verified:true},review_files:[{path:'synthetic',sha256:'hash'}]},{task_id:t.id});
  const beforeT=f.wb.get('tasks',t.id),beforeR=f.wb.get('runs',r.id),artifacts=f.wb.all('artifacts');
  const value={task_id:t.id,run_id:r.id,expected_revision:t.revision,note:'Codex补充整合上线事实；不是Claude执行回执。',references:[{kind:'review',value:review.id}]};
  const out=appendTaskNote(f.wb,value,'runner:codex-current');
  assert.equal(out.note.actor,'runner:codex-current');assert.equal(out.note.verification,'unverified_note');
  const afterT=f.wb.get('tasks',t.id),afterR=f.wb.get('runs',r.id);
  const {revision:oldRevision,updated_at:oldTime,...oldT}=beforeT,{revision:newRevision,updated_at:newTime,...newT}=afterT;
  assert.deepEqual(newT,oldT);assert.equal(newRevision,oldRevision+1);
  const {updated_at:oldRunTime,...oldR}=beforeR,{notes,updated_at:newRunTime,...newR}=afterR;
  assert.deepEqual(newR,oldR);assert.equal(notes.length,1);assert.deepEqual(f.wb.get('review_assignments',review.id),review);assert.deepEqual(f.wb.all('artifacts'),artifacts);
  assert.throws(()=>appendTaskNote(f.wb,value,'manager'),/版本/);
  const second=appendTaskNote(f.wb,{...value,expected_revision:newRevision,note:'第二条保留原备注'},'manager');
  assert.equal(f.wb.get('runs',r.id).notes.length,2);assert.notEqual(second.note.id,out.note.id);
 }finally{f.wb.close();}
});

test('备注拒绝旧Run、跨项目引用、缺失引用及客户端伪造作者，失败不产生部分记录',()=>{
 const f=fixture();try{
  const s=setup(f.wb,f.root),t=f.wb.get('tasks',s.tid),r=f.wb.get('runs',s.rid),base={task_id:t.id,run_id:r.id,expected_revision:t.revision,note:'说明性证据'};
  f.wb.put('projects',{...f.wb.get('projects',t.project_id),id:'P-other'});
  f.wb.put('tasks',{...t,id:'T-other-project',project_id:'P-other'},{project_id:'P-other'});
  f.wb.put('runs',{...r,id:'R-other-project',task_id:'T-other-project'},{task_id:'T-other-project'});
  f.wb.put('artifacts',{id:'A-other-project',run_id:'R-other-project'},{run_id:'R-other-project'});
  f.wb.put('review_assignments',{id:'RA-other-project',run_id:'R-other-project'},{run_id:'R-other-project'});
  for(const [kind,value] of [['run','R-other-project'],['artifact','A-other-project'],['review','RA-other-project']])assert.throws(()=>appendTaskNote(f.wb,{...base,references:[{kind,value}]},'manager'),/目标项目/);
  assert.throws(()=>appendTaskNote(f.wb,{...base,references:[{kind:'artifact',value:'missing'}]},'manager'));
  assert.throws(()=>appendTaskNote(f.wb,{...base,run_id:'R-other-project'},'manager'),/当前 Run/);
  assert.equal(appendTaskNoteInput.safeParse({...base,actor:'claude'}).success,false);
  assert.equal(f.wb.get('tasks',t.id).revision,t.revision);assert.equal(f.wb.get('runs',r.id).notes,undefined);
  const ok=appendTaskNote(f.wb,{...base,references:[{kind:'text',value:'说明：未主动核验部署'},{kind:'run',value:r.id}]},'manager');assert.equal(ok.note.references.length,2);
 }finally{f.wb.close();}
});
