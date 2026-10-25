import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {fixture,setup} from './helpers.ts';
import {contextContractSchema,fileContextSnapshot,readContractFile,taskFileScope,validateTaskContextContract} from '../src/core/file-context.ts';
import {acknowledgeContext,executionContext,readRunContextFile} from '../src/core/execution-context.ts';
import {acknowledgeReviewContext,bindReviewContextSession,readReviewContextFile,reviewContext} from '../src/core/review-context.ts';
import type {Row} from '../src/core/schema.ts';

function contracted(){const f=fixture(),s=setup(f.wb,f.root);fs.writeFileSync(path.join(f.root,'source.ts'),'first\nsecond\nthird\n');const task=f.wb.get('tasks',s.tid);task.context_contract={required:[{path:'source.ts'}],supplemental:[],output_dir:'output',max_bytes:1024};f.wb.put('tasks',task,{project_id:task.project_id});return {...f,...s,task}}
function putTask(f:ReturnType<typeof contracted>){f.wb.put('tasks',f.task,{project_id:f.task.project_id})}
function assignment(f:ReturnType<typeof contracted>,session='review-session',reviewer='grok-build'){
  const a={id:'RA-'+crypto.randomUUID(),run_id:f.rid,reviewer_id:reviewer,review_digest:crypto.randomBytes(32).toString('hex'),status:'running',session_id:session};
  f.wb.put('review_assignments',a,{run_id:f.rid});f.task=f.wb.get('tasks',f.tid);f.task.current_review_assignment_id=a.id;putTask(f);
  const base={review_id:a.id,task_id:f.tid,run_id:f.rid,review_digest:a.review_digest,artifacts:[],review_files:[{path:'source.ts',sha256:'fixture'}],report_template:{}};return {a,base};
}

test('文件合同限制范围和预算，旧任务不声称已读源码',()=>{
  assert.throws(()=>contextContractSchema.parse({required:[{path:'a',range:{start_line:3,end_line:2}}],output_dir:'out'}));
  assert.throws(()=>contextContractSchema.parse({required:[],output_dir:'out',max_bytes:262145}));
  assert.throws(()=>contextContractSchema.parse({required:[{path:'src/**'}],output_dir:'out'}));
  const f=fixture();try{const s=setup(f.wb,f.root),c=executionContext(f.wb,{run_id:s.rid});assert.equal(c.context.file_context.source_knowledge,'unknown');assert.deepEqual(c.context.file_context.files,[]);assert.equal(c.reading.model_reading,'unknown');assert.equal(c.usage.token_count,null)}finally{f.wb.close()}
});

test('版本哈希覆盖实际内容与片段范围，旧确认失效且未知hash重置',()=>{
  const f=contracted();try{
    const first=executionContext(f.wb,{run_id:f.rid});acknowledgeContext(f.wb,{run_id:f.rid,context_hash:first.context_hash,session_id:'runner'});
    assert.deepEqual(executionContext(f.wb,{run_id:f.rid,mode:'delta',known_context_hash:first.context_hash}).context,{});
    const file=path.join(f.root,'source.ts'),stat=fs.statSync(file);fs.writeFileSync(file,'FIRST\nsecond\nthird\n');fs.utimesSync(file,stat.atime,stat.mtime);
    const changed=executionContext(f.wb,{run_id:f.rid,mode:'delta',known_context_hash:first.context_hash});assert.notEqual(changed.context_hash,first.context_hash);assert.equal(changed.file_changes.length,1);assert.throws(()=>acknowledgeContext(f.wb,{run_id:f.rid,context_hash:first.context_hash}),/变化/);
    f.task.context_contract.required[0].range={start_line:2,end_line:2};putTask(f);const range=executionContext(f.wb,{run_id:f.rid,mode:'delta',known_context_hash:changed.context_hash});assert.notEqual(range.context_hash,changed.context_hash);
    const reset=executionContext(f.wb,{run_id:f.rid,mode:'delta',known_context_hash:'unknown'});assert.equal(reset.reset_required,true);assert.equal(reset.mode,'brief');assert(!('original_request' in reset.context));
  }finally{f.wb.close()}
});

