import {test,expect} from '@playwright/test';
import {api,shot,noHorizontalScroll} from './support.ts';
import {taskInput} from '../helpers.ts';
import {randomUUID} from 'node:crypto';

test('预设库筛选、添加成员与模型，真实规划导出，删除受任务约束并可恢复',async({page})=>{
 const {get,post,root}=await api(page);const before=(await get('/state')).agents.length;
 await page.goto('/#/team?tab=presets');await expect(page.getByText(/42 个常用工具/)).toBeVisible();
 await page.getByRole('textbox',{name:'搜索预设'}).fill('TRAE');await expect(page.locator('.preset-card')).toHaveCount(2);
 await page.getByRole('combobox',{name:'预设地区'}).selectOption('国内');await expect(page.locator('.preset-card')).toHaveCount(1);
 await page.getByRole('combobox',{name:'预设地区'}).selectOption('全部');await page.getByRole('textbox',{name:'搜索预设'}).fill('Qoder');
 await page.getByRole('button',{name:'添加到团队',exact:true}).click();let d=page.getByRole('dialog',{name:'添加 Qoder'});
 await d.getByLabel('成员名称').fill('测试 Qoder 团队');await d.locator('summary').click();await d.getByRole('button',{name:'添加模型'}).click();
 await d.getByLabel('模型名称',{exact:true}).fill('测试工程模型');await d.getByLabel('型号（选填）').fill('test-code-model');await d.getByLabel('建议用途').fill('测试专用工程任务');
 await d.getByRole('button',{name:'加入团队'}).click();await expect(d).toHaveCount(0);await expect(page.getByRole('button',{name:'已在团队'})).toBeDisabled();
 const state=await get('/state'),a=state.agents.find((a:any)=>a.name==='测试 Qoder 团队');expect(state.agents.length).toBe(before+1);
 await page.goto('/#/team/'+a.id);await expect(page.getByText('测试工程模型',{exact:true})).toBeVisible();
 const q=await post('/requests',{project_id:'P-workbench',text:'测试：新成员真实规划派单'}),t={...taskInput(root),agent_id:a.id,requested_model:'test-code-model'};
 const plan=await post('/plans',{schema_version:1,plan_id:randomUUID(),request_id:q.id,expected_version:1,tasks:[t]});const tid=plan.task_ids[0];const order=await post('/tasks/'+tid+'/export',{version:1});expect(order.run_id).toMatch(/^R-/);
 await page.getByRole('button',{name:'删除 测试 Qoder 团队',exact:true}).click();d=page.getByRole('dialog',{name:'删除 测试 Qoder 团队'});await d.getByRole('button',{name:'确认删除'}).click();await expect(d.getByRole('alert')).toContainText('还有 1 项任务');
 await d.getByRole('button',{name:'取消'}).click();const detail=await get('/tasks/'+tid);await post('/tasks/'+tid+'/action',{action:'cancel',revision:detail.task.revision});
 await page.reload();await page.getByRole('button',{name:'删除 测试 Qoder 团队',exact:true}).click();await page.getByRole('button',{name:'确认删除'}).click();await expect(page.getByRole('dialog')).toHaveCount(0);
 await page.goto('/#/team?tab=removed');await expect(page.getByText('测试 Qoder 团队',{exact:true})).toBeVisible();
 await page.goto('/#/team?tab=presets');await page.getByRole('textbox',{name:'搜索预设'}).fill('Qoder');await page.getByRole('button',{name:'恢复到团队',exact:true}).click();await expect(page.getByRole('button',{name:'已在团队'})).toBeDisabled();expect((await get('/state')).agents.length).toBe(before+1);
 await page.goto('/#/team/'+a.id);await expect(page.getByText('测试工程模型',{exact:true})).toBeVisible();await shot(page,'自定义成员-模型与任务');
});

test('自定义成员资料和模型可修改，过期编辑提示冲突；预设明暗窄屏无横向溢出',async({page})=>{
 const {get,post}=await api(page);await page.goto('/#/team');await page.getByRole('button',{name:'新增团队',exact:true}).click();let d=page.getByRole('dialog',{name:'新增团队'});
 await d.getByLabel('成员名称').fill('测试资料助理');await d.getByLabel('适合做什么').fill('整理资料和日常办公');await d.getByRole('button',{name:'加入团队'}).click();await expect(d).toHaveCount(0);
 let a=(await get('/state')).agents.find((a:any)=>a.name==='测试资料助理');await page.goto('/#/team/'+a.id);await page.getByRole('button',{name:'编辑模型',exact:true}).click();d=page.getByRole('dialog',{name:'编辑 测试资料助理'});
 await d.getByRole('button',{name:'添加模型'}).click();await d.getByLabel('模型名称',{exact:true}).fill('自定义模型');await d.getByLabel('建议用途').fill('整理长文档');await d.getByRole('button',{name:'保存',exact:true}).click();await expect(d).toHaveCount(0);await page.reload();await expect(page.getByText('自定义模型',{exact:true})).toBeVisible();
 await page.getByRole('button',{name:'编辑分工',exact:true}).click();d=page.getByRole('dialog',{name:'编辑 测试资料助理'});a=(await get('/state')).agents.find((entry:any)=>entry.name==='测试资料助理');await post('/agents/'+a.id+'/edit',{version:a.version,preset_id:a.preset_id,name:a.name,scope:'测试：另一个窗口的新分工',restriction:a.restriction,model:a.model,icon_key:a.icon_key,allowed_kinds:a.allowed_kinds,models:a.model_group.models});
 await d.getByRole('button',{name:'保存',exact:true}).click();await expect(d.getByRole('alert')).toContainText('成员资料已更新');await d.getByRole('button',{name:'取消'}).click();
 await page.goto('/#/team?tab=presets');for(const width of [1440,900,390]){await page.setViewportSize({width,height:1000});expect(await noHorizontalScroll(page)).toBe(true)}await shot(page,'预设库-窄屏');
 await page.getByRole('button',{name:'切换到深色外观'}).click();await page.setViewportSize({width:1440,height:1000});await shot(page,'预设库-深色');expect(await noHorizontalScroll(page)).toBe(true);
});

