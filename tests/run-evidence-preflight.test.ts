import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fixture,setup,event} from './helpers.ts';
import {readManagement} from '../src/core/management.ts';
import {scopeManagementInput} from '../src/core/session-management.ts';

test('交付先报告全部附件问题，不写产物/消耗序号；修正附件后同Run提交并保持事件幂等',async()=>{
  const f=fixture();try{
    const s=setup(f.wb,f.root);f.wb.event(event(f.root,s.tid,s.rid,1));
    const bad=event(f.root,s.tid,s.rid,2,'submitted',{result:'实际隔离交付说明：本测试核对所有附件前置检查与重复事件安全。',artifacts:[{path:path.join(f.root,'missing-one.md'),label:'一'},{path:path.join(f.root,'missing-two.md'),label:'二'}]});
    const preflight:any=await readManagement(f.wb,{} as any,'preflight_run_evidence',{task_id:s.tid,artifacts:bad.data.artifacts});
    assert.equal(preflight.issues.length,2);assert.equal(preflight.limits.file_bytes,20*1024*1024);
    assert.throws(()=>f.wb.event(bad),/证据预检未通过/);assert.equal(f.wb.get('runs',s.rid).seq,1);assert.equal(f.wb.all('artifacts').length,0);assert.equal(f.wb.all('events').length,1);
    for(const a of bad.data.artifacts)fs.writeFileSync(a.path,'隔离附件');
    const accepted=f.wb.event(bad);assert.equal(accepted.disposition,'applied',accepted.error);assert.deepEqual(f.wb.event(bad),accepted);
    assert.throws(()=>f.wb.event({...bad,data:{...bad.data,result:'修改事件内容但复用编号不应成功，即使附件已经修好了。'}}),/事件 ID/);
    assert(f.wb.get('runs',s.rid).source_baseline);assert(f.wb.get('runs',s.rid).source_coverage);
  }finally{f.wb.close();}
});

test('只读证据及发布来源查询保留当前会话项目权限，默认详情有界且full可用',async()=>{
  const f=fixture();try{
    const s=setup(f.wb,f.root),caller={role:'runner' as const,id:'runner:'+s.rid,run_id:s.rid,project_id:'P-unrelated',project_ids:['P-unrelated']};
    for(const name of ['preflight_run_evidence','get_release_source','get_task_detail'])assert.throws(()=>scopeManagementInput(f.wb,name,{task_id:s.tid},caller),/尚未关联/);
    assert.throws(()=>scopeManagementInput(f.wb,'manage_tasks',{change:{action:'create_release',data:{source_task_id:s.tid,source_run_id:s.rid}}},caller),/尚未关联/);
    const brief:any=await readManagement(f.wb,{} as any,'get_task_detail',{task_id:s.tid});assert.equal(brief.detail,'brief');assert.equal(brief.task.current_run_id,s.rid);assert(Buffer.byteLength(JSON.stringify(brief))<=20*1024);
    const full:any=await readManagement(f.wb,{} as any,'get_task_detail',{task_id:s.tid,detail:'full'});assert.equal(full.runs[0].id,s.rid);
  }finally{f.wb.close();}
});
