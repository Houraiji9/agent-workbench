import {test,expect} from '@playwright/test';import {randomUUID} from 'node:crypto';
import {api,shot,noHorizontalScroll,makeTask,drawer} from './support.ts';

test('当前团队按 Agent 入口展示，Claude 去后缀、反重力合并、Cursor 移出',async({page})=>{
 await page.goto('/#/team');const list=page.getByRole('list',{name:'Agent 列表'});
 await expect(list.getByRole('listitem',{name:'Claude',exact:true})).toBeVisible();
 await expect(list.getByRole('listitem',{name:'Antigravity',exact:true})).toBeVisible();
 await expect(list.getByRole('listitem',{name:'Grok 网页',exact:true})).toBeVisible();
 await expect(list.getByRole('listitem',{name:/Cursor|反重力|新购|Grok 搜索/})).toHaveCount(0);
 await page.goto('/#/team/antigravity-claude');await expect(page.getByRole('heading',{name:'Antigravity',exact:true})).toBeVisible();
 await shot(page,'团队-合并后的反重力');
});

test('软件图标在明暗主题和详情正常显示，全部来自本地',async({page})=>{
 const external:string[]=[];page.on('request',r=>{if(new URL(r.url()).origin!=='http://127.0.0.1:14318')external.push(r.url())});
 await page.goto('/#/team');const list=page.getByRole('list',{name:'Agent 列表'});
 await expect(list.locator('.agent-icon img')).toHaveCount(11);
 for(const theme of ['light','dark']){
  if(theme==='dark')await page.getByRole('button',{name:'切换到深色外观'}).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme',theme);
  const images=list.locator('.agent-icon img');for(const img of await images.all()){
   await expect(img).toBeVisible();await expect.poll(()=>img.evaluate((e:HTMLImageElement)=>e.complete&&e.naturalWidth>0)).toBe(true);
   const box=await img.boundingBox();expect(box?.width).toBe(40);expect(box?.height).toBe(40);
   const src=(await img.getAttribute('src'))!;
   if(!src.startsWith('data:image/'))expect(new URL(src,page.url()).origin).toBe(new URL(page.url()).origin);
  }
  const groks=await list.getByRole('listitem',{name:/^Grok /}).locator('img').evaluateAll((es:HTMLImageElement[])=>es.map(e=>e.src));expect(new Set(groks).size).toBe(2);
  await shot(page,'团队-软件图标-'+theme);
 }
 await list.getByRole('listitem',{name:'Antigravity',exact:true}).click();const panel=page.getByRole('complementary',{name:'Antigravity 详情'});await expect(panel.getByRole('heading',{name:'Antigravity',exact:true})).toBeVisible();
 const image=panel.locator('.agent-icon img');await expect.poll(()=>image.evaluate((e:HTMLImageElement)=>e.complete&&e.naturalWidth>0)).toBe(true);expect((await image.boundingBox())?.width).toBe(52);
 await page.setViewportSize({width:390,height:1000});expect(await noHorizontalScroll(page)).toBe(true);expect(external).toEqual([]);
});

