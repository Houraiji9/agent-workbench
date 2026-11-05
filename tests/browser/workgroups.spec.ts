import {test,expect,type Page} from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {api,noHorizontalScroll,shot} from './support.ts';

// UI-only synthetic room transport. It never launches a real Agent or claims execution.
async function fixture(page:Page,{empty=false,messageCount=1}:{empty?:boolean;messageCount?:number}={}){
  const backend=await api(page),root=path.join(backend.root,'测试工作群-'+randomUUID());fs.mkdirSync(root,{recursive:true});
  const project=await backend.post('/projects',{name:'测试工作群项目',path:root});
  const members=[{id:'WM-codex',agent_id:'codex',name:'测试 Codex',role:'leader',client_id:'codex',status:'idle'},{id:'WM-claude',agent_id:'claude',name:'测试 Claude',role:'member',client_id:'claude',status:'idle'}];
  const room={id:'WG-test',project_id:project.id,name:'测试项目协作群',leader_member_id:members[0].id,revision:1,status:'active',allowed_paths:[root],auto_dispatch:true,max_followups:4};
  const state={room,members,rooms:empty?[]:[room],messages:Array.from({length:messageCount},(_,i)=>({id:'WM-message-'+(i+1),seq:i+1,sender:{kind:'user',id:'user',name:'测试用户'},kind:'message',content:'测试消息 '+(i+1)+'\n这是隔离界面夹具，不代表真实 Agent 执行。',created_at:'2026-11-04T10:00:00Z'})) as any[],jobs:[] as any[],calls:[] as {path:string;body:any;method:string}[],reads:[] as string[],rejectSend:false};
  const addMessage=(content:string,extra:Record<string,unknown>={})=>{const seq=(state.messages.at(-1)?.seq||0)+1;const message={id:'WM-message-'+seq,seq,sender:{kind:'user',id:'user',name:'测试用户'},kind:'message',content,created_at:'2026-11-04T10:00:00Z',...extra};state.messages.push(message);return message;};
  await page.route('**/api/workgroups**',async route=>{
    const request=route.request(),url=new URL(request.url()),pathname=url.pathname,method=request.method();
    if(method==='GET'){
      state.reads.push(url.pathname+url.search);
      if(pathname==='/api/workgroups')return route.fulfill({json:{rooms:state.rooms}});
      if(pathname==='/api/workgroups/candidates')return route.fulfill({json:{candidates:[{agent_id:'codex',available:true},{agent_id:'claude',available:true}]}});
      if(pathname.includes('/jobs/')){const job=state.jobs.find(j=>pathname.endsWith('/'+j.id));return route.fulfill({json:{job,member:state.members.find(m=>m.id===job.member_id),messages:state.messages.filter(m=>m.job_id===job.id)}});}
      const after=url.searchParams.get('after_seq'),before=url.searchParams.get('before_seq');
      const messages=after!==null?state.messages.filter(m=>m.seq>Number(after)).slice(0,100):before!==null?state.messages.filter(m=>m.seq<Number(before)).slice(-100):state.messages.slice(-100);
      return route.fulfill({json:{room:state.room,members:state.members,jobs:state.jobs,messages,first_seq:messages[0]?.seq||0,next_seq:messages.at(-1)?.seq||Number(after||0),has_older:(messages[0]?.seq||0)>1,has_more:messages.length===100&&messages.at(-1)?.seq<state.messages.at(-1)?.seq}});
    }
    const body=request.postDataJSON();state.calls.push({path:pathname,body,method});
    if(pathname==='/api/workgroups'){
      Object.assign(state.room,{name:body.name,allowed_paths:body.allowed_paths,max_followups:body.max_followups,leader_member_id:body.leader_agent_id==='claude'?'WM-claude':'WM-codex'});state.rooms=[state.room];return route.fulfill({json:{room:state.room,members}});
    }
    if(pathname.endsWith('/messages')){
      if(state.rejectSend)return route.fulfill({status:409,json:{error:'测试：群状态已变化，请重试'}});
      const message=addMessage(body.content,{reply_to:body.reply_to});const job=body.wake==='leader'?{id:'WJ-'+randomUUID(),member_id:state.room.leader_member_id,status:'queued',instruction:body.content,created_at:'2026-11-04T10:00:00Z'}:null;if(job)state.jobs.unshift(job);return route.fulfill({json:{message,job}});
    }
    if(pathname.endsWith('/dispatch')){const job={id:'WJ-'+randomUUID(),member_id:body.member_id,status:'queued',instruction:body.instruction,created_at:'2026-11-04T10:00:00Z'};state.jobs.unshift(job);addMessage(body.instruction,{kind:'dispatch',job_id:job.id});return route.fulfill({json:job});}
    if(pathname.endsWith('/update')){if(body.expected_revision!==state.room.revision)return route.fulfill({status:409,json:{error:'测试：群设置已变化'}});Object.assign(state.room,body,{revision:state.room.revision+1});return route.fulfill({json:state.room});}
    if(pathname.endsWith('/stop')){state.room.status='paused';state.room.revision++;for(const j of state.jobs)if(['running','queued'].includes(j.status))j.status='cancelled';return route.fulfill({json:{room:state.room}});}
    if(pathname.endsWith('/cancel')){const job=state.jobs.find(j=>pathname.includes(j.id));job.status='cancelled';return route.fulfill({json:job});}
    if(pathname.endsWith('/resume')){const job=state.jobs.find(j=>pathname.includes(j.id));job.status='queued';return route.fulfill({json:job});}
    return route.fulfill({status:400,json:{error:'测试夹具未定义此操作'}});
  });
  return {state,project,root,addMessage,goto:()=>page.goto('/#/workgroups/'+project.id)};
}

