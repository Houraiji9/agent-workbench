import {test,expect} from '@playwright/test';import path from 'node:path';import {api,drawer,noHorizontalScroll} from './support.ts';
async function open(page:any,title:string){const a=await api(page),t=a.boot.tasks.find((t:any)=>t.title==='测试0416：'+title);expect(t).toBeTruthy();await page.goto('/#/today?task='+t.id);return t;}
test('双人与三人进度直接可见，调用退出只属于对应成员',async({page})=>{
 await open(page,'双人审查');let d=drawer(page);const compact=d.locator('.relay-compact');await expect(compact.getByText('已回报 0/2',{exact:false})).toBeVisible();await expect(compact.getByText('审查中',{exact:true})).toHaveCount(2);
 await open(page,'三人审查');d=drawer(page);await expect(d.locator('.relay-compact .review-lane')).toHaveCount(3);await expect(d.locator('.relay-compact')).toContainText('待继续 · 尚未回报');await expect(d.getByRole('region',{name:'现在要做什么'})).toContainText('1 位审查中');
 const collaboration=d.getByRole('region',{name:'独立审查协作'});await expect(collaboration.getByRole('button',{name:'继续审查',exact:true})).toBeEnabled();await expect(collaboration.getByRole('button',{name:'复制共同审查交接',exact:true})).toBeEnabled();await expect(d.getByRole('button',{name:'导入审查回执',exact:true})).toBeEnabled();
 await expect(d.getByText('客户端调用受阻',{exact:true})).toHaveCount(0);await d.getByText('完整执行流程',{exact:true}).click();await expect(d.locator('.relay-members .review-lane')).toHaveCount(3);
 if(process.env.WORKBENCH_EVIDENCE_DIR)await page.screenshot({path:path.join(process.env.WORKBENCH_EVIDENCE_DIR,'0416-three-reviewers.png'),fullPage:true});
 await page.setViewportSize({width:375,height:850});expect(await noHorizontalScroll(page)).toBe(true);if(process.env.WORKBENCH_EVIDENCE_DIR)await page.screenshot({path:path.join(process.env.WORKBENCH_EVIDENCE_DIR,'0416-mobile.png'),fullPage:true});
});
test('继续与复制指向所选成员，不被另一人的运行状态禁用',async({page})=>{
 const t=await open(page,'一人待继续'),a=await api(page),detail=await a.get('/tasks/'+t.id),member=detail.review_summary.members.find((m:any)=>m.invocation?.status==='failed');
 let body:any;await page.route('**/api/tasks/'+t.id+'/dispatch-review',async route=>{body=route.request().postDataJSON();await route.fulfill({status:200,contentType:'application/json',body:'{}'});});
 await drawer(page).getByRole('region',{name:'独立审查协作'}).getByRole('button',{name:'继续审查',exact:true}).click();await expect.poll(()=>body?.review_id).toBe(member.id);expect(body.fresh_session).toBe(false);
 await expect(drawer(page).getByRole('button',{name:'导入审查回执',exact:true})).toBeEnabled();
});
test('提需求规划人与重要程度控件等高对齐，窄屏正常换行',async({page})=>{
 await api(page);await page.goto('/#/today');await page.getByRole('banner').getByRole('button',{name:'提需求',exact:true}).click();const d=page.getByRole('dialog',{name:'提一个需求',exact:true});
 const a=await d.getByLabel('需求重要程度').boundingBox(),b=await d.getByLabel('交给谁规划').boundingBox();expect(a).toBeTruthy();expect(b).toBeTruthy();expect(Math.abs(a!.height-b!.height)).toBeLessThanOrEqual(1);expect(Math.abs(a!.y-b!.y)).toBeLessThanOrEqual(1);
 if(process.env.WORKBENCH_EVIDENCE_DIR)await d.screenshot({path:path.join(process.env.WORKBENCH_EVIDENCE_DIR,'0416-request-form.png')});await page.setViewportSize({width:375,height:700});expect(await noHorizontalScroll(page)).toBe(true);await expect(d.getByLabel('交给谁规划')).toBeVisible();
});
test('交给审查者直接复制不指定接收者的同一份交接，多人也不弹出选择或任务详情',async({page})=>{
 const t=await open(page,'三人审查');await drawer(page).getByRole('button',{name:'关闭任务',exact:true}).click();
 const row=page.locator('.quick-action-row').filter({hasText:'测试0416：三人审查'});await row.getByRole('button',{name:'交给审查者',exact:true}).click();
 await expect.poll(()=>page.evaluate(()=>navigator.clipboard.readText())).toContain('不再让用户逐人转发');const text=await page.evaluate(()=>navigator.clipboard.readText());expect(text).toContain('RH-');expect(text).not.toMatch(/审查者：|requested_model/);await expect(drawer(page)).toHaveCount(0);await expect(page.getByRole('dialog')).toHaveCount(0);
 const first=text;await row.getByRole('button',{name:'交给审查者',exact:true}).click();await expect.poll(()=>page.evaluate(()=>navigator.clipboard.readText())).toBe(first);
 const a=await api(page);expect((await a.get('/tasks/'+t.id)).review_summary.members).toHaveLength(3);
});
