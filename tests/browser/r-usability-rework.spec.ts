import {test,expect} from '@playwright/test';import {api,makeTask,noHorizontalScroll,shot} from './support.ts';

test('项目浮层不改变弹窗尺寸；低窗口、搜索、Escape及取消可用',async({page})=>{
 await api(page);
 for(const [width,height] of [[1440,1000],[1920,1080],[900,650],[390,360]]){
   await page.setViewportSize({width,height});await page.goto('/#/requests');await page.locator('.topbar').getByRole('button',{name:'提需求',exact:true}).click();const d=page.getByRole('dialog',{name:'提一个需求'}),trigger=d.getByRole('combobox',{name:'属于哪个项目'});
   await trigger.scrollIntoViewIfNeeded();await expect(d).toBeVisible();await page.waitForTimeout(180);const before=await d.boundingBox();await trigger.click();const panel=d.locator('.project-options');await expect(panel).toBeVisible();
   const after=await d.boundingBox();for(const key of ['x','y','width','height'] as const)expect(Math.abs(after![key]-before![key])).toBeLessThan(1);
   const box=await panel.boundingBox();expect(box!.y).toBeGreaterThanOrEqual(0);expect(box!.y+box!.height).toBeLessThanOrEqual(height);expect(box!.x+box!.width).toBeLessThanOrEqual(width);
   await d.getByLabel('搜索项目').fill('Agent 工作台');await expect(d.getByRole('option').first()).toBeVisible();await d.getByRole('option').first().click();await expect(trigger).toBeFocused();
   await trigger.click();await page.keyboard.press('Escape');await expect(d).toBeVisible();await expect(panel).toHaveCount(0);await trigger.click();await d.getByLabel('搜索项目').fill('没有的项目');await shot(page,'项目浮层-'+width+'x'+height);await d.getByRole('button',{name:'取消',exact:true}).click();await expect(d).toHaveCount(0);
 }
});

test('旧三种分类统一为待开始；明确开始、暂存、删除与刷新一致',async({page})=>{
 const {get,post}=await api(page);await page.goto('/#/requests');
 for(const kind of ['idea','plan','memo'])await post('/requests',{project_id:'P-workbench',text:'测试归类 '+kind,status:'draft',kind});
 await page.reload();const card=page.getByRole('article',{name:'测试归类 plan',exact:true});await card.getByRole('button',{name:'现在开始'}).click();await page.getByRole('dialog',{name:'下一步：发给 Codex'}).getByRole('button',{name:'关闭',exact:true}).first().click();await expect(page.getByRole('tab',{name:'待规划'})).toHaveAttribute('aria-selected','true');await expect(card).toBeVisible();
 await card.getByRole('button',{name:'暂时不做'}).click();await page.getByRole('dialog',{name:'暂时不做'}).getByRole('button',{name:'暂时不做'}).click();await expect(page.getByRole('tab',{name:'待开始'})).toHaveAttribute('aria-selected','true');await expect(card).toBeVisible();await shot(page,'需求箱-分类与操作');
 await card.getByRole('button',{name:'删除',exact:true}).click();await page.getByRole('dialog',{name:'删除需求'}).getByRole('button',{name:'取消'}).click();await expect(card).toBeVisible();await card.getByRole('button',{name:'删除',exact:true}).click();await page.getByRole('button',{name:'确认删除'}).click();await expect(card).toHaveCount(0);await page.reload();await expect(card).toHaveCount(0);
});

test('待规划及未派发计划可删除；旧表单冲突和已执行需求保留',async({page})=>{
 const {get,post}=await api(page),q=await post('/requests',{project_id:'P-workbench',text:'测试等待规划删除'});await page.goto('/#/today');await page.getByRole('button',{name:/^待安排（/}).click();await page.getByRole('textbox',{name:'搜索待办'}).fill('测试等待规划删除');let card=page.getByRole('article',{name:q.text,exact:true});await card.getByRole('button',{name:'删除',exact:true}).click();await post('/requests/'+q.id+'/edit',{version:q.version,project_id:q.project_id,text:q.text+'更新'});await page.getByRole('button',{name:'确认删除'}).click();await expect(page.getByRole('alert')).toContainText('需求已更新');await page.getByRole('dialog').getByRole('button',{name:'取消'}).click();card=page.getByRole('article',{name:q.text+'更新',exact:true});await card.getByRole('button',{name:'删除',exact:true}).click();await page.getByRole('button',{name:'确认删除'}).click();await expect(card).toHaveCount(0);
 const m=await makeTask(page,{title:'测试删除未派发',stage:'order'}),state=await get('/state'),request=state.requests.find((x:any)=>x.id===state.tasks.find((t:any)=>t.id===m.tid).request_id);await page.goto('/#/requests?tab=planned');card=page.getByRole('article',{name:request.text,exact:true});await card.getByRole('button',{name:'删除',exact:true}).click();await expect(page.getByRole('dialog')).toContainText('撤回尚未派发的计划');await page.getByRole('button',{name:'确认删除'}).click();await expect(card).toHaveCount(0);expect((await get('/state')).tasks.find((t:any)=>t.id===m.tid).status).toBe('cancelled');
 const running=await makeTask(page,{title:'测试执行中保留',stage:'running'});await page.reload();const c=page.getByRole('article',{name:'测试需求：'+running.title,exact:true});await expect(c).toBeVisible();await expect(c.getByRole('button',{name:'删除',exact:true})).toHaveCount(0);
});

test('额度卡片逐行顶底对齐、缩放无横向溢出；团队入口统一命名',async({page})=>{
 const {post}=await api(page);for(let i=1;i<=8;i++)await post('/quotas',{version:0,source_ref:null,name:'测试整行卡片 '+i,members:['codex'],windows:Array.from({length:(i%3)+1},(_,j)=>({label:'窗口 '+j,metric:'percent',remaining:70,limit:null,currency:null,unit:'%',resets_at:null}))});
 const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));await page.goto('/#/resources');
 for(const width of [2560,1920,1440,900,390]){await page.setViewportSize({width,height:1080});await expect.poll(()=>page.locator('.quota-rows').first().evaluate(el=>{const cols=getComputedStyle(el).gridTemplateColumns.split(' ').length,boxes=[...el.children].map(c=>c.getBoundingClientRect());return boxes.every((b,i)=>{const first=boxes[Math.floor(i/cols)*cols];return Math.abs(b.top-first.top)<1&&Math.abs(b.bottom-first.bottom)<1})})).toBe(true);expect(await noHorizontalScroll(page)).toBe(true);await shot(page,'额度整行对齐-'+width)}
 await page.goto('/#/team');await expect(page.getByRole('button',{name:'新增团队',exact:true})).toBeVisible();await page.getByRole('button',{name:'新增团队',exact:true}).click();await expect(page.getByRole('dialog',{name:'新增团队'})).toBeVisible();expect(errors).toEqual([]);
});
