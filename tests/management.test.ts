import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {fixture,setup,event,taskInput,finishCloseout} from './helpers.ts';
import {Workbench} from '../src/core/workbench.ts';
import {createApp} from '../src/server/app.ts';
import {managementTools,managementReadTools,manage} from '../src/core/management.ts';
import {reviewAssignmentContext,startReview,submitReviewResult,exportReviewOrder} from '../src/core/review-workflow.ts';

const instruction='隔离测试用户原话：请替我保存并办理本次操作。';
const input=(change:any)=>({request_id:crypto.randomUUID(),user_instruction:instruction,change});
async function api(){
  const f=fixture();f.wb.close();const {app,wb,integrations}=await createApp(f.config,{background:false});
  const post=async(tool:string,body:any,token=wb.keys.manager)=>{const r=await app.inject({method:'POST',url:'/api/mcp/'+tool,headers:{host:'127.0.0.1:'+f.config.port,authorization:'Bearer '+token},payload:body});return {status:r.statusCode,data:r.json()}};
  const run=async(tool:string,change:any)=>{const r=await post(tool,input(change));assert.equal(r.status,200,JSON.stringify(r.data));return r.data.result};
  const confirm=async(id:string)=>{const boot=await app.inject({url:'/api/bootstrap',headers:{host:'127.0.0.1:'+f.config.port}});const r=await app.inject({method:'POST',url:'/api/user-decisions/'+id+'/confirm',headers:{host:'127.0.0.1:'+f.config.port,cookie:String(boot.headers['set-cookie']).split(';')[0],'x-workbench-csrf':boot.json().csrf},payload:{}});assert.equal(r.statusCode,200,r.body);return r.json().result.outcome};
  return {...f,app,wb,integrations,post,run,confirm};
}
const member={version:0,preset_id:null,name:'隔离测试团队',scope:'开发测试',restriction:'',model:null,icon_key:'auto',allowed_kinds:['engineering','review'],models:[{id:'test-model',name:'隔离模型',purpose:'仅用于测试'}]};

test('会话管理 HTTP：备忘→编辑→现在开始→规划→执行单，版本和幂等原话可追溯',async()=>{
  const f=await api();try{
    const body=input({action:'create',data:{project_id:'P-workbench',text:'隔离测试，先记下未来需求',status:'draft'}});
    const first=await f.post('manage_requests',body);assert.equal(first.status,200);let q=first.data.result;
    assert.deepEqual(await f.post('manage_requests',body),first);assert.equal(f.wb.all('requests').length,1);
    assert.equal((await f.post('manage_requests',{...body,change:{...body.change,data:{...body.change.data,text:'改变原内容'}}})).status,409);
    const context=await f.post('get_management_context',{section:'requests',project_id:'P-workbench'});assert.equal(context.data.requests[0].version,1);
    q=await f.run('manage_requests',{action:'update',request_id:q.id,data:{project_id:q.project_id,text:'隔离测试，改好并现在开始',status:'awaiting_planning',version:1}});
    const entry=await f.post('get_planning_entry',{request_id:q.id});assert.match(entry.data.text,/expected_version=2/);
    const planned=await f.post('submit_task_plan',{schema_version:1,plan_id:crypto.randomUUID(),request_id:q.id,expected_version:2,tasks:[taskInput(f.root)]});assert.equal(planned.status,200);
    const tid=planned.data.task_ids[0],order=await f.post('export_execution_order',{task_id:tid,expected_version:1});assert.equal(order.status,200);assert(fs.existsSync(order.data.path));
    assert.equal(f.wb.get('tasks',tid).status,'awaiting_dispatch');
    await f.run('manage_tasks',{action:'dispatch',task_id:tid,revision:f.wb.get('tasks',tid).revision});assert.equal(f.wb.get('tasks',tid).status,'dispatched');
    assert.equal((await f.post('manage_requests',input({action:'delete',request_id:q.id,version:2}))).status,409);
    await f.run('manage_tasks',{action:'cancel',task_id:tid,revision:f.wb.get('tasks',tid).revision});
    const audit=f.wb.db.prepare("SELECT data FROM audit WHERE actor='manager'").all() as any[];assert(audit.length>3);assert(audit.every(a=>JSON.parse(a.data).user_instruction===instruction));
    assert.equal((await f.post('get_management_result',{request_id:body.request_id})).data.status,'completed');
  }finally{await f.app.close()}
});