test('工作群从项目进入，创建一次范围授权，负责人可选择 Claude 并改为 Codex',async({page})=>{
  const f=await fixture(page,{empty:true});await page.goto('/#/projects/'+f.project.id);await page.getByRole('button',{name:'项目工作群',exact:true}).click();
  await page.getByRole('button',{name:'创建项目工作群',exact:true}).click();const dialog=page.getByRole('dialog',{name:'创建项目工作群'});
  await expect(dialog.getByLabel('群名称',{exact:true})).toHaveAttribute('maxlength','100');await expect(dialog.getByRole('combobox',{name:/^负责人/}).locator('option[value="grok-build"]')).toHaveJSProperty('disabled',true);await expect(dialog.getByRole('checkbox',{name:'Grok Build 尚无自动调用入口'})).toBeDisabled();await expect(dialog).toContainText('尚无自动调用入口');
  await dialog.getByLabel('群名称',{exact:true}).fill('测试互换负责人');await dialog.getByRole('combobox',{name:/^负责人/}).selectOption('claude');await dialog.getByRole('checkbox',{name:/Codex/}).check();
  await expect(dialog).toContainText('普通发言和派活不会重复请求群授权');await dialog.getByRole('button',{name:'创建并启用工作群'}).click();await expect(dialog).toHaveCount(0);
  expect(f.state.calls[0].body).toMatchObject({project_id:f.project.id,leader_agent_id:'claude',member_agent_ids:['claude','codex'],allowed_paths:[f.root],auto_dispatch:true,max_followups:4});
  await expect(page.getByRole('heading',{name:'测试互换负责人'})).toBeVisible();await page.getByRole('button',{name:'群设置',exact:true}).click();const settings=page.getByRole('dialog',{name:'工作群设置'});
  await settings.getByRole('combobox',{name:'负责人',exact:true}).selectOption('WM-codex');await settings.getByRole('button',{name:'保存群设置'}).click();await expect(settings).toHaveCount(0);
  expect(f.state.calls.at(-1)?.body).toMatchObject({expected_revision:1,leader_member_id:'WM-codex'});await expect(page.locator('.wg-room-head')).toContainText('负责人：测试 Codex');await shot(page,'工作群-负责人互换');
});