test('文件阅读按合同片段和累计UTF-8字节限额提供，补读需要指定条件',()=>{
  const f=contracted();try{
    fs.writeFileSync(path.join(f.root,'source.ts'),'excluded\n'+'字'.repeat(100)+'\n'+'文'.repeat(100)+'\n');fs.writeFileSync(path.join(f.root,'extra.txt'),'conditional detail');
    f.task.context_contract.required=[{path:'source.ts',range:{start_line:2,end_line:3}}];f.task.context_contract.supplemental=[{path:'extra.txt',reason:'必读资料没有解释失败原因'}];putTask(f);
    assert.throws(()=>readRunContextFile(f.wb,{run_id:f.rid,path:'source.ts'}),/合同/);
    assert.throws(()=>readRunContextFile(f.wb,{run_id:f.rid,path:'source.ts',range:{start_line:1,end_line:2}}),/合同/);
    const read=readRunContextFile(f.wb,{run_id:f.rid,path:'source.ts',range:{start_line:2,end_line:3}});assert.equal(read.usage.bytes,602);assert(!read.content.includes('excluded'));assert.equal(read.record.status,'delivered');assert.equal(read.usage.token_count,null);
    assert.throws(()=>readRunContextFile(f.wb,{run_id:f.rid,path:'source.ts',range:{start_line:2,end_line:3}}),/预算/);
    assert.throws(()=>readRunContextFile(f.wb,{run_id:f.rid,path:'extra.txt'}),/合同/);assert.throws(()=>readRunContextFile(f.wb,{run_id:f.rid,path:'extra.txt',reason:'任意理由'}),/合同/);
    const extra=readRunContextFile(f.wb,{run_id:f.rid,path:'extra.txt',reason:'必读资料没有解释失败原因'});assert.equal(extra.condition_evidence,'caller_attested_condition');
    assert.equal(executionContext(f.wb,{run_id:f.rid}).reading.files_delivered.length,2);
  }finally{f.wb.close()}
});

test('读取合同与写权限分离，保护路径、穿越、链接和疑似密钥不能泄露',()=>{
  const f=contracted();try{
    const out=path.join(f.root,'output');fs.mkdirSync(out);f.task.allowed_paths=[out];putTask(f);assert(validateTaskContextContract(f.wb,f.task));assert.equal(readRunContextFile(f.wb,{run_id:f.rid,path:'source.ts'}).content,'first\nsecond\nthird\n');
    f.task.context_contract.output_dir='elsewhere';assert.throws(()=>validateTaskContextContract(f.wb,f.task),/修改范围/);f.task.context_contract.output_dir='output';
    for(const name of ['.git','hidden','.codex']){const dir=path.join(f.root,name);fs.mkdirSync(dir);fs.writeFileSync(path.join(dir,'private.txt'),'PRIVATE_VALUE')}
    fs.writeFileSync(path.join(f.root,'data','private.txt'),'PRIVATE_VALUE');fs.writeFileSync(path.join(f.root,'credentials.json'),'PRIVATE_VALUE');
    f.task.protected_paths.push(path.join(f.root,'hidden'));putTask(f);
    const link=path.join(f.root,'shortcut');fs.symlinkSync(path.join(f.root,'data'),link,'junction');
    for(const name of ['.git/private.txt','.codex/private.txt','data/private.txt','hidden/private.txt','credentials.json','shortcut/private.txt','../outside.txt']){
      f.task.context_contract.required=[{path:name}];assert.throws(()=>validateTaskContextContract(f.wb,f.task));const scope=taskFileScope(f.wb,f.task);assert.throws(()=>readContractFile(scope,{path:name}));assert(!JSON.stringify(fileContextSnapshot(scope)).includes('PRIVATE_VALUE'));
    }
    fs.writeFileSync(path.join(f.root,'source.ts'),'-----BEGIN PRIVATE KEY-----\nQUJDREVGSElKS0xNTk9QUVJTVFVWV1g=');f.task.context_contract.required=[{path:'source.ts'}];putTask(f);assert.throws(()=>readRunContextFile(f.wb,{run_id:f.rid,path:'source.ts'}),/疑似凭据/);
  }finally{f.wb.close()}
});