test('会话管理 HTTP：项目登记、资料、路径、归档恢复与删除备忘',async()=>{
  const f=await api();try{
    const target=path.join(f.root,'新项目');let p=await f.run('manage_projects',{action:'create',name:'隔离项目',path:target,create:true,authorize:true});assert(fs.statSync(target).isDirectory());
    p=await f.run('manage_projects',{action:'update',project_id:p.id,data:{version:p.version,changes:{name:'新名称',goal:'项目目标',stage:'准备',next_step:'先记需求'}}});
    const second=path.join(f.root,'关联目录');fs.mkdirSync(second);p=await f.run('manage_projects',{action:'add_path',project_id:p.id,path:second,version:p.version});assert.equal(p.paths.length,2);
    const q=await f.run('manage_requests',{action:'create',data:{project_id:p.id,text:'删除测试备忘',status:'draft'}});
    await f.run('manage_requests',{action:'delete',request_id:q.id,version:q.version});assert(!f.wb.all('requests').some(x=>x.id===q.id));
    p=await f.run('manage_projects',{action:'archive',project_id:p.id,version:p.version,archived:true});assert(p.archived);
    p=await f.run('manage_projects',{action:'archive',project_id:p.id,version:p.version,archived:false});assert.equal(p.archived,false);
    assert.equal((await f.post('manage_settings',input({action:'authorize_root',path:path.parse(f.root).root}))).status,400);
    assert.equal((await f.post('manage_settings',input({action:'authorize_root',path:f.config.dataDir}))).status,400);
  }finally{await f.app.close()}
});

test('会话管理 HTTP：团队模型、额度与月积分、订阅和安排全周期',async()=>{
  const f=await api();try{
    let a=await f.run('manage_agents',{action:'create',data:member});
    a=await f.run('manage_agents',{action:'update',agent_id:a.id,data:{...member,name:'隔离更新团队',version:a.version,models:[{id:'model-2',name:'新测试模型',purpose:'核对派单'}]}});
    const data={version:0,source_ref:null,name:'隔离额度',members:[a.id],windows:[{label:'月积分',metric:'points',remaining:3200,limit:null,currency:null,unit:'积分',resets_at:null,monthly:{allowance:500,remaining:500}}]};
    let q=await f.run('manage_quotas',{action:'create',data});
    q=await f.run('manage_quotas',{action:'update',quota_id:q.id,data:{...data,name:'更新额度',version:q.version}});
    q=await f.run('manage_quotas',{action:'delete',quota_id:q.id,version:q.version});assert(q.archived);
    q=await f.run('manage_quotas',{action:'restore',quota_id:q.id,version:q.version});assert(!q.archived);
    const cache=f.wb.maybe('quota_cache','workbuddy-points');
    await f.run('manage_quotas',{action:'workbuddy_points',data:{version:cache?.version||0,remaining:3200,monthly:{allowance:500,remaining:500},resets_at:null}});
    const snapshot=(await f.post('get_management_context',{section:'resources'})).data;assert(snapshot.agent_presets.length>=42);assert(snapshot.model_catalog.find((g:any)=>g.agent_id===a.id).models.some((m:any)=>m.id==='model-2'));
    let sub=await f.run('manage_subscriptions',{action:'create',data:{title:'隔离计划',status:'planned',planned_date:'2026-12-17'}});
    sub=await f.run('manage_subscriptions',{action:'update',subscription_id:sub.id,version:sub.version,changes:{title:'更新计划',amount:10,currency:'USD',interval:'month'}});
    const actual=await f.run('manage_subscriptions',{action:'confirm',subscription_id:sub.id,version:sub.version,occurred_at:new Date(Date.now()-1000).toISOString(),note:'隔离用户报告已发生',end_date:null});assert.equal(actual.source,'user_confirmed');
    await f.run('manage_subscriptions',{action:'delete',subscription_id:actual.id,version:actual.version});
    a=await f.run('manage_agents',{action:'delete',agent_id:a.id,version:a.version});assert(a.archived);
    a=await f.run('manage_agents',{action:'restore',agent_id:a.id,version:a.version});assert(!a.archived);
  }finally{await f.app.close()}
});

