import {test,expect,type Page} from '@playwright/test';
import {randomUUID} from 'node:crypto';
import {makeTask,drawer,shot,noHorizontalScroll,api} from './support.ts';
import fs from 'node:fs';

async function onlyTask(page:Page,id:string){
 const filter=async(route:any)=>{const response=await route.fetch(),state=await response.json();state.tasks=state.tasks.filter((t:any)=>t.id===id);state.requests=[];await route.fulfill({response,json:state})};
 await page.route('**/api/bootstrap',filter);await page.route('**/api/state',filter);
}
const trial=(page:Page)=>page.getByRole('dialog',{name:'试用后确认完成',exact:true});
async function checkAll(page:Page){
 const d=trial(page);await expect(d).toBeVisible();await expect(d.getByRole('checkbox').first()).toBeVisible();
 for(const box of await d.getByRole('checkbox').all())await box.check();
}
// Wait for routed state reads before Playwright closes the page and handles their routes.
test.afterEach(async({page})=>{await page.unrouteAll({behavior:'wait'})});

test('首页待试用直达最新详情确认弹窗，长内容与窄窗下三个操作常驻且默认不勾选',async({page})=>{
 const m=await makeTask(page,{title:'测试快捷试用 '+randomUUID(),stage:'reviewed',userAcceptance:Array.from({length:8},(_,i)=>`第${i+1}项：${'我已亲自打开成果试用，并确认实际效果符合需求。'.repeat(4)}`)});
 await onlyTask(page,m.tid);let detailReads=0;page.on('request',r=>{if(r.method()==='GET'&&r.url().endsWith('/api/tasks/'+m.tid))detailReads++});
 await page.goto('/#/today');await page.getByRole('article',{name:m.title,exact:true}).getByRole('button',{name:'去试用确认',exact:true}).click();
 const d=trial(page);await expect(d).toBeVisible();expect(detailReads).toBeGreaterThan(0);await expect(drawer(page)).toHaveCount(0);
 await expect(d).toContainText(m.project.name);await expect(d).toContainText(m.title);
 await d.getByRole('checkbox').first().check();await d.getByRole('button',{name:/查看成果：/}).first().click();const preview=page.getByRole('dialog',{name:/./});await expect(preview.getByRole('button',{name:'返回试用确认',exact:true})).toBeVisible();await preview.getByRole('button',{name:'返回试用确认',exact:true}).click();await expect(d.getByRole('checkbox').first()).toBeChecked();await d.getByRole('checkbox').first().uncheck();
 for(const box of await d.getByRole('checkbox').all())await expect(box).not.toBeChecked();await expect(d.getByRole('button',{name:'确认结果符合需求'})).toBeDisabled();
 for(const [width,height] of [[900,520],[480,720]]){
  await page.setViewportSize({width,height});expect(await noHorizontalScroll(page)).toBe(true);
  const body=d.locator('.dialog-body');expect(await body.evaluate(el=>el.scrollHeight>el.clientHeight)).toBe(true);
  for(const name of ['不通过，退回修改','稍后再说','确认结果符合需求']){
   const b=d.locator(':scope > footer').getByRole('button',{name,exact:true});await expect(b).toBeInViewport();
  }
  await body.evaluate(el=>{el.scrollTop=el.scrollHeight});await expect(d.locator(':scope > footer').getByRole('button',{name:'稍后再说'})).toBeInViewport();await shot(page,'049-试用固定操作-'+width,false);
 }
 await d.getByRole('button',{name:'稍后再说'}).click();await expect(d).toHaveCount(0);expect((await m.get('/tasks/'+m.tid)).task.status).toBe('awaiting_confirmation');
});