test('文件指纹限额失败时保留未知，跨Task不能继承执行缓存',()=>{
  const f=contracted();try{
    fs.writeFileSync(path.join(f.root,'source.ts'),Buffer.alloc(4*1024*1024+1,97));const big=executionContext(f.wb,{run_id:f.rid});assert.equal(big.context.file_context.files[0].file_sha256,null);assert.equal(big.context.file_context.files[0].status,'size_limit');
    const other=setup(f.wb,f.root),r=f.wb.get('runs',other.rid);r.retry_context={previous_run_id:f.rid};r.context_cache=f.wb.get('runs',f.rid).context_cache;f.wb.put('runs',r,{task_id:other.tid});const reset=executionContext(f.wb,{run_id:other.rid,mode:'delta',known_context_hash:big.context_hash});assert.equal(reset.reset_required,true);assert(!JSON.stringify(reset.context).includes(f.tid));
  }finally{f.wb.close()}
});

test('审查独立建立上下文，同任务同审查会话按版本复用，换人或换会话重置',()=>{
  const f=contracted();try{
    const runner=executionContext(f.wb,{run_id:f.rid}),first=assignment(f),initial=reviewContext(f.wb,{review_id:first.a.id,mode:'delta',known_context_hash:runner.context_hash},first.base);assert.equal(initial.reset_required,true);
    acknowledgeReviewContext(f.wb,{review_id:first.a.id,context_hash:initial.context_hash,session_id:'review-session'},first.base);
    assert.deepEqual(reviewContext(f.wb,{review_id:first.a.id,mode:'delta',known_context_hash:initial.context_hash,session_id:'review-session'},first.base).context,{});
    const file=readReviewContextFile(f.wb,{review_id:first.a.id,path:'source.ts'},first.base);assert.equal(file.record.status,'delivered');assert.equal(file.usage.token_count,null);
    const second=assignment(f),continued=reviewContext(f.wb,{review_id:second.a.id,mode:'delta',known_context_hash:initial.context_hash},second.base);assert.equal(continued.mode,'delta');assert.equal(continued.context.review_digest,second.a.review_digest);assert(!('goal' in continued.context));
    const changedSession=reviewContext(f.wb,{review_id:second.a.id,mode:'delta',known_context_hash:initial.context_hash,session_id:'different'},second.base);assert.equal(changedSession.reset_required,true);
    const different=assignment(f,'review-session','deepseek');assert.equal(reviewContext(f.wb,{review_id:different.a.id,mode:'delta',known_context_hash:initial.context_hash},different.base).reset_required,true);
    assert.throws(()=>acknowledgeReviewContext(f.wb,{review_id:different.a.id,context_hash:initial.context_hash,session_id:'wrong'},different.base),/会话/);
  }finally{f.wb.close()}
});

test('审查同Task跨Run追踪新交付与未解决意见，跨Task禁止复用',()=>{
  const f=contracted();try{
    const first=assignment(f),prior=reviewContext(f.wb,{review_id:first.a.id},first.base),old=f.wb.get('runs',f.rid),newId='R-'+crypto.randomUUID();
    f.wb.put('runs',{...old,id:newId,retry_context:{previous_run_id:old.id,reviews:[{id:'finding',verdict:'changes_requested',findings:'验证片段范围'}]}},{task_id:f.tid});f.task=f.wb.get('tasks',f.tid);f.task.current_run_id=newId;putTask(f);f.rid=newId;
    const second=assignment(f),delta=reviewContext(f.wb,{review_id:second.a.id,mode:'delta',known_context_hash:prior.context_hash},second.base);assert.equal(delta.mode,'delta');assert.equal(delta.context.run_id,newId);assert.equal(delta.context.previous_findings[0].findings,'验证片段范围');assert.notEqual(delta.context_hash,prior.context_hash);
    const other=setup(f.wb,f.root),g={...f,...other,task:f.wb.get('tasks',other.tid)},third=assignment(g),a=f.wb.get('review_assignments',third.a.id);a.context_cache=f.wb.get('review_assignments',first.a.id).context_cache;f.wb.put('review_assignments',a,{run_id:other.rid});assert.equal(reviewContext(f.wb,{review_id:third.a.id,mode:'delta',known_context_hash:prior.context_hash},third.base).reset_required,true);
  }finally{f.wb.close()}
});