test('用户在会话回答、执行者独立交付、用户确认退回后新开 Run，旧成果保留',async()=>{
  const f=await api();try{
    const s=setup(f.wb,f.root);f.wb.event(event(f.root,s.tid,s.rid,1));
    const question=f.wb.event(event(f.root,s.tid,s.rid,2,'waiting_input',{message:'隔离问题：选哪个方案？'}));
    const reply=await f.run('manage_tasks',{action:'reply',task_id:s.tid,data:{run_id:s.rid,question_event_id:question.id,revision:f.wb.get('tasks',s.tid).revision,message:'用户在会话说选择第二个'}});assert.equal(reply.message,'用户在会话说选择第二个');assert.equal(f.wb.get('tasks',s.tid).status,'waiting_input');
    f.wb.event(event(f.root,s.tid,s.rid,3));
    const token=JSON.parse(fs.readFileSync(path.join(f.config.dataDir,'run-keys',s.rid+'.json'),'utf8')).token;
    const delivered=await f.post('submit_run_result',event(f.root,s.tid,s.rid,4,'submitted',{result:'隔离执行者通过独立Run连接回传交付，仅为测试材料。'}),token);assert.equal(delivered.status,200);assert.equal(delivered.data.disposition,'applied');assert.equal(delivered.data.source,'mcp_runner');
    const artifacts=f.wb.all('artifacts').filter(a=>a.run_id===s.rid),read=await f.post('read_artifact',{artifact_id:artifacts[0].id});assert.equal(read.status,200);assert.match(read.data.content,/隔离/);
    const proposal=await f.run('manage_tasks',{action:'reject',task_id:s.tid,run_id:s.rid,revision:f.wb.get('tasks',s.tid).revision,note:'用户明确说做得不合适，需重新处理',artifact_hashes:artifacts.map(a=>a.sha256)});
    assert.equal(f.wb.get('tasks',s.tid).status,'submitted');const rejected=await f.confirm(proposal.decision_id);
    const next=await f.run('manage_tasks',{action:'rework',task_id:s.tid,revision:rejected.task.revision,feedback_id:rejected.feedback.id});assert.notEqual(next.run_id,s.rid);assert(fs.existsSync(s.order.path));assert.equal(f.wb.get('runs',s.rid).status,'submitted');
    const m=await f.run('manage_memories',{project_id:'P-workbench',kind:'decision',content:'隔离测试：会话中的决定可直接记录',status:'confirmed',source_id:s.tid});assert.equal(m.status,'confirmed');
    f.wb.upsertSession({native_id:'management-test',agent:'codex',source:'agentsview',source_id:'management-test',title:'隔离会话'});
    const session=f.wb.all('sessions').find(x=>x.sources?.some((y:any)=>y.source_id==='management-test'))!;
    assert.equal((await f.run('link_execution_session',{session_id:session.id,run_id:next.run_id})).run_id,next.run_id);
  }finally{await f.app.close()}
});

