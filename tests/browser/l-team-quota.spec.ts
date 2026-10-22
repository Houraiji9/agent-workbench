import {test,expect} from '@playwright/test';import {api,shot,noHorizontalScroll,drawer} from './support.ts';import {randomUUID} from 'node:crypto';import {taskInput} from '../helpers.ts';

test('团队模型按入口展示，Bot独立图标，复制型号派单，明暗与窄屏可读',async({page,context})=>{
 await page.emulateMedia({reducedMotion:'reduce'});
 await context.grantPermissions(['clipboard-read','clipboard-write']);await page.goto('/#/team/claude');
 const panel=page.getByRole('complementary',{name:'Claude 详情'});await expect(panel.getByText('Claude Opus 5.5',{exact:true})).toBeVisible();await expect(panel.getByText('额度来源',{exact:true})).toHaveCount(0);
 await panel.getByRole('button',{name:'复制 Claude Opus 5.5 派单要求',exact:true}).click();const clip=await page.evaluate(()=>navigator.clipboard.readText());expect(clip).toContain('requested_model');expect(clip).toContain('claude-opus-5-5');
 await shot(page,'隔离测试-团队模型');await page.getByRole('button',{name:'切换到深色外观'}).click();await shot(page,'隔离测试-团队模型深色');
 const list=page.getByRole('list',{name:'Agent 列表'});const bot=list.getByRole('listitem',{name:'Grok Bot',exact:true}),build=list.getByRole('listitem',{name:'Grok Build',exact:true});expect(await bot.locator('img').getAttribute('src')).not.toBe(await build.locator('img').getAttribute('src'));
 await bot.click();await expect(page.getByRole('complementary',{name:'Grok Bot 详情'}).getByRole('button',{name:'复制 自动选择 派单要求',exact:true})).toBeVisible();
 await page.goto('/#/team/workbuddy');for(const width of [1440,900,390]){await page.setViewportSize({width,height:1000});expect(await noHorizontalScroll(page)).toBe(true)}
 const narrow=page.getByRole('complementary',{name:'WorkBuddy 详情'}),box=(await narrow.boundingBox())!;expect(box.width).toBeGreaterThanOrEqual(340);await expect(page.getByRole('button',{name:'全部成员'})).toBeVisible();await expect(page.locator('.team .agent-grid')).toBeHidden();
 for(const b of await narrow.locator('.model-row button').all()){const r=(await b.boundingBox())!;expect(r.x).toBeGreaterThan(box.x);expect(r.x+r.width).toBeLessThanOrEqual(box.x+box.width)}await shot(page,'隔离测试-模型窄屏');
});

test('只有Claude和Antigravity可手填额度，零值保存刷新，过期表单被提醒',async({page})=>{
 const {get,post}=await api(page);await page.goto('/#/resources');await expect(page.getByRole('button',{name:'编辑额度',exact:true})).toHaveCount(4);
 const card=page.getByRole('article',{name:'Claude 额度',exact:true});await card.getByRole('button',{name:'编辑额度'}).click();let d=page.getByRole('dialog',{name:'编辑 Claude 额度'});
 await d.getByRole('spinbutton',{name:'剩余（%）',exact:true}).first().fill('0');await d.getByRole('spinbutton',{name:'剩余（%）',exact:true}).nth(1).fill('64');await d.getByRole('button',{name:'保存',exact:true}).click();await expect(d).toHaveCount(0);
 await page.reload();await expect(card).toContainText('手动记录');await expect(card.getByRole('progressbar').first()).toHaveAttribute('aria-valuenow','0');await expect(card.getByRole('progressbar').nth(1)).toHaveAttribute('aria-valuenow','64');await shot(page,'隔离测试-额度手动保存');
 await expect(card.getByRole('progressbar').first()).toHaveAttribute('aria-valuetext','剩余 0%（手动记录）');await expect(card).not.toHaveClass(/stale/);
 await card.getByRole('button',{name:'编辑额度'}).click();d=page.getByRole('dialog');const pool=(await get('/state')).quota_pools.find((p:any)=>p.provider==='claude');await post('/quota-cache/claude',{version:pool.cache_version,windows:[{label:'5 小时',kind:'session',remaining_percent:72,resets_at:null}]});
 await d.getByRole('button',{name:'保存',exact:true}).click();await expect(d.getByRole('alert')).toContainText('额度已更新');await d.getByRole('button',{name:'取消',exact:true}).click();await page.reload();await expect(card.getByRole('progressbar').first()).toHaveAttribute('aria-valuenow','72');
 await page.getByRole('article',{name:'Antigravity · Gemini 额度',exact:true}).getByRole('button',{name:'编辑额度'}).click();d=page.getByRole('dialog');for(const width of [1440,900,390]){await page.setViewportSize({width,height:1000});expect(await noHorizontalScroll(page)).toBe(true);expect(await d.evaluate(e=>e.scrollWidth<=e.clientWidth+1)).toBe(true)}await shot(page,'隔离测试-额度编辑窄屏');
});