test('试用确认由用户逐项勾选，提交保留最新 revision 和本轮成果 hash',async({page})=>{
 const m=await makeTask(page,{title:'测试快捷确认提交 '+randomUUID(),stage:'reviewed'});await onlyTask(page,m.tid);
 await page.goto('/#/projects/'+m.project.id);await page.getByRole('article',{name:m.title,exact:true}).getByRole('button',{name:'试用确认',exact:true}).click();await expect(drawer(page)).toHaveCount(0);
 const before=await m.get('/tasks/'+m.tid);await checkAll(page);
 const request=page.waitForRequest(r=>r.method()==='POST'&&r.url().endsWith('/api/tasks/'+m.tid+'/accept'));
 await trial(page).getByRole('button',{name:'确认结果符合需求'}).click();const payload=(await request).postDataJSON();
 expect(payload).toEqual({revision:before.task.revision,artifact_hashes:before.artifacts.filter((a:any)=>a.run_id===before.task.current_run_id&&a.current).map((a:any)=>a.sha256),mode:'user_experience',user_checks:[true,true]});
 await expect(trial(page)).toHaveCount(0);expect((await m.get('/tasks/'+m.tid)).task.status).toBe('accepted');
});

test('未勾选也能从常驻操作退回',async({page})=>{
 const m=await makeTask(page,{title:'测试退回与首次复制 '+randomUUID(),stage:'reviewed'});await onlyTask(page,m.tid);
 await page.goto('/#/today');await page.getByRole('article',{name:m.title,exact:true}).getByRole('button',{name:'去试用确认'}).click();
 await trial(page).getByRole('button',{name:'不通过，退回修改'}).click();const reject=page.getByRole('dialog',{name:'不通过，退回修改',exact:true});
 await expect(reject).toBeVisible();await reject.getByLabel('哪里不符合你的要求？').fill('隔离测试：试用后仍无法找到成果，请修改说明。');await reject.getByRole('button',{name:'确认不通过',exact:true}).click();expect((await m.get('/tasks/'+m.tid)).task.status).toBe('acceptance_rejected');
 await expect(page.getByRole('dialog',{name:'已记录不通过',exact:true})).toBeVisible();
});
test('首次复制失败仍提供新单完整文本',async({page})=>{
 const first=await makeTask(page,{title:'测试首次手动复制 '+randomUUID(),stage:'ready'});
 await onlyTask(page,first.tid);
 await page.goto('/#/today');await page.evaluate(()=>Object.defineProperty(navigator.clipboard,'writeText',{configurable:true,value:async()=>{throw new Error('测试剪贴板拒绝')}}));
 await page.getByRole('article',{name:first.title,exact:true}).getByRole('button',{name:'生成并复制执行单',exact:true}).click();const fallback=page.getByRole('dialog',{name:'手动复制执行资料',exact:true});await expect(fallback).toBeVisible();await expect(fallback).toHaveAccessibleName('手动复制执行资料');
 const after=await first.get('/tasks/'+first.tid);expect(after.task.status).toBe('awaiting_dispatch');expect(after.runs).toHaveLength(1);await expect(fallback.getByRole('textbox')).toHaveValue(new RegExp(after.task.current_run_id));
});

for(const field of ['revision','hash'] as const)test(`试用弹窗保留 API ${field} 保护，失效快照不能完成验收`,async({page})=>{
 const m=await makeTask(page,{title:'测试失效试用快照 '+field+' '+randomUUID(),stage:'reviewed'});await onlyTask(page,m.tid);
 await page.route('**/api/tasks/'+m.tid,async route=>{const response=await route.fetch(),detail=await response.json();if(field==='revision')detail.task.revision--;else for(const a of detail.artifacts)a.sha256='0'.repeat(64);await route.fulfill({response,json:detail})});
 await page.goto('/#/today');await page.getByRole('article',{name:m.title,exact:true}).getByRole('button',{name:'去试用确认'}).click();await checkAll(page);
 const response=page.waitForResponse(r=>r.request().method()==='POST'&&r.url().endsWith('/api/tasks/'+m.tid+'/accept'));await trial(page).getByRole('button',{name:'确认结果符合需求'}).click();expect((await response).ok()).toBe(false);
 await expect(trial(page).getByRole('alert')).toBeVisible();expect((await m.get('/tasks/'+m.tid)).task.status).toBe('awaiting_confirmation');
});