test('管理会话只能准备已有结论的改派和验收，用户页面确认后生效；其他角色不能提升权限',async()=>{
  const f=await api();try{
    const s=setup(f.wb,f.root);f.wb.event(event(f.root,s.tid,s.rid,1));f.wb.event(event(f.root,s.tid,s.rid,2,'submitted',{result:'隔离测试交付，所有审查结论均来自测试夹具。'}));
    const order=await f.run('manage_reviews',{action:'assign',data:{run_id:s.rid,reviewer_id:'claude',expected_revision:f.wb.get('tasks',s.tid).revision,reason:'隔离用户指定 Claude'}});
    startReview(f.wb,{review_id:order.review_id,identity:'claude'});
    const report={...order.context.final_response,review_id:order.review_id,verdict:'changes_requested',findings:['隔离问题需修复'],limitations:['测试夹具'],evidence:['隔离测试'],report_markdown:'隔离审查报告，验证用户授权管理和独立审查边界。'};
    const original=submitReviewResult(f.wb,report,'reviewer:'+order.review_id).review;
    const runner=JSON.parse(fs.readFileSync(path.join(f.config.dataDir,'run-keys',s.rid+'.json'),'utf8')).token;
    const reviewer=JSON.parse(fs.readFileSync(path.join(f.config.dataDir,'review-keys',order.review_id+'.json'),'utf8')).token;
    for(const token of [runner,reviewer,f.wb.keys.planner])for(const name of Object.keys({...managementTools,...managementReadTools})){
      const r=await f.post(name,{...input({}),run_id:s.rid,review_id:order.review_id},token);assert.equal(r.status,403,name);
    }
    const assign={run_id:s.rid,reviewer_id:'zcode',expected_revision:f.wb.get('tasks',s.tid).revision,reason:'隔离用户明确改派 Zcode'};
    assert.equal((await f.post('export_review_order',assign)).status,403); // Even manager's ordinary planning route cannot silently revoke.
    const proposal=await f.run('manage_reviews',{action:'assign',data:assign});assert(!f.wb.get('reviews',original.id).revoked_at);assert.equal(f.wb.get('tasks',s.tid).status,'changes_requested');const replacement=await f.confirm(proposal.decision_id);assert.equal(f.wb.get('reviews',original.id).report_markdown,original.report_markdown);assert(f.wb.get('reviews',original.id).revoked_at);
    startReview(f.wb,{review_id:replacement.review_id,identity:'zcode'});
    const imported=submitReviewResult(f.wb,{...replacement.context.final_response,review_id:replacement.review_id,verdict:'passed',findings:[],limitations:['隔离测试'],evidence:['隔离用户转来审查者报告'],report_markdown:'隔离 Zcode 报告通过，只验证流程，不代表生产结果。'},'reviewer:'+replacement.review_id);assert.equal(imported.review.source,'reviewer_submission');
    const accept=()=>input({action:'accept',task_id:s.tid,run_id:s.rid,revision:f.wb.get('tasks',s.tid).revision});
    assert.equal((await f.post('manage_tasks',accept())).status,409);
    finishCloseout(f.wb,s.tid);const r=await f.post('manage_tasks',accept());assert.equal(r.status,200,JSON.stringify(r.data));assert.equal(r.data.status,'awaiting_user_confirmation');assert.equal(f.wb.get('tasks',s.tid).status,'awaiting_confirmation');const accepted=await f.confirm(r.data.result.decision_id);assert.equal(accepted.status,'accepted');assert.equal(accepted.acceptance_record.mode,'user_experience');
  }finally{await f.app.close()}
});

