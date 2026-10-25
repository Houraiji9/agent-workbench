import {test,expect} from '@playwright/test';import fs from 'node:fs';import path from 'node:path';import {randomUUID} from 'node:crypto';import {api,shot,noHorizontalScroll,makeTask} from './support.ts';

test('项目选择可搜索，草稿备忘持久化、可修改再提交，旧表单提示版本冲突',async({page})=>{
 const {post,get,root}=await api(page);let project:any;
 for(let i=0;i<35;i++){const folder=path.join(root,'需求选择-'+i);fs.mkdirSync(folder,{recursive:true});project=await post('/projects',{name:'筛选测试项目 '+i,path:folder})}
 await page.goto('/#/requests');await page.getByRole('button',{name:'提需求',exact:true}).click();let d=page.getByRole('dialog',{name:'提一个需求'});
 await expect(d.getByRole('listbox')).toHaveCount(0);await d.getByRole('combobox',{name:'属于哪个项目'}).click();await d.getByLabel('搜索项目').fill('筛选测试项目 34');await expect(d.getByRole('listbox').getByRole('option')).toHaveCount(1);await d.getByRole('listbox').getByRole('option').click();await expect(d.getByRole('listbox')).toHaveCount(0);
 await d.getByLabel('你想完成什么？').fill('测试草稿：下个月再做的项目整理');await d.getByRole('button',{name:'先记下来',exact:true}).click();await expect(d).toHaveCount(0);await page.reload();let card=page.getByRole('article',{name:'测试草稿：下个月再做的项目整理'});await expect(card).toContainText('待开始');await shot(page,'需求箱-未来计划');
 let q=(await get('/state')).requests.find((q:any)=>q.text==='测试草稿：下个月再做的项目整理');expect(q.status).toBe('draft');expect(q.project_id).toBe(project.id);
 await page.goto('/#/today');await expect(page.getByRole('article',{name:q.text})).toHaveCount(0);
 await page.goto('/#/requests');await card.getByRole('button',{name:'继续编辑'}).click();d=page.getByRole('dialog',{name:'编辑需求'});await d.getByLabel('你想完成什么？').fill('测试草稿修改：先整理素材');await d.getByRole('button',{name:'保存，稍后再做'}).click();card=page.getByRole('article',{name:'测试草稿修改：先整理素材'});await expect(card).toContainText('待开始');
 await card.getByRole('button',{name:'继续编辑'}).click();d=page.getByRole('dialog',{name:'编辑需求'});q=(await get('/state')).requests.find((x:any)=>x.id===q.id);await post('/requests/'+q.id+'/edit',{project_id:q.project_id,version:q.version,text:'测试别处更新',status:'draft',kind:'memo'});await d.getByRole('button',{name:'保存，稍后再做'}).click();await expect(d.getByRole('alert')).toContainText('需求已更新');await d.getByRole('button',{name:'取消'}).click();
 await page.getByRole('article',{name:'测试别处更新'}).getByRole('button',{name:'现在开始'}).click();await expect(page.getByRole('dialog',{name:'下一步：发给 Codex'})).toBeVisible();await page.getByRole('dialog',{name:'下一步：发给 Codex'}).getByRole('button',{name:'关闭'}).first().click();await expect(page.getByRole('article',{name:'测试别处更新'}).getByRole('button',{name:'编辑需求'})).toBeVisible();expect((await get('/state')).requests.find((x:any)=>x.id===q.id).status).toBe('awaiting_planning');
});

test('项目搜索、归档查看、恢复及隐藏新需求选择，草稿与项目资料保留',async({page})=>{
 const {post,get,root}=await api(page),folder=path.join(root,'归档项目-'+randomUUID());fs.mkdirSync(folder);const p=await post('/projects',{name:'测试归档项目',path:folder,goal:'保存旧成果'});await post('/requests',{project_id:p.id,text:'测试归档项目备忘',status:'draft',kind:'memo'});
 await page.goto('/#/projects/'+p.id);await page.locator('.more-menu > summary').click();await page.getByRole('button',{name:'归档项目',exact:true}).click();await page.getByRole('button',{name:'确认归档'}).click();await expect(page.getByRole('tab',{name:'已归档'})).toHaveAttribute('aria-selected','true');await expect(page.locator('.project-card').filter({hasText:p.name})).toBeVisible();await shot(page,'项目-已归档');
 await page.getByRole('tab',{name:'当前项目'}).click();await page.getByLabel('搜索项目').fill(p.name);await expect(page.locator('.project-card')).toHaveCount(0);
 await page.locator('.topbar').getByRole('button',{name:'提需求',exact:true}).click();const d=page.getByRole('dialog',{name:'提一个需求'});await d.getByRole('combobox',{name:'属于哪个项目'}).click();await d.getByLabel('搜索项目').fill(p.name);await expect(d.getByRole('listbox').getByRole('option')).toHaveCount(0);await d.getByRole('button',{name:'取消'}).click();
 await page.getByRole('tab',{name:'已归档'}).click();await page.locator('.project-card').filter({hasText:p.name}).click();await expect(page.getByText('测试归档项目备忘')).toBeVisible();await page.locator('.more-menu > summary').click();await page.getByRole('button',{name:'恢复项目',exact:true}).click();await page.getByRole('dialog',{name:'恢复项目'}).getByRole('button',{name:'恢复项目'}).click();await page.reload();expect((await get('/state')).projects.find((x:any)=>x.id===p.id).archived).toBe(false);await page.goto('/#/projects');await page.getByLabel('搜索项目').fill(p.name);await expect(page.locator('.project-card').filter({hasText:p.name})).toBeVisible();
});

