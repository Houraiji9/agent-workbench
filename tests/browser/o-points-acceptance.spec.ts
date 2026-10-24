import {test,expect} from '@playwright/test';
import fs from 'node:fs';
import {api,makeTask,shot,noHorizontalScroll,drawer} from './support.ts';

test('WorkBuddy月度积分实际保存、100%和其他积分分开，刷新日期可留空',async({page})=>{
 const {get}=await api(page);await page.goto('/#/resources');
 const card=page.getByRole('article',{name:/WorkBuddy 额度/});await card.getByRole('button',{name:/填写积分|修改积分/}).click();const d=page.getByRole('dialog',{name:'WorkBuddy 积分'});
 await d.getByLabel('总剩余积分',{exact:true}).fill('3312');await d.getByLabel('包含每月刷新的基础积分').check();await d.getByLabel('每月基础积分',{exact:true}).fill('500');await d.getByLabel('本月剩余积分',{exact:true}).fill('500');await d.getByRole('button',{name:'保存',exact:true}).click();await expect(d).toHaveCount(0);await page.reload();
 await expect(card).toContainText('3,312 积分');await expect(card).toContainText('2,812 积分');await expect(card).toContainText('500 / 500 积分');await expect(card.getByRole('progressbar')).toHaveAttribute('aria-valuenow','100');await expect(card.locator('footer')).toHaveCount(1);expect((await card.boundingBox())!.height).toBeLessThan(260);
 const p=(await get('/state')).quota_pools.find((x:any)=>x.points_editable);expect(p.points_resets_at).toBeNull();await shot(page,'月度积分-浅色');
 await page.getByRole('button',{name:'切换到深色外观'}).click();for(const width of [1440,900,390]){await page.setViewportSize({width,height:1000});expect(await noHorizontalScroll(page)).toBe(true)}await shot(page,'月度积分-窄屏深色');
});

test('通用积分也支持月度比例与未知，编辑后仍可修改刷新时间',async({page})=>{
 await api(page);await page.goto('/#/resources');await page.getByRole('button',{name:'添加额度',exact:true}).click();let d=page.getByRole('dialog',{name:'添加额度'});
 await d.getByLabel('额度名称').fill('测试千问月度积分');await d.getByRole('combobox',{name:'类型',exact:true}).selectOption('points');await d.getByLabel('包含每月刷新的基础积分').check();await d.getByLabel('总剩余积分',{exact:true}).fill('1200');await d.getByLabel('每月基础积分',{exact:true}).fill('500');await d.getByLabel('本月剩余积分',{exact:true}).fill('250');await d.getByRole('button',{name:'保存',exact:true}).click();await expect(d).toHaveCount(0);
 const card=page.getByRole('article',{name:'测试千问月度积分 额度'});await expect(card.getByRole('progressbar')).toHaveAttribute('aria-valuenow','50');await expect(card).toContainText('950 积分');await card.getByRole('button',{name:'编辑额度'}).click();d=page.getByRole('dialog',{name:'管理 测试千问月度积分'});await expect(d.getByLabel('每月基础积分',{exact:true})).toHaveValue('500');await d.getByLabel('本月剩余积分',{exact:true}).fill('');await d.getByLabel('重置时间（选填）').fill('2026-12-01T09:00');await d.getByRole('button',{name:'保存',exact:true}).click();await expect(d).toHaveCount(0);await page.reload();await expect(card.getByRole('progressbar')).not.toHaveAttribute('aria-valuenow');await expect(card).toContainText('待填写');
});

test('42个预设全部使用可解码的本地图标，明暗和窄屏可用',async({page})=>{
 const external:string[]=[];page.on('request',r=>{if(r.resourceType()==='image'&&!r.url().startsWith('http://127.0.0.1:14318')&&!r.url().startsWith('data:'))external.push(r.url())});
 await page.goto('/#/team?tab=presets');await expect(page.locator('.preset-card')).toHaveCount(42);await expect(page.locator('.preset-card .agent-icon img')).toHaveCount(42);
 expect(await page.locator('.preset-card img').evaluateAll(async es=>Promise.all(es.map(async e=>{const i=e as HTMLImageElement;try{await i.decode();return i.naturalWidth>0}catch{return false}})))).toEqual(Array(42).fill(true));
 await shot(page,'官方图标预设-浅色');await page.getByRole('button',{name:'切换到深色外观'}).click();await shot(page,'官方图标预设-深色');await page.setViewportSize({width:390,height:1000});expect(await noHorizontalScroll(page)).toBe(true);expect(external).toEqual([]);
});