test('首次无会话投递由真实job绑定，续审预计会话只供增量且不伪造ack',()=>{
  const f=contracted();try{
    const first=assignment(f,''),jid='AJ-'+crypto.randomUUID(),route={client:'dsh',model:'test',provider:'fixture'};
    const job:Row={id:jid,task_id:f.tid,run_id:f.rid,review_id:first.a.id,role:'review',route,status:'running',session_id:null};f.wb.put('agent_jobs',job,{run_id:f.rid});
    const sent=reviewContext(f.wb,{review_id:first.a.id},first.base,jid);assert.equal(f.wb.get('review_assignments',first.a.id).context_cache[0].session_id,null);
    assert.throws(()=>bindReviewContextSession(f.wb,first.a.id,jid),/实际会话/);
    job.session_id='actual-session';job.status='completed';f.wb.put('agent_jobs',job,{run_id:f.rid});const actual=f.wb.get('review_assignments',first.a.id);actual.session_id=job.session_id;f.wb.put('review_assignments',actual,{run_id:f.rid});
    const binding=bindReviewContextSession(f.wb,first.a.id,jid);assert.equal(binding.bound,1);assert.equal(binding.acknowledged,false);assert(!f.wb.get('review_assignments',first.a.id).context_ack);
    const second=assignment(f,''),next:Row={...job,id:'AJ-'+crypto.randomUUID(),review_id:second.a.id,status:'launching',session_id:null,resume_session_id:'actual-session',previous_job_id:jid};f.wb.put('agent_jobs',next,{run_id:f.rid});
    const input={review_id:second.a.id,mode:'delta',known_context_hash:sent.context_hash,session_id:'actual-session'};
    assert.equal(reviewContext(f.wb,input,second.base).reset_required,true);
    const pending=reviewContext(f.wb,input,second.base,next.id);assert.equal(pending.mode,'delta');assert.equal(pending.continuation_pending,true);assert(!f.wb.get('review_assignments',second.a.id).session_id);assert.throws(()=>acknowledgeReviewContext(f.wb,{review_id:second.a.id,context_hash:pending.context_hash},second.base),/实际会话/);
    next.session_id='actual-session';next.status='running';f.wb.put('agent_jobs',next,{run_id:f.rid});const current=f.wb.get('review_assignments',second.a.id);current.session_id='actual-session';f.wb.put('review_assignments',current,{run_id:f.rid});assert.equal(bindReviewContextSession(f.wb,second.a.id,next.id).bound,1);
    const resumed=reviewContext(f.wb,{...input,known_context_hash:pending.context_hash},second.base);assert.equal(resumed.mode,'delta');assert.equal(resumed.continuation_pending,false);assert.equal(resumed.reading.acknowledgement,'not_acknowledged');
    next.session_mismatch=true;f.wb.put('agent_jobs',next,{run_id:f.rid});assert.throws(()=>bindReviewContextSession(f.wb,second.a.id,next.id),/实际会话/);
    next.route={...route,model:'different'};f.wb.put('agent_jobs',next,{run_id:f.rid});assert.throws(()=>reviewContext(f.wb,input,second.base,next.id),/续审/);
  }finally{f.wb.close()}
});

test('合同内其他文件或当前文件内容改变均不能重置累计阅读预算',()=>{
  const f=contracted();try{
    fs.writeFileSync(path.join(f.root,'source.ts'),'a'.repeat(600));fs.writeFileSync(path.join(f.root,'other.txt'),'initial');
    f.task.context_contract.required.push({path:'other.txt'});putTask(f);
    const before=fileContextSnapshot(taskFileScope(f.wb,f.task)),first=readRunContextFile(f.wb,{run_id:f.rid,path:'source.ts'});
    assert.equal(first.budget.delivered_bytes,600);assert.equal(first.record.budget_key,before.budget_key);
    fs.writeFileSync(path.join(f.root,'other.txt'),'changed unrelated contract content');
    const after=fileContextSnapshot(taskFileScope(f.wb,f.task));assert.notEqual(after.scope_hash,before.scope_hash);assert.equal(after.budget_key,before.budget_key);
    assert.throws(()=>readRunContextFile(f.wb,{run_id:f.rid,path:'source.ts'}),/预算不足/);
    fs.writeFileSync(path.join(f.root,'source.ts'),'b'.repeat(600));
    assert.throws(()=>readRunContextFile(f.wb,{run_id:f.rid,path:'source.ts'}),/文件内容已变化，已用额度仍累计/);
    const changed=fileContextSnapshot(taskFileScope(f.wb,f.task));assert.equal(changed.budget_key,before.budget_key);assert.notEqual(changed.scope_hash,after.scope_hash);
    assert.equal(f.wb.get('runs',f.rid).context_reads.length,1);
  }finally{f.wb.close()}
});