test('首页、项目列表、记录与抽屉直接复制当前执行单，复制不派发或接单，失败保留手动全文',async({page})=>{
 const m=await makeTask(page,{title:'测试执行单工具 '+randomUUID(),stage:'running'});await onlyTask(page,m.tid);
 const before=await m.get('/tasks/'+m.tid);
 for(const url of ['/#/today','/#/projects/'+m.project.id,'/#/records/q?tab='+encodeURIComponent(m.title)]){
  await page.goto(url);await page.evaluate(()=>navigator.clipboard.writeText(''));const copy=page.getByRole('button',{name:'复制当前执行单',exact:true});await copy.click();
  await expect.poll(()=>page.evaluate(()=>navigator.clipboard.readText())).toContain(before.task.current_run_id);
  await expect(copy).toBeEnabled();await expect(page.getByRole('dialog',{name:'手动复制执行资料',exact:true})).toHaveCount(0);
  await expect(page.getByRole('status').filter({hasText:'无需重复转交'}).first()).toBeVisible();await expect(drawer(page)).toHaveCount(0);
  const after=await m.get('/tasks/'+m.tid);expect(after.task.status).toBe('running');expect(after.runs).toHaveLength(before.runs.length);expect(after.task.revision).toBe(before.task.revision);
 }
 await page.goto('/#/today?task='+m.tid);await page.evaluate(()=>navigator.clipboard.writeText(''));const copy=drawer(page).getByRole('button',{name:'复制当前执行单',exact:true});await copy.click();
 await expect.poll(()=>page.evaluate(()=>navigator.clipboard.readText())).toContain(before.task.current_run_id);await expect(copy).toBeEnabled();
 await page.evaluate(()=>Object.defineProperty(navigator.clipboard,'writeText',{configurable:true,value:async()=>{throw new Error('测试剪贴板拒绝')}}));
 await drawer(page).getByRole('button',{name:'复制当前执行单',exact:true}).click();const d=page.getByRole('dialog',{name:'手动复制执行资料'});
 await expect(d).toBeVisible();await expect(d).toHaveAccessibleName('手动复制执行资料');await expect(d.getByRole('textbox',{name:'手动复制执行资料全文'})).toHaveValue(new RegExp(before.task.current_run_id));
 await d.getByRole('textbox').focus();expect(await d.getByRole('textbox').evaluate(el=>(el as HTMLTextAreaElement).selectionEnd===(el as HTMLTextAreaElement).value.length)).toBe(true);
 const after=await m.get('/tasks/'+m.tid);expect(after.task.status).toBe('running');expect(after.runs).toHaveLength(before.runs.length);
});

test('同会话续接的复制工具不要求重复转交，当前执行单与新 Run 保持一致',async({page})=>{
 const m=await makeTask(page,{title:'测试续接执行单 '+randomUUID(),stage:'submitted'}),before=await m.get('/tasks/'+m.tid);
 await m.post('/reviews',{run_id:m.rid,reviewer_id:'grok-build',performed:true,verdict:'changes_requested',evidence:'隔离测试：模拟独立审查意见',findings:'测试修订：调整说明后由原会话继续',artifact_hashes:before.artifacts.map((a:any)=>a.sha256)});
 const needs=await m.get('/tasks/'+m.tid),{root:fixtureRoot}=await api(page);
 // Only this browser server's synthetic Run key, never the installed workbench's credentials.
 const token=JSON.parse(fs.readFileSync(fixtureRoot+'/data/run-keys/'+m.rid+'.json','utf8')).token;
 const resumed=await page.request.post('/api/mcp/continue_run',{headers:{authorization:'Bearer '+token},data:{run_id:m.rid,expected_revision:needs.task.revision,request_id:randomUUID()}});expect(resumed.ok(),await resumed.text()).toBe(true);
 const current=await m.get('/tasks/'+m.tid);expect(current.task.same_session_continuation.run_id).toBe(current.task.current_run_id);await onlyTask(page,m.tid);
 await page.goto('/#/today');await page.getByRole('button',{name:'复制当前执行单',exact:true}).click();await expect.poll(()=>page.evaluate(()=>navigator.clipboard.readText())).toContain(current.task.current_run_id);
 await expect(page.getByRole('status').filter({hasText:'无需重复转交'}).first()).toBeVisible();expect((await m.get('/tasks/'+m.tid)).task.status).toBe('awaiting_dispatch');
 await page.goto('/#/today?task='+m.tid);await expect(drawer(page).getByRole('region',{name:'现在要做什么'}).getByRole('button',{name:'我已经发给它',exact:true})).toHaveCount(0);
});