test('不勾选即可不通过，复制返工原因生成新Run且可重复复制，旧成果保留',async({page})=>{
 const m=await makeTask(page,{title:'测试用户退回返工',stage:'reviewed'}),before=await m.get('/tasks/'+m.tid),old=fs.readFileSync(before.runs[0].order_path);
 await page.goto('/');await page.getByRole('article',{name:m.title,exact:true}).getByRole('button',{name:'去试用确认'}).click();await drawer(page).getByRole('button',{name:'试用后确认完成',exact:true}).click();let d=page.getByRole('dialog',{name:'试用后确认完成'});
 await expect(d.getByRole('button',{name:'确认结果符合需求'})).toBeDisabled();await d.getByRole('button',{name:'不通过，退回修改'}).click();d=page.getByRole('dialog',{name:'不通过，退回修改'});await expect(d.getByRole('button',{name:'确认不通过'})).toBeDisabled();await d.getByLabel('哪里不符合你的要求？').fill('卡片过高，请拆成两张，保持原设计。');await shot(page,'验收-填写不通过意见');await d.getByRole('button',{name:'确认不通过'}).click();d=page.getByRole('dialog',{name:'已记录不通过'});await expect(d).toBeVisible();expect((await m.get('/tasks/'+m.tid)).task.status).toBe('acceptance_rejected');
 await d.getByRole('button',{name:'复制返工要求'}).click();await expect(page.getByRole('status')).toContainText('返工要求已复制');const clip=await page.evaluate(()=>navigator.clipboard.readText());expect(clip).toContain('卡片过高');const current=await m.get('/tasks/'+m.tid);expect(current.runs.length).toBe(2);expect(current.task.status).toBe('awaiting_dispatch');expect(clip).toContain(current.task.current_run_id);expect(current.task.current_run_id).not.toBe(m.rid);expect(fs.readFileSync(before.runs[0].order_path)).toEqual(old);expect(current.artifacts).toEqual(before.artifacts);expect(current.reviews).toEqual(before.reviews);
 await d.getByRole('button',{name:'复制返工要求'}).click();expect((await m.get('/tasks/'+m.tid)).runs.length).toBe(2);await d.getByRole('button',{name:'关闭',exact:true}).first().click();await page.reload();await expect(drawer(page)).toContainText('卡片过高');await shot(page,'验收-返工已保存');
});

test('不通过关联已有后续任务后首页不再催确认，项目历史仍能查看',async({page})=>{
 const m=await makeTask(page,{title:'测试已有后续返工',stage:'reviewed'}),d=await m.get('/tasks/'+m.tid),q=await m.post('/requests',{project_id:m.project.id,text:'测试已安排修改'});
 const {taskInput}=await import('../helpers.ts');const plan=await m.post('/plans',{schema_version:1,plan_id:q.id,request_id:q.id,expected_version:1,tasks:[{...taskInput(m.root),title:'测试后续修改'}]});
 await m.post('/tasks/'+m.tid+'/reject',{revision:d.task.revision,run_id:m.rid,note:'旧方案不通过，已安排下一项修改。',artifact_hashes:d.artifacts.map((a:any)=>a.sha256),followup_task_id:plan.task_ids[0]});await page.goto('/');await expect(page.getByRole('article',{name:m.title,exact:true})).toHaveCount(0);await page.goto('/#/projects/'+m.project.id+'?task='+m.tid);await expect(drawer(page)).toContainText('旧方案不通过');await drawer(page).getByRole('button',{name:'查看后续修改任务',exact:true}).first().click();await expect(drawer(page)).toContainText('测试后续修改');
});