test('单次读取只打开指定合同文件并报告旧指纹变化，额度持续累计',t=>{
  const f=contracted();try{
    fs.writeFileSync(path.join(f.root,'source.ts'),'a'.repeat(300)+'\n'+'b'.repeat(300)+'\n');fs.writeFileSync(path.join(f.root,'other.txt'),'不应在此读取中打开');
    f.task.context_contract.required.push({path:'other.txt'});putTask(f);const scope=taskFileScope(f.wb,f.task),records:Row[]=[],opened:string[]=[];
    const original=fs.openSync;
    t.mock.method(fs,'openSync',(...args:Parameters<typeof fs.openSync>)=>{opened.push(String(args[0]));return original(...args)});
    const first=readContractFile(scope,{path:'source.ts',range:{start_line:1,end_line:1}},records);records.push(first.record);
    assert.equal(first.stale.status,'unknown');assert.equal(first.stale.reason,'no_previous_read_fingerprint');assert.equal(first.record.scope_hash,null);
    // Restore around the fixture write so the observation counts source reads only.
    t.mock.restoreAll();fs.writeFileSync(path.join(f.root,'source.ts'),'c'.repeat(300)+'\n'+'b'.repeat(300)+'\n');
    t.mock.method(fs,'openSync',(...args:Parameters<typeof fs.openSync>)=>{opened.push(String(args[0]));return original(...args)});
    const changed=readContractFile(scope,{path:'source.ts',range:{start_line:1,end_line:1}},records);records.push(changed.record);
    assert.equal(changed.stale.status,'changed');assert.equal(changed.stale.reason,'file_content_changed');assert.equal(changed.stale.previous_file_sha256,first.record.file_sha256);assert.equal(changed.stale.budget_reset,false);assert.equal(changed.budget.delivered_bytes,602);
    const same=readContractFile(scope,{path:'source.ts',range:{start_line:1,end_line:1}},records);records.push(same.record);assert.equal(same.stale.status,'unchanged');assert.equal(same.budget.delivered_bytes,903);assert.equal(same.budget.remaining_bytes,121);
    assert.deepEqual(opened,[path.join(f.root,'source.ts'),path.join(f.root,'source.ts'),path.join(f.root,'source.ts')]);
    assert.throws(()=>readContractFile(scope,{path:'source.ts',range:{start_line:2,end_line:2}},records),/预算不足/);
    t.mock.restoreAll();
  }finally{t.mock.restoreAll();f.wb.close()}
});

test('缺少budget_key的旧记录保守计费，只有明确合同结构变更能建立新预算',()=>{
  const f=contracted();try{
    fs.writeFileSync(path.join(f.root,'source.ts'),'a'.repeat(300));let scope=taskFileScope(f.wb,f.task);
    const legacy:Row={task_id:f.tid,path:'source.ts',scope_hash:'obsolete-content-snapshot',file_sha256:'0'.repeat(64),status:'delivered',bytes:800};
    assert.throws(()=>readContractFile(scope,{path:'source.ts'},[legacy]),/预算不足/);
    fs.writeFileSync(path.join(f.root,'source.ts'),'b'.repeat(200));const first=readContractFile(scope,{path:'source.ts'},[legacy]);assert.equal(first.budget.delivered_bytes,1000);assert.equal(first.budget.legacy_records_charged,1);assert.equal(first.stale.reason,'file_content_changed');
    const oldBudget=first.record.budget_key;f.task.context_contract.max_bytes=2048;putTask(f);scope=taskFileScope(f.wb,f.task);
    const replanned=readContractFile(scope,{path:'source.ts'},[legacy,first.record]);assert.notEqual(replanned.record.budget_key,oldBudget);assert.equal(replanned.budget.delivered_bytes,1000);assert.equal(replanned.budget.legacy_records_charged,1);
    assert.throws(()=>readContractFile(scope,{path:'source.ts'},[{...legacy,bytes:-1}]),/账目字节数无效/);
    assert.throws(()=>readContractFile(scope,{path:'source.ts'},[{...legacy,budget_key:'invalid-key',bytes:2000}]),/预算不足/);
  }finally{f.wb.close()}
});