test('Antigravity三张卡片各显对应窗口，分组编辑保存不影响另外两组',async({page})=>{
 const {post,get}=await api(page),pool=(await get('/state')).quota_pools.find((p:any)=>p.provider==='antigravity');await post('/quota-cache/antigravity',{version:pool.cache_version,windows:[{label:'Gemini 5-hour',kind:'session',remaining_percent:33,resets_at:null},{label:'Gemini weekly',kind:'weekly',remaining_percent:44,resets_at:null},{label:'Gemini 4 Argon weekly',kind:'weekly',remaining_percent:55,resets_at:null},{label:'Claude/GPT 5-hour',kind:'session',remaining_percent:66,resets_at:null},{label:'Claude/GPT weekly',kind:'weekly',remaining_percent:77,resets_at:null}]});
 await page.goto('/#/resources');const cards=page.getByRole('article',{name:/Antigravity · /});await expect(cards).toHaveCount(3);
 const boxes=await Promise.all((await cards.all()).map(c=>c.boundingBox()));expect(Math.max(...boxes.map(b=>b!.y))-Math.min(...boxes.map(b=>b!.y))).toBeLessThanOrEqual(1);
 for(const [name,count]of [['Gemini',2],['Gemini 4 Argon',1],['Claude / GPT',2]]as const)await expect(page.getByRole('article',{name:'Antigravity · '+name+' 额度',exact:true}).getByRole('progressbar')).toHaveCount(count);
 const argon=page.getByRole('article',{name:'Antigravity · Gemini 4 Argon 额度',exact:true});await argon.getByRole('button',{name:'编辑额度'}).click();const d=page.getByRole('dialog');await expect(d.getByRole('spinbutton')).toHaveCount(1);await d.getByRole('spinbutton').fill('21');await d.getByRole('button',{name:'保存',exact:true}).click();await expect(d).toHaveCount(0);await page.reload();await expect(argon.getByRole('progressbar')).toHaveAttribute('aria-valuenow','21');
 const s=await get('/state');expect(s.quota_windows.filter((w:any)=>w.pool_id==='CACHE-antigravity').map((w:any)=>w.remaining_percent).sort((a:number,b:number)=>a-b)).toEqual([21,33,44,66,77]);await shot(page,'隔离测试-Antigravity三张卡片');
});