test('手动额度支持多窗口、共享、修改清空、冲突提示和删除恢复',async({page})=>{
 const {get,post}=await api(page);await page.goto('/#/resources');await page.getByRole('button',{name:'添加额度',exact:true}).click();let d=page.getByRole('dialog',{name:'添加额度'});
 await d.getByLabel('额度名称').fill('测试共享积分');await d.getByLabel('Codex',{exact:true}).check();await d.getByLabel('WorkBuddy',{exact:true}).check();
 await d.getByRole('combobox',{name:'类型',exact:true}).selectOption('points');await d.getByLabel('窗口名称').fill('每月积分');await d.getByLabel('剩余数量').fill('0');await d.getByLabel('总量（选填）').fill('5000');
 await d.getByRole('button',{name:'添加额度窗口'}).click();await d.getByRole('combobox',{name:'类型',exact:true}).nth(1).selectOption('currency');await d.getByLabel('窗口名称').nth(1).fill('美元余额');await d.getByLabel('剩余数量').nth(1).fill('23.5');await d.getByRole('combobox',{name:'币种',exact:true}).selectOption('USD');
 await d.getByRole('button',{name:'保存',exact:true}).click();await expect(d).toHaveCount(0);const card=page.getByRole('article',{name:'测试共享积分 额度'});await expect(card).toHaveCount(1);await expect(card).toContainText('Codex · WorkBuddy 共用');await expect(card).toContainText('23.5 USD');await expect(card.getByRole('progressbar')).toHaveAttribute('aria-valuenow','0');
 await card.getByRole('button',{name:'编辑额度'}).click();d=page.getByRole('dialog',{name:'管理 测试共享积分'});await d.getByLabel('剩余数量').first().fill('2500');await d.getByRole('button',{name:'保存',exact:true}).click();await expect(d).toHaveCount(0);await page.reload();await expect(card.getByRole('progressbar')).toHaveAttribute('aria-valuenow','50');
 await card.getByRole('button',{name:'编辑额度'}).click();d=page.getByRole('dialog',{name:'管理 测试共享积分'});const q=(await get('/state')).quota_definitions.find((q:any)=>q.name==='测试共享积分');await post('/quotas/'+q.id+'/edit',{version:q.version,name:q.name,members:q.members,source_ref:null,windows:q.windows.map((w:any,i:number)=>({...w,remaining:i===0?3000:w.remaining}))});await d.getByRole('button',{name:'保存',exact:true}).click();await expect(d.getByRole('alert')).toContainText('额度设置已更新');await d.getByRole('button',{name:'取消'}).click();
 await page.reload();await card.getByRole('button',{name:'编辑额度'}).click();d=page.getByRole('dialog',{name:'管理 测试共享积分'});await d.getByLabel('剩余数量').first().fill('');await d.getByRole('button',{name:'保存',exact:true}).click();await expect(d).toHaveCount(0);await expect(card).toContainText('待填写');await shot(page,'自定义额度-共享与多窗口');
 await card.getByRole('button',{name:'编辑额度'}).click();await page.getByRole('button',{name:'删除额度',exact:true}).click();await page.getByRole('button',{name:'确认删除'}).click();await expect(card).toHaveCount(0);await page.getByText('已移除的额度',{exact:true}).click();await page.getByRole('button',{name:'恢复',exact:true}).click();await expect(card).toBeVisible();
});