test('普通消息不派活，明确派活按成员发送，冲突保留草稿并复用幂等编号',async({page})=>{
  const f=await fixture(page);await f.goto();await page.getByLabel('发送方式').selectOption('message');await page.getByLabel('群消息或任务说明').fill('测试仅同步资料\n保留换行');
  f.state.rejectSend=true;await page.getByRole('button',{name:'发送消息',exact:true}).click();await expect(page.getByRole('alert')).toContainText('群状态已变化');await expect(page.getByLabel('群消息或任务说明')).toHaveValue('测试仅同步资料\n保留换行');
  f.state.rejectSend=false;await page.getByRole('button',{name:'发送消息',exact:true}).click();await expect(page.getByLabel('群消息或任务说明')).toHaveValue('');expect(f.state.calls[0].body.request_id).toBe(f.state.calls[1].body.request_id);expect(f.state.calls[1].body.wake).toBe('none');expect(f.state.jobs).toHaveLength(0);
  await page.getByLabel('发送方式').selectOption('dispatch');await page.getByLabel('执行成员').selectOption('WM-claude');await page.getByLabel('群消息或任务说明').fill('测试派活：核对接口并回报');await page.getByRole('button',{name:'派活',exact:true}).click();
  await expect(page.getByRole('article',{name:'测试 Claude · 已排队'})).toBeVisible();expect(f.state.calls.at(-1)?.body).toMatchObject({member_id:'WM-claude',instruction:'测试派活：核对接口并回报'});await expect(page.getByRole('dialog')).toHaveCount(0);
});

test('运行、回报和停止按真实返回状态显示，未确认退出不允许继续',async({page})=>{
  const f=await fixture(page);f.state.jobs=[{id:'WJ-running',member_id:'WM-codex',status:'running',instruction:'测试进行中的工作',created_at:'2026-11-04T10:00:00Z'},{id:'WJ-reported',member_id:'WM-claude',status:'completed',instruction:'测试已回报工作',created_at:'2026-11-04T10:00:00Z',session_id:'test-native-session',actual_model:'test-model',result:'测试回报：已核对三处接口；尚未经用户验收。',followup_status:'pending_budget'},{id:'WJ-unknown',member_id:'WM-claude',status:'interrupted',instruction:'测试未确认退出',process_may_be_running:true,created_at:'2026-11-04T10:00:00Z'}];
  await f.goto();
  const reported=page.getByRole('article',{name:'测试 Claude · 已回报'});await expect(reported).toBeVisible();await reported.getByRole('button',{name:'查看回报与详情'}).click();await expect(page.getByRole('dialog')).toContainText('尚未经用户验收');await expect(page.getByRole('dialog')).toContainText('test-native-session');await expect(page.getByRole('dialog')).toContainText('test-model');await expect(page.getByRole('dialog')).toContainText('自动接话次数已用完');expect(f.state.reads.some(url=>url.endsWith('/jobs/WJ-reported'))).toBe(true);await page.getByRole('dialog').getByRole('button',{name:'关闭',exact:true}).click();
  const interrupted=page.getByRole('article',{name:'测试 Claude · 已中断'});await expect(interrupted).toContainText('进程停止尚未确认');await expect(interrupted.getByRole('button',{name:'继续',exact:true})).toHaveCount(0);
  await page.getByRole('button',{name:'停止当前工作',exact:true}).click();await expect(page.locator('.wg-room-head')).toContainText('已暂停派发');await expect(page.getByRole('article',{name:'测试 Codex · 已停止'})).toBeVisible();await expect(page.getByRole('button',{name:'发送给负责人',exact:true})).toBeDisabled();expect(f.state.calls.at(-1)?.path).toMatch(/\/stop$/);
});