test('管理操作版本冲突回滚、缺少用户原话拒绝，重启后记录与独立密钥保留',async()=>{
  const f=fixture();const oldPlanner=f.wb.keys.planner;f.wb.close();fs.writeFileSync(path.join(f.config.dataDir,'keys.json'),JSON.stringify({planner:oldPlanner}));
  let wb=new Workbench(f.config);try{
    assert.equal(wb.keys.planner,oldPlanner);const manager=wb.keys.manager;assert(manager&&manager!==oldPlanner);
    const services={} as any,body=input({action:'create',data:{project_id:'P-workbench',text:'隔离持久化备忘',status:'draft'}});
    const first=await manage(wb,services,'manage_requests',body);
    const bad=input({action:'update',request_id:first.result.id,data:{project_id:'P-workbench',text:'错误版本',version:90}});
    await assert.rejects(manage(wb,services,'manage_requests',bad),/需求已更新/);assert(!wb.maybe('management_calls',bad.request_id));assert.equal(wb.get('requests',first.result.id).version,1);
    await assert.rejects(manage(wb,services,'manage_requests',{...body,request_id:crypto.randomUUID(),user_instruction:''}));
    const put=wb.put.bind(wb);wb.put=((table,row,refs)=>{if(table==='management_calls')throw Error('隔离模拟存储失败');return put(table,row,refs)}) as typeof wb.put;
    await assert.rejects(manage(wb,services,'manage_requests',input({action:'create',data:{project_id:'P-workbench',text:'应当回滚'}})),/模拟存储失败/);wb.put=put;assert.equal(wb.all('requests').length,1);
    // Listener starts another transaction only after outer COMMIT and depth reset.
    wb.once('change',()=>wb.transaction(()=>wb.audit('test','listener','test')));wb.transaction(()=>wb.audit('test','outer','test'));
    wb.close();wb=new Workbench(f.config);assert.equal(wb.keys.manager,manager);assert.deepEqual(await manage(wb,services,'manage_requests',body),first);assert.equal(wb.all('requests').length,1);
  }finally{wb.close()}
});

test('异步操作重复/失败/重启中断可查询；配置本机数据源并保护内部凭据',async()=>{
  const f=await api();try{
    let release!:()=>void,calls=0;
    const services={integrations:f.integrations,revealArtifact:async()=>{},readReviewTrace:async()=>{throw Error('not used')},openProject:async()=>{calls++;await new Promise<void>(r=>release=r);return {opened:true}}} as any;
    const body=input({action:'project',project_id:'P-workbench'}),pending=manage(f.wb,services,'open_workbench_folder',body);
    await assert.rejects(manage(f.wb,services,'open_workbench_folder',body),/仍在处理/);assert.equal(f.wb.get('management_calls',body.request_id).status,'pending');release();await pending;await manage(f.wb,services,'open_workbench_folder',body);assert.equal(calls,1);
    const interrupted=input({action:'project',project_id:'P-workbench'});f.wb.put('management_calls',{id:interrupted.request_id,digest:'interrupted',status:'pending'});assert.equal((await f.post('get_management_result',{request_id:interrupted.request_id})).data.status,'pending');
    for(const base_url of ['https://example.com','http://127.0.0.1@evil.test','file:///data'])assert.equal((await f.post('manage_settings',input({action:'configure_integration',integration_id:'tokenMonitor',base_url}))).status,400);
    assert.equal((await f.post('manage_settings',input({action:'configure_integration',integration_id:'tokenMonitor',base_url:'http://127.0.0.1:17321',secret_file:path.join(f.config.dataDir,'keys.json')}))).status,400);
    const configured=await f.run('manage_settings',{action:'configure_integration',integration_id:'tokenMonitor',base_url:'http://127.0.0.1:17321'});assert(configured.restart_required);assert.equal(f.config.integrations.tokenMonitor.baseUrl,'');assert.equal(JSON.parse(fs.readFileSync(path.join(f.root,'config/local.json'),'utf8')).integrations.tokenMonitor.baseUrl,'http://127.0.0.1:17321');
    const settings=(await f.post('get_management_context',{section:'integrations'})).data.connection_settings.tokenMonitor;assert.equal(settings.base_url,'http://127.0.0.1:17321');assert.equal(settings.active_base_url,'');assert(settings.restart_required);
    const offline=await f.run('refresh_integration',{integration_id:'tokenMonitor'});assert.equal(offline.status,'not_connected');assert(!offline.snapshot);
    const backup=await f.run('create_workbench_backup',{});const db=new DatabaseSync(path.join(backup.path,'workbench.sqlite'),{readOnly:true});try{assert(db.prepare('SELECT COUNT(*) n FROM management_calls').get()!.n as number>0)}finally{db.close()};assert.equal(JSON.parse(fs.readFileSync(path.join(backup.path,'keys.json'),'utf8')).manager,f.wb.keys.manager);
  }finally{await f.app.close()}
});
