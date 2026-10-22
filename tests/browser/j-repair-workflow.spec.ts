import {test,expect} from '@playwright/test';
import fs from 'node:fs';
import {makeTask,drawer,shot} from './support.ts';

test('未开执行的任务可以直接取消，不强迫先派单',async({page})=>{
 const m=await makeTask(page,{title:'未开执行取消测试'});await page.goto('/#/today?task='+m.tid);
 await drawer(page).getByRole('button',{name:'更多信息与操作'}).click();await drawer(page).getByRole('button',{name:'取消这项任务'}).click();await page.getByRole('dialog',{name:'取消这项任务？'}).getByRole('button',{name:'确认取消任务'}).click();
 await expect(drawer(page)).toContainText('已取消');const d=await m.get('/tasks/'+m.tid);expect(d.task.status).toBe('cancelled');expect(d.runs).toHaveLength(0);
 await drawer(page).getByRole('button',{name:'换人或重新做一次'}).click();const retry=page.getByRole('dialog',{name:'换人或重新做一次'});
 await retry.getByRole('button',{name:'新开一次并复制执行单'}).click();await expect(retry).toHaveCount(0);expect((await m.get('/tasks/'+m.tid)).runs).toHaveLength(1);
});

test('阻塞任务提供明确取消入口，再重新派单并携带上一轮说明',async({page})=>{
 const m=await makeTask(page,{title:'阻塞重派测试',stage:'running'});await m.report('blocked',{message:'测试阻碍：分页缺少返回入口'});
 await page.goto('/#/today?task='+m.tid);await drawer(page).getByRole('button',{name:'换人或重新做一次'}).first().click();
 const d=page.getByRole('dialog',{name:'换人或重新做一次'});await expect(d.getByRole('button',{name:'新开一次并复制执行单'})).toBeDisabled();
 await d.getByRole('button',{name:'先取消当前执行'}).click();await page.getByRole('dialog',{name:'取消这项任务？'}).getByRole('button',{name:'确认取消任务'}).click();
 await expect(drawer(page)).toContainText('已取消');await drawer(page).getByRole('button',{name:'更多信息与操作'}).click();await drawer(page).getByRole('button',{name:'换人或重新做一次'}).click();
 await page.getByRole('dialog',{name:'换人或重新做一次'}).getByRole('button',{name:'新开一次并复制执行单'}).click();await expect(page.getByRole('dialog',{name:'换人或重新做一次'})).toHaveCount(0);
 const next=await m.get('/tasks/'+m.tid);expect(next.runs).toHaveLength(2);expect(next.runs.find((r:any)=>r.id===m.rid).status).toBe('cancelled');
 const run=next.runs.find((r:any)=>r.id===next.task.current_run_id);expect(fs.readFileSync(run.order_path,'utf8')).toContain('分页缺少返回入口');await shot(page,'修复后-阻塞任务重新派单');
});

test('读取新条件期间不显示旧记录，失败后可重试恢复',async({page})=>{
 let fail=true;
 await page.route('**/api/history?*',r=>fail?r.fulfill({status:503,json:{error:'测试查询失败'}}):r.fulfill({json:{items:[],total:0}}));
 await page.goto('/#/records');await expect(page.getByRole('alert')).toContainText('当前条件的记录没有读取成功');fail=false;
 await page.getByRole('button',{name:'重新查找'}).click();await expect(page.getByText('没有找到匹配的记录')).toBeVisible();await expect(page.getByRole('alert')).toHaveCount(0);
});

test('类型筛选传到服务端，旧任务仍能被找到',async({page})=>{
 let requested=false;
 await page.route('**/api/history?*',r=>{const task=new URL(r.request().url()).searchParams.get('kind')==='task';if(task)requested=true;return r.fulfill({json:{items:task?[{id:'old-task',kind:'task',title:'比会话更早的任务',status:'ready',agent:'codex'}]:[],total:task?1:0}})});
 await page.goto('/#/records');await page.getByRole('radio',{name:'任务',exact:true}).click();await expect(page.getByRole('button',{name:/比会话更早的任务/})).toBeVisible();expect(requested).toBe(true);
});

test('写入成功后快照读取失败，提示已保存而非再次提交，并自动恢复',async({page})=>{
 const m=await makeTask(page,{title:'写入后刷新失败测试'});await page.goto('/#/projects/'+m.project.id);await page.getByRole('button',{name:'编辑资料'}).click();
 let failed=true;await page.route('**/api/state',async r=>{if(failed)return r.fulfill({status:503,json:{error:'测试快照暂不可用'}});await r.continue()});
 const d=page.getByRole('dialog',{name:'编辑项目资料'});await d.getByLabel('现在处在什么阶段').fill('已保存的新阶段');await d.getByRole('button',{name:'保存'}).click();
 await expect(page.getByRole('alert')).toContainText('操作已保存');await expect(d).toHaveCount(0);failed=false;
 await expect(page.getByText('已保存的新阶段')).toBeVisible({timeout:10000});expect((await m.get('/state')).projects.find((p:any)=>p.id===m.project.id).version).toBe(2);
});

test('快照接口挂起也能超时恢复，不会永久停在保存中',async({page})=>{
 const m=await makeTask(page,{title:'挂起同步恢复测试'});await page.goto('/#/projects/'+m.project.id);await page.getByRole('button',{name:'编辑资料'}).click();
 let stall=true,release!:()=>void;const gate=new Promise<void>(r=>release=r);
 await page.route('**/api/state',async r=>{if(stall){await gate;try{await r.abort()}catch{}}else await r.continue()});
 const d=page.getByRole('dialog',{name:'编辑项目资料'});await d.getByLabel('现在处在什么阶段').fill('挂起之后仍然保存');await d.getByRole('button',{name:'保存'}).click();
 try{
  await expect(page.getByRole('alert')).toContainText('操作已保存',{timeout:25000});await expect(d).toHaveCount(0);
  stall=false;release();await expect(page.getByText('挂起之后仍然保存')).toBeVisible({timeout:15000});
 }finally{release()}
});