test('仅有手填和旧额度时等待刷新，首页排除外部订阅和计划余额',async({page})=>{
 const stamp=new Date().toISOString();const patch=async(route:any)=>{const response=await route.fetch(),s=await response.json();s.integrations=s.integrations.map((i:any)=>i.id==='tokenMonitor'?{...i,status:'connected',last_success:stamp}:i);s.quota_pools=[{id:'test-manual',provider:'claude',name:'Claude',status:'ok',source:'user_entered',cache_editable:true,display_state:'manual',freshness:'stale',source_updated_at:stamp},{id:'test-planned',name:'测试计划余额',status:'planned',source:'token_monitor',freshness:'fresh',balance:{amount:987654,currency:'CNY'},source_updated_at:stamp}];s.quota_windows=[{id:'test-win',pool_id:'test-manual',label:'5 小时',remaining_percent:40}];s.subscriptions.push({id:'test-external',title:'测试外部日程应隐藏',source:'token_monitor',status:'planned',planned_date:stamp.slice(0,10)});await route.fulfill({response,json:s})};
 await page.route('**/api/bootstrap',patch);await page.route('**/api/state',patch);await page.goto('/#/resources');await expect(page.locator('.source-line')).toContainText('等待 Token Monitor 刷新');await expect(page.getByRole('article',{name:'Claude 额度'})).toContainText('手动记录');
 await page.goto('/#/today');await expect(page.getByText('测试外部日程应隐藏',{exact:true})).toHaveCount(0);await expect(page.getByText('987654 CNY')).toHaveCount(0);await expect(page.getByRole('region',{name:'额度概况'})).toContainText('手动记录');
});

test('页面常驻说明清理防御语句，计划池与外部订阅模块移除',async({page})=>{
 for(const route of ['team/claude','team/grok-bot','resources','resources?tab=plans','resources?tab=connections','projects','settings']){
  await page.goto('/#/'+route);await expect(page.locator('h1')).toBeVisible();expect(await page.locator('main').innerText()).not.toMatch(/不代表|不承诺|不能说明|不等于|不是实时|不会上传|不会自动登记/);
 }
 await page.goto('/#/resources');await expect(page.getByText('计划中的共享池',{exact:true})).toHaveCount(0);
});

test('首页与三张额度卡分别保留每组的实时、手填和上次记录标签',async({page})=>{
 let stale=false;
 const patch=async(route:any)=>{const response=await route.fetch(),s=await response.json(),at=new Date(Date.now()-(stale?3600000:20000)).toISOString();
  s.integrations=s.integrations.map((i:any)=>i.id==='tokenMonitor'?{...i,status:'connected',last_success:at}:i);
  s.quota_pools=[{id:'CACHE-antigravity',provider:'antigravity',name:'Antigravity',source:'mixed',status:'ok',cache_editable:true,cache_version:2,display_state:'mixed',freshness:stale?'stale':'fresh',source_updated_at:at}];
  s.quota_windows=[['Gemini 5-hour','token_monitor',31],['Gemini 4 Argon weekly','user_entered',21],['Claude/GPT weekly','token_monitor',51]].map(([label,source,value],index)=>({id:'w'+index,pool_id:'CACHE-antigravity',label,source,kind:index?'weekly':'session',remaining_percent:value,source_updated_at:at,display_state:source==='user_entered'?'manual':stale?'cached':'live',freshness:stale?'stale':'fresh'}));
  await route.fulfill({response,json:s});};
 await page.route('**/api/bootstrap',patch);await page.route('**/api/state',patch);
 for(const old of [false,true]){stale=old;await page.goto('/#/resources');await page.reload();
  for(const name of ['Gemini','Claude / GPT'])await expect(page.getByRole('article',{name:'Antigravity · '+name+' 额度',exact:true}).locator('.pool-state')).toHaveText(old?'上次记录':'实时');
  await expect(page.getByRole('article',{name:'Antigravity · Gemini 4 Argon 额度',exact:true}).locator('.pool-state')).toHaveText('手动记录');
  await page.goto('/#/today');const glance=page.getByRole('region',{name:'额度概况'});await expect(glance.locator('.glance-row').filter({hasText:'手动记录'})).toHaveCount(1);
  await expect(glance.locator('.glance-row').filter({hasText:'上次记录'})).toHaveCount(old?2:0);
 }
});

