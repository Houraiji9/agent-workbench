import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {fixture,taskInput,event,setup} from './helpers.ts';
import {Workbench} from '../src/core/workbench.ts';

test('未获用户明确选择时，规划者不能省略独立审查',()=>{
  const {wb,root}=fixture();try{
    const q=wb.request({project_id:'P-workbench',text:'测试：普通需求'});
    assert.throws(()=>wb.submitPlan({schema_version:1,plan_id:'no-unauthorized-waiver',request_id:q.id,expected_version:1,tasks:[{...taskInput(root),reviewer_id:null}]}),/不能自行跳过/);
    assert.throws(()=>wb.request({project_id:'P-workbench',text:'测试：不完整选择',skip_review:true,review_note:''}),/用户说明/);
    assert.equal(wb.all('tasks').length,0);
  }finally{wb.close()}
});

test('独立Claude独立于旧轻量入口；用户选择不审查后，真实交付仍等待本人确认',()=>{
  const {wb,root,config}=fixture();let active=wb;
  try{
    assert(wb.get('agents','claude').allowed_kinds.includes('engineering'));
    assert(!wb.get('agents','antigravity-claude').allowed_kinds.includes('engineering'));
    assert.equal(wb.get('subscriptions','test-active-claude').amount,null);
    assert.equal(wb.get('subscriptions','test-active-claude').end_date,null);
    const q=wb.request({project_id:'P-workbench',text:'测试：Claude重新制作',skip_review:true,review_note:'测试专用：用户明确要求不安排独立审查'});
    const p=wb.submitPlan({schema_version:1,plan_id:'user-waived-review',request_id:q.id,expected_version:1,tasks:[{...taskInput(root),agent_id:'claude',reviewer_id:null,user_acceptance:['我已试用且满意']} ]});
    const tid=p.task_ids[0],o=wb.exportOrder(tid,1);
    assert(fs.readFileSync(o.path,'utf8').includes('未安排（用户选择）'));
    assert.equal(wb.get('runs',o.run_id).seq,0);
    assert.throws(()=>wb.accept(tid,{revision:wb.get('tasks',tid).revision,mode:'user_experience',user_checks:[true]}),/真实交付/);
    wb.manualAction(tid,'dispatch',wb.get('tasks',tid).revision);
    wb.event(event(root,tid,o.run_id,1,'started',{identity:'claude'}));
    wb.event(event(root,tid,o.run_id,2,'submitted',{identity:'claude',result:'隔离测试的真实结果：作者交付不代表审查通过，也不能代用户最终确认。'}));
    assert.equal(wb.get('tasks',tid).status,'awaiting_confirmation');
    assert.equal(wb.get('runs',o.run_id).status,'submitted');
    assert.equal(wb.all('reviews').length,0);
    assert.throws(()=>wb.review({run_id:o.run_id,reviewer_id:null,performed:true,verdict:'passed',evidence:'不应接受虚构的审查者及审查记录',artifact_hashes:wb.all('artifacts').map(a=>a.sha256)}));
    wb.close();active=new Workbench(config);
    const version=active.get('tasks',tid).revision;
    assert.throws(()=>active.accept(tid,{revision:version,mode:'user_experience',user_checks:[false]}),/确认使用结果/);
    assert.throws(()=>active.accept(tid,{revision:version,mode:'user_experience',user_checks:[true],artifact_hashes:['old']}),/产物版本/);
    const accepted=active.accept(tid,{revision:version,mode:'user_experience',user_checks:[true]});
    assert.equal(accepted.acceptance_record.review_id,null);
    assert.equal(accepted.acceptance_record.review_policy.mode,'not_requested');
    assert.equal(active.all('reviews').length,0);
  }finally{active.close()}
});

test('停止采用已交付任务，保留作者交付、回执和产物，不制造审查',()=>{
  const {wb,root}=fixture();try{
    const s=setup(wb,root);
    wb.event(event(root,s.tid,s.rid,1));
    wb.event(event(root,s.tid,s.rid,2,'submitted',{result:'测试专用作者交付记录：用户不满意并决定停止采用，原始证据应保留。'}));
    const artifacts=wb.all('artifacts');
    wb.manualAction(s.tid,'cancel',wb.get('tasks',s.tid).revision);
    assert.equal(wb.get('tasks',s.tid).status,'cancelled');
    assert.equal(wb.get('runs',s.rid).status,'submitted');
    assert.deepEqual(wb.all('artifacts'),artifacts);
    assert.equal(wb.all('events').length,2);
    assert.equal(wb.all('reviews').length,0);
  }finally{wb.close()}
});