test('团队页签与各页面右上入口位置稳定；切换长短页面重置滚动',async({page})=>{
 for(const width of [2560,1440,900,390]){
   await page.setViewportSize({width,height:900});await page.goto('/#/team');await expect(page.getByRole('tab',{name:'我的团队'})).toBeVisible();const baseline=await page.getByRole('tablist',{name:'团队管理'}).boundingBox(),button=await page.locator('.topbar').getByRole('button',{name:'提需求',exact:true}).boundingBox();
   for(const name of ['预设库','已移除','我的团队']){await page.getByRole('tab',{name,exact:true}).click();await expect.poll(async()=>{const b=await page.getByRole('tablist',{name:'团队管理'}).boundingBox();return Math.abs(b!.x-baseline!.x)+Math.abs(b!.y-baseline!.y)}).toBeLessThan(1);expect(await noHorizontalScroll(page)).toBe(true)}
   for(const route of ['resources','requests','projects','settings','today']){await page.goto('/#/'+route);await expect(page.locator('.topbar').getByRole('button',{name:'提需求',exact:true})).toBeVisible();const b=await page.locator('.topbar').getByRole('button',{name:'提需求',exact:true}).boundingBox();expect(Math.abs(b!.x-button!.x)+Math.abs(b!.y-button!.y),width+' '+route).toBeLessThan(1)}
 }
 await page.setViewportSize({width:1440,height:900});await page.goto('/#/team?tab=presets');await page.locator('.preset-card').last().scrollIntoViewIfNeeded();expect(await page.evaluate(()=>scrollY)).toBeGreaterThan(0);await page.locator('nav').getByRole('button',{name:'项目',exact:true}).click();await expect.poll(()=>page.evaluate(()=>scrollY)).toBe(0);
});

test('同优先级额度保留大小排序，放大缩小无重叠或溢出',async({page})=>{
 const {post}=await api(page);for(let i=1;i<=4;i++)await post('/quotas',{version:0,source_ref:null,name:'测试不同高度额度 '+i,members:['codex'],windows:Array.from({length:i},(_,j)=>({label:'窗口 '+j,metric:'percent',remaining:90-i*10,limit:null,currency:null,unit:'%',resets_at:null}))});
 const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));await page.goto('/#/resources');
 for(const width of [2560,1440,900,390]){await page.setViewportSize({width,height:1000});await expect.poll(()=>page.locator('.quota-rows').first().evaluate(el=>{const boxes=[...el.children].map(c=>c.getBoundingClientRect());const area=el.getBoundingClientRect();return boxes.length>0&&boxes.every(b=>b.left>=area.left-1&&b.right<=area.right+1)&&boxes.every((b,i)=>boxes.slice(i+1).every(a=>a.left>=b.right-1||b.left>=a.right-1||a.top>=b.bottom+12||b.top>=a.bottom+12))})).toBe(true);await expect.poll(()=>page.getByRole('article',{name:/测试不同高度额度/}).evaluateAll(els=>els.map(el=>el.getAttribute('aria-label')))).toEqual([4,3,2,1].map(i=>'测试不同高度额度 '+i+' 额度'));expect(await noHorizontalScroll(page)).toBe(true);if(width===1440||width===390)await shot(page,'额度-按大小排列-'+width)}
 await page.getByRole('button',{name:'切换到深色外观'}).click();await page.setViewportSize({width:1440,height:1000});await shot(page,'额度-按大小排列-深色');expect(errors).toEqual([]);
});

test('最近完成位于日程额度连接的下方，所有宽度保持底部',async({page})=>{
 const m=await makeTask(page,{title:'测试最近完成置底',skipReview:true,stage:'reviewed'});await page.goto('/#/today?task='+m.tid);await page.getByRole('button',{name:'试用后确认完成'}).click();const d=page.getByRole('dialog',{name:'试用后确认完成'});await d.getByLabel('我能看懂测试结果').check();await d.getByLabel('结果符合测试需求').check();await d.getByRole('button',{name:'确认结果符合需求'}).click();await page.goto('/#/today');
 for(const width of [1920,900,390]){await page.setViewportSize({width,height:1000});const done=await page.getByRole('region',{name:'最近完成'}).boundingBox(),side=await page.getByRole('complementary',{name:'概况'}).boundingBox();expect(done!.y).toBeGreaterThanOrEqual(side!.y+side!.height);if(width===900)await shot(page,'今天-最近完成在底部')}
});

test('低矮窗口可搜索和点选项目，撤回旧计划后不能从旧任务重新派发',async({page})=>{
 const {get}=await api(page);const m=await makeTask(page,{title:'测试未派发计划撤回',stage:'order'});const state=await get('/state'),q=state.requests.find((x:any)=>x.id===state.tasks.find((t:any)=>t.id===m.tid).request_id);
 await page.setViewportSize({width:390,height:360});await page.goto('/#/requests?tab=planned');await page.getByRole('article',{name:q.text,exact:true}).getByRole('button',{name:'编辑需求'}).click();const d=page.getByRole('dialog',{name:'编辑需求'});
 await d.getByRole('combobox',{name:'属于哪个项目'}).click();await d.getByLabel('搜索项目').fill('Agent 工作台');const option=d.getByRole('listbox').getByRole('option').first();await option.click();await d.getByLabel('你想完成什么？').fill('测试撤回：改成未来备忘');await d.getByLabel('撤回尚未派发的原计划，按本次修改保存').check();await d.getByRole('button',{name:'保存，稍后再做'}).click();await expect(d).toHaveCount(0);
 await page.setViewportSize({width:1440,height:900});await page.goto('/#/today?task='+m.tid);await page.getByText('更多信息与操作',{exact:true}).click();await expect(page.getByRole('button',{name:'换人或重新做一次',exact:true})).toHaveCount(0);expect((await get('/state')).tasks.find((t:any)=>t.id===m.tid).request_withdrawn).toBe(true);
});