test('图片加载失败时保留可用头像和成员入口',async({page})=>{
 await page.goto('/#/team');const member=page.getByRole('listitem',{name:'Antigravity',exact:true});const src=(await member.locator('img').getAttribute('src'))!;expect(new URL(src,page.url()).pathname).toMatch(/^\/assets\//);
 await page.route(src,r=>r.abort());await page.reload();await expect(member.locator('.avatar')).toBeVisible();await expect(member.locator('img')).toHaveCount(0);
 await member.click();await expect(page.getByRole('heading',{name:'Antigravity',exact:true})).toBeVisible();
});

test('添加安排后编辑、刷新、取消删除和确认删除；不生成购买事实',async({page})=>{
 const {get}=await api(page),title='测试新安排 '+randomUUID().slice(0,8);
 await page.goto('/#/resources?tab=plans');await page.getByRole('button',{name:'添加安排',exact:true}).click();
 const d=page.getByRole('dialog',{name:'添加安排',exact:true});await d.getByLabel('名称',{exact:true}).fill(title);
 await d.getByLabel('计划日期',{exact:true}).fill('2035-04-15');await d.getByRole('button',{name:'添加',exact:true}).click();await expect(d).toHaveCount(0);
 const item=page.locator('.plan-line li').filter({hasText:title});await expect(item).toBeVisible();
 await item.getByRole('button',{name:'编辑计划'}).click();await page.getByRole('dialog').getByLabel('备注',{exact:true}).fill('测试备注：仅是安排');await page.getByRole('dialog').getByRole('button',{name:'保存',exact:true}).click();await expect(page.getByRole('dialog')).toHaveCount(0);
 await page.reload();await expect(item).toContainText('测试备注：仅是安排');
 const s=(await get('/state')).subscriptions.find((s:any)=>s.title===title);expect(s.status).toBe('planned');expect(s.confirmed_at).toBeNull();
 await item.getByRole('button',{name:'删除安排'}).click();await page.getByRole('dialog').getByRole('button',{name:'取消',exact:true}).click();await expect(item).toBeVisible();
 await item.getByRole('button',{name:'删除安排'}).click();await page.getByRole('dialog').getByRole('button',{name:'确认删除',exact:true}).click();await expect(page.getByRole('dialog')).toHaveCount(0);await page.reload();await expect(item).toHaveCount(0);
});

test('订阅新增、编辑状态与金额、删除都实际保存，输入框与标题对齐',async({page})=>{
 const title='测试新订阅 '+randomUUID().slice(0,8);await page.goto('/#/resources?tab=plans');await page.getByRole('button',{name:'添加订阅',exact:true}).click();
 const d=page.getByRole('dialog',{name:'添加订阅',exact:true});await d.getByLabel('名称',{exact:true}).fill(title);
  await d.getByLabel('金额',{exact:true}).fill('12.5');await d.getByLabel('币种',{exact:true}).fill('usd');await d.getByRole('combobox',{name:'计费周期',exact:true}).selectOption('month');
 await expect(d.locator('.field-hint')).toHaveCount(0);
 const pairs=[['结束日期','续费安排'],['金额','币种'],['计费周期','估算剩余积分']];
 for(const [a,b]of pairs){const x=await d.getByLabel(a).boundingBox(),y=await d.getByLabel(b).boundingBox();expect(Math.abs(x!.y-y!.y)).toBeLessThanOrEqual(2);expect(Math.abs(x!.height-y!.height)).toBeLessThanOrEqual(2);}
 await shot(page,'订阅-对齐后的添加表单');await d.getByRole('button',{name:'添加',exact:true}).click();await expect(d).toHaveCount(0);
 const row=page.getByRole('table',{name:'你登记的订阅',exact:true}).getByRole('row').filter({hasText:title});await expect(row).toContainText('$12.5');
 await row.getByRole('button',{name:'编辑',exact:true}).click();const edit=page.getByRole('dialog',{name:'编辑订阅记录'});await edit.getByRole('combobox',{name:'当前状态',exact:true}).selectOption('user_reported_expired');await edit.getByLabel('金额',{exact:true}).fill('0');await edit.getByRole('button',{name:'保存',exact:true}).click();await expect(edit).toHaveCount(0);
 await page.reload();await expect(row).toContainText('已过期');await expect(row).toContainText('$0 / 月');
 await row.getByRole('button',{name:'删除 '+title,exact:true}).click();await page.getByRole('dialog').getByRole('button',{name:'确认删除',exact:true}).click();await expect(page.getByRole('dialog')).toHaveCount(0);await page.reload();await expect(row).toHaveCount(0);
});

test('已确认订阅可以修改，旧删除弹窗遇到别处更新会阻止误删',async({page})=>{
 const {post,get}=await api(page),title='测试已确认 '+randomUUID().slice(0,8);
 const p=await post('/subscriptions',{title,status:'planned'});const a=await post('/subscriptions/'+p.id+'/confirm',{version:1,occurred_at:new Date().toISOString(),end_date:null,note:'测试确认，已从账号核实'});
 await page.goto('/#/resources?tab=plans');const row=page.getByRole('table',{name:'你登记的订阅',exact:true}).getByRole('row').filter({hasText:title});
 await row.getByRole('button',{name:'编辑',exact:true}).click();await page.getByRole('dialog').getByRole('textbox',{name:'备注',exact:true}).fill('已确认的记录也可以补充备注');await page.getByRole('dialog').getByRole('button',{name:'保存',exact:true}).click();await expect(page.getByRole('dialog')).toHaveCount(0);
 await row.getByRole('button',{name:/删除/}).click();const current=(await get('/state')).subscriptions.find((s:any)=>s.id===a.id);await post('/baseline/subscriptions/'+a.id,{version:current.version,changes:{note:'另一个窗口刚更新'}});
 await page.getByRole('dialog').getByRole('button',{name:'确认删除',exact:true}).click();await expect(page.getByRole('dialog').getByRole('alert')).toContainText('版本冲突');expect((await get('/state')).subscriptions.some((s:any)=>s.id===a.id)).toBe(true);
});

test('旧 Cursor 任务重新派单必须选择当前成员，不会提交已移出的入口',async({page})=>{
 const m=await makeTask(page,{title:'测试旧成员返工'});
 await page.route('**/api/tasks/'+m.tid,async r=>{const response=await r.fetch(),data=await response.json();data.task.agent_id='cursor';await r.fulfill({response,json:data})});
 await page.goto('/#/today?task='+m.tid);await drawer(page).getByRole('button',{name:'更多信息与操作'}).click();await drawer(page).getByRole('button',{name:'取消这项任务'}).click();await page.getByRole('dialog',{name:'取消这项任务？'}).getByRole('button',{name:'确认取消任务'}).click();await expect(drawer(page)).toContainText('已取消');
 await drawer(page).getByRole('button',{name:'换人或重新做一次'}).click();const d=page.getByRole('dialog',{name:'换人或重新做一次'});await expect(d.getByRole('button',{name:'新开一次并复制执行单'})).toBeDisabled();
 await expect(d.getByText('Cursor',{exact:true})).toHaveCount(0);await d.getByRole('radio',{name:/Codex/}).check();await expect(d.getByRole('button',{name:'新开一次并复制执行单'})).toBeEnabled();
});

test('移除 Token Monitor 订阅区，保留本地管理；表单窄屏不横向溢出',async({page})=>{
 const patch=async(r:any)=>{const response=await r.fetch(),data=await response.json();data.subscriptions.push({id:'external-test',title:'外部测试订阅不展示',status:'active',source:'token_monitor'});await r.fulfill({response,json:data})};
 await page.route('**/api/bootstrap',patch);await page.route('**/api/state',patch);await page.goto('/#/resources?tab=plans');
 await expect(page.getByRole('heading',{name:'你登记的订阅'})).toBeVisible();await expect(page.getByText('Token Monitor 里的订阅',{exact:true})).toHaveCount(0);await expect(page.getByText('外部测试订阅不展示')).toHaveCount(0);
 await page.getByRole('button',{name:'添加安排',exact:true}).click();const d=page.getByRole('dialog');await expect(d.locator('.field-hint')).toHaveCount(0);
 for(const width of [1440,900,390]){await page.setViewportSize({width,height:1000});expect(await noHorizontalScroll(page)).toBe(true);expect(await d.evaluate(e=>e.scrollWidth<=e.clientWidth+1)).toBe(true);}
 await shot(page,'安排-窄屏表单');
});