test('已有 WorkBuddy 可管理名称关联、隐藏和恢复；独立卡片保持一个时间页脚',async({page})=>{
 await api(page);await page.goto('/#/resources');const group=page.locator('.quota-grid').first();const card=group.getByRole('article',{name:'WorkBuddy 额度'});
 await expect(card.locator('footer')).toHaveCount(1);const box=await card.boundingBox();expect(box!.height).toBeGreaterThan(100);
 await card.getByRole('button',{name:'管理 WorkBuddy 额度'}).click();let d=page.getByRole('dialog',{name:'管理 WorkBuddy'});await d.getByLabel('额度名称').fill('我的 WorkBuddy');await d.getByRole('button',{name:'保存',exact:true}).click();await expect(d).toHaveCount(0);
 const renamed=group.getByRole('article',{name:'我的 WorkBuddy 额度'});await expect(renamed).toBeVisible();await renamed.getByRole('button',{name:'管理 我的 WorkBuddy 额度'}).click();await page.getByRole('button',{name:'删除额度',exact:true}).click();await page.getByRole('button',{name:'确认删除'}).click();await expect(renamed).toHaveCount(0);await page.reload();await expect(renamed).toHaveCount(0);
 await page.getByText('已移除的额度',{exact:true}).click();await page.getByRole('button',{name:'恢复',exact:true}).click();await expect(renamed).toBeVisible();
 for(const width of [1440,900,390]){await page.setViewportSize({width,height:1000});expect(await noHorizontalScroll(page)).toBe(true)}await shot(page,'紧凑额度-窄屏');
});

test('独立卡片同宽且同行等高；时间保持统一页脚',async({page})=>{
 const stamp=new Date().toISOString();const patch=async(route:any)=>{const r=await route.fetch(),s=await r.json();s.quota_pools=[{id:'d',provider:'deepseek',name:'DeepSeek',source:'token_monitor',status:'ok',freshness:'fresh',source_updated_at:stamp,balance:{amount:160.25,currency:'CNY'}},{id:'m',provider:'workbuddy',name:'WorkBuddy',source:'user_entered',status:'ok',display_state:'manual',points_editable:true,points_amount:2000,source_updated_at:stamp},{id:'c',provider:'codex',name:'Codex',source:'token_monitor',status:'ok',freshness:'fresh',source_updated_at:stamp}];s.quota_windows=[{id:'w',pool_id:'c',kind:'weekly',remaining_percent:50}];await route.fulfill({response:r,json:s})};await page.route('**/api/bootstrap',patch);await page.route('**/api/state',patch);await page.goto('/#/resources');
 const cards=page.locator('.quota-grid').first().locator(':scope > .quota-cell > article');await expect(cards).toHaveCount(3);const boxes=await cards.evaluateAll(es=>es.map(e=>({w:e.getBoundingClientRect().width,h:e.getBoundingClientRect().height})));expect(new Set(boxes.map(b=>Math.round(b.w))).size).toBe(1);expect(boxes.every(b=>b.h<220)).toBe(true);await expect(cards.first().locator('footer')).toHaveCount(1);expect(await page.locator('.quota-grid').first().evaluate(e=>getComputedStyle(e).alignItems)).toBe('stretch');expect(new Set(boxes.map(b=>Math.round(b.h))).size).toBe(1);await shot(page,'独立额度-统一卡片');
});

test('刚填的零额度进入首页概况；Antigravity 改名后三组卡片同步',async({page})=>{
 const {post}=await api(page);
 await post('/quotas',{version:0,source_ref:null,name:'测试刚填额度',members:[],windows:[{label:'测试今日',metric:'percent',remaining:0,limit:null,currency:null,unit:'',resets_at:null}]});
 const patch=async(route:any)=>{const r=await route.fetch(),s=await r.json(),manual=s.quota_pools.find((p:any)=>p.name==='测试刚填额度');s.quota_pools=s.quota_pools.filter((p:any)=>p.id===manual.id||p.provider==='antigravity');s.quota_windows=s.quota_windows.filter((w:any)=>w.pool_id===manual.id);s.quota_pools.push({id:'test-live',provider:'codex',name:'测试实时额度',source:'token_monitor',status:'ok',freshness:'fresh'});s.quota_windows.push({id:'test-live-w',pool_id:'test-live',kind:'weekly',remaining_percent:90,freshness:'fresh'});s.integrations=s.integrations.map((i:any)=>i.id==='tokenMonitor'?{...i,status:'connected'}:i);await route.fulfill({response:r,json:s})};
 await page.route('**/api/bootstrap',patch);await page.route('**/api/state',patch);await page.goto('/');const glance=page.getByRole('region',{name:'额度概况'});await expect(glance.getByRole('img',{name:'测试刚填额度测试今日剩余 0%'})).toBeVisible();await expect(glance.getByRole('img',{name:'测试实时额度每周剩余 90%'})).toBeVisible();
 await page.goto('/#/resources');await page.getByRole('article',{name:'Antigravity · Gemini 额度',exact:true}).getByRole('button',{name:'管理 Antigravity · Gemini 额度'}).click();
 const d=page.getByRole('dialog',{name:'管理 Antigravity',exact:true});await d.getByLabel('额度名称').fill('测试改名');await d.getByRole('button',{name:'保存',exact:true}).click();await expect(d).toHaveCount(0);
 for(const group of ['Gemini','Gemini 4 Argon','Claude / GPT'])await expect(page.getByRole('article',{name:'测试改名 · '+group+' 额度',exact:true})).toBeVisible();
 await expect(page.locator('.quota-grid').getByRole('article',{name:/测试改名 · .* 额度/})).toHaveCount(3);
});