test('seq 分页与增量同步不重送全群，阅读旧消息时不抢滚动位置',async({page})=>{
  const f=await fixture(page,{messageCount:140});await f.goto();const scroll=page.getByRole('region',{name:'群消息',exact:true});await expect(scroll.locator('[data-message-seq="41"]')).toBeAttached();await expect(scroll.locator('[data-message-seq="1"]')).toHaveCount(0);
  await scroll.evaluate(node=>{node.scrollTop=40;node.dispatchEvent(new Event('scroll'));});const before=await scroll.evaluate(node=>node.scrollTop);f.addMessage('测试新来的消息，不能打断阅读');await expect(page.getByRole('button',{name:'有新消息，查看最新'})).toBeVisible({timeout:10000});expect(await scroll.evaluate(node=>node.scrollTop)).toBe(before);expect(f.state.reads.some(url=>url.includes('after_seq=140'))).toBe(true);
  await page.getByRole('button',{name:'查看更早消息',exact:true}).click();await expect(scroll.locator('[data-message-seq="1"]')).toBeAttached();expect(f.state.reads.some(url=>url.includes('before_seq=41'))).toBe(true);await page.getByRole('button',{name:'回到最新',exact:true}).click();await expect(scroll.locator('[data-message-seq="141"]')).toBeAttached();
});

test('长消息在浅深色和窄屏可读，键盘发送可用且操作有标签',async({page})=>{
  const f=await fixture(page);f.addMessage('测试长文本\n'+('接口字段与很长的文件名'.repeat(100)));await f.goto();await expect(page.getByRole('navigation').getByRole('button',{name:'工作群',exact:true})).toHaveAttribute('aria-current','page');
  await expect(page.getByLabel('群消息或任务说明')).toHaveAttribute('maxlength','20000');
  expect(await noHorizontalScroll(page)).toBe(true);await shot(page,'工作群-浅色');await page.evaluate(()=>{document.documentElement.dataset.theme='dark';});await shot(page,'工作群-深色');await page.setViewportSize({width:390,height:844});expect(await noHorizontalScroll(page)).toBe(true);await page.getByRole('button',{name:/执行与回报（/}).click();await expect(page.getByRole('complementary',{name:'执行与回报'})).toBeVisible();expect(await page.locator('.wg-conversation').evaluate(node=>node.scrollTop)).toBe(0);await page.evaluate(()=>window.scrollTo(0,0));await shot(page,'工作群-窄屏');
  await page.getByLabel('发送方式').selectOption('message');await page.getByLabel('群消息或任务说明').fill('测试键盘发送');await page.getByLabel('群消息或任务说明').press('Control+Enter');await expect(page.getByLabel('群消息或任务说明')).toHaveValue('');expect(f.state.calls.at(-1)?.body.content).toBe('测试键盘发送');
});

test('真实本机 API 保存群记录与普通消息并暂停，隔离数据不启动 Agent',async({page})=>{
  const backend=await api(page),root=path.join(backend.root,'测试真实工作群-'+randomUUID());fs.mkdirSync(root,{recursive:true});
  const project=await backend.post('/projects',{name:'测试真实 API 工作群',path:root});
  const created=await backend.post('/workgroups',{request_id:randomUUID(),project_id:project.id,name:'测试真实群记录',leader_agent_id:'codex',member_agent_ids:['codex','claude'],allowed_paths:[root],auto_dispatch:true,max_followups:4});
  await page.goto('/#/workgroups/'+project.id);await expect(page.getByRole('heading',{name:'测试真实群记录',exact:true})).toBeVisible();
  await page.getByLabel('发送方式').selectOption('message');await page.getByLabel('群消息或任务说明').fill('测试真实接口普通留言，不启动 Agent。');await page.getByRole('button',{name:'发送消息',exact:true}).click();await expect(page.getByLabel('群消息或任务说明')).toHaveValue('');
  let detail=await backend.get('/workgroups/'+created.room.id);expect(detail.messages.some((m:any)=>m.content==='测试真实接口普通留言，不启动 Agent。')).toBe(true);expect(detail.jobs).toHaveLength(0);
  await page.reload();await expect(page.getByRole('region',{name:'群消息'})).toContainText('测试真实接口普通留言，不启动 Agent。');
  await page.getByRole('button',{name:'停止当前工作',exact:true}).click();await expect(page.locator('.wg-room-head')).toContainText('已暂停派发');detail=await backend.get('/workgroups/'+created.room.id);expect(detail.room.status).toBe('paused');expect(detail.jobs).toHaveLength(0);
});