test('清空指定模型后再次重派保持由执行者选择，同入口和跨入口均不恢复旧型号',async({page})=>{
 const {post,get,root}=await api(page);
 for(const agent of ['zcode','workbuddy']){
  const q=await post('/requests',{project_id:'P-workbench',text:'测试：清空型号后再次重派 '+agent});
  const plan=await post('/plans',{schema_version:1,plan_id:'test-'+randomUUID(),request_id:q.id,expected_version:1,tasks:[{...taskInput(root),work_kind:'operations',agent_id:'zcode',requested_model:'GLM-5.3'}]}),tid=plan.task_ids[0];
  await post('/tasks/'+tid+'/export',{version:1});
  const cancel=async()=>{const d=await get('/tasks/'+tid);await post('/tasks/'+tid+'/action',{action:'cancel',revision:d.task.revision});};
  await cancel();const first=await get('/tasks/'+tid);await post('/tasks/'+tid+'/export',{version:1,new_run:true,agent_id:agent,requested_model:null,expected_revision:first.task.revision});await cancel();
  await page.goto('/#/today?task='+tid);await drawer(page).getByRole('button',{name:'更多信息与操作'}).click();await drawer(page).getByRole('button',{name:'换人或重新做一次'}).click();
  const dialog=page.getByRole('dialog',{name:'换人或重新做一次'});await expect(dialog.getByRole('combobox',{name:'指定模型（可选）'})).toHaveValue('');
  await dialog.getByRole('button',{name:'新开一次并复制执行单'}).click();await expect(dialog).toHaveCount(0);
  const d=await get('/tasks/'+tid),run=d.runs.find((r:any)=>r.id===d.task.current_run_id);expect(run.agent_id).toBe(agent);expect(run.requested_model).toBeNull();expect(d.task.requested_model).toBe('GLM-5.3');expect(d.runs).toHaveLength(3);
 }
});

test('手填时间不替换采集更新时间，空分组保持中性待填写',async({page})=>{
 const stamp=new Date().toISOString(),old=new Date(Date.now()-7200000).toISOString();let empty=false;
 const patch=async(route:any)=>{const response=await route.fetch(),s=await response.json();
  s.integrations=s.integrations.map((i:any)=>i.id==='tokenMonitor'?{...i,status:'connected',last_success:old}:i);
  s.quota_pools=[{id:'CACHE-antigravity',provider:'antigravity',name:'Antigravity',status:'ok',source:'mixed',cache_editable:true,display_state:'mixed',freshness:'stale',source_updated_at:stamp}];
  s.quota_windows=empty?[]:[{id:'w0',pool_id:'CACHE-antigravity',label:'Gemini 5-hour',kind:'session',source:'token_monitor',source_updated_at:old,display_state:'cached',freshness:'stale',remaining_percent:31},{id:'w1',pool_id:'CACHE-antigravity',label:'Gemini 4 Argon weekly',kind:'weekly',source:'user_entered',source_updated_at:stamp,display_state:'manual',freshness:'fresh',remaining_percent:21}];
  await route.fulfill({response,json:s});};
 await page.route('**/api/bootstrap',patch);await page.route('**/api/state',patch);
 for(const allEmpty of [false,true]){empty=allEmpty;await page.goto('/#/resources');await page.reload();
  await expect(page.locator('.source-line')).toContainText('2 小时前');await expect(page.locator('.source-line')).not.toContainText('刚刚');
  const cards=allEmpty?page.getByRole('article',{name:/Antigravity · /}):page.getByRole('article',{name:'Antigravity · Claude / GPT 额度',exact:true});
  for(const card of await cards.all()){await expect(card).not.toHaveClass(/stale/);await expect(card.locator('.pool-state')).toHaveText('待填写');await expect(card.locator('.pool-state')).not.toHaveClass(/\b(old|ok)\b/);}
 }
});
