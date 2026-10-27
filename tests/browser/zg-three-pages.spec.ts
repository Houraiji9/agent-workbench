import {test,expect} from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {api,makeTask,shot,noHorizontalScroll} from './support.ts';
import {taskInput} from '../helpers.ts';

// 今天/需求箱/项目三页的职责与入口：合成数据，隔离账本。
async function bigProject(page:any,count:number){
  const a=await api(page),folder=path.join(a.root,'三页-'+randomUUID().slice(0,8));fs.mkdirSync(folder);
  const project=await a.post('/projects',{name:'测试三页项目 '+randomUUID().slice(0,4),path:folder});
  const q=await a.post('/requests',{project_id:project.id,text:'测试：批量任务'});
  await a.post('/plans',{schema_version:1,plan_id:'tp-'+randomUUID(),request_id:q.id,expected_version:1,tasks:Array.from({length:count},(_,i)=>({...taskInput(folder,'t'+i),title:'三页任务 '+i}))});
  return {a,project,folder};
}
async function startPlanningRequest(a:any,projectId:string,text:string){
  const q=await a.post('/requests',{project_id:projectId,text,status:'draft'});
  return a.post('/requests/'+q.id+'/edit',{project_id:projectId,text,status:'awaiting_planning',kind:'idea',version:q.version,workflow_kind:'standard',desired_output:'',success_criteria:'',review_mode:'required',review_focus:[],skip_review:false,review_note:''});
}

test('今天：待安排的复制入口无需展开，需求卡片名称与需求箱一致，搜索计数准确',async({page})=>{
  const {a,project}=await bigProject(page,3);
  const text='测试待规划需求 '+randomUUID().slice(0,6),q=await startPlanningRequest(a,project.id,text);
  await page.goto('/#/today');await page.getByRole('combobox',{name:'按项目筛选待办'}).selectOption(project.id);
  const group=page.getByRole('region',{name:'待安排'});
  await expect(group).toBeVisible();await expect(group.locator('summary')).toHaveCount(0);
  const card=group.getByRole('article',{name:text,exact:true});
  await expect(card.getByRole('button',{name:'复制规划请求',exact:true})).toBeVisible();
  await expect(card.getByRole('button',{name:'粘贴规划 Agent 的计划'})).toBeVisible();
  await expect(card.locator('.pill')).toHaveText('待规划');
  const order=group.getByRole('article',{name:'三页任务 0',exact:true});
  await expect(order.getByRole('button',{name:/复制执行单/})).toBeVisible();
  await page.getByRole('textbox',{name:'搜索待办'}).fill('三页任务 1');
  await expect(page.locator('.turn')).toHaveCount(1);
  await expect(page.getByRole('button',{name:'待安排（1）',exact:true})).toBeVisible();
  await page.getByRole('textbox',{name:'搜索待办'}).fill(text);
  await expect(page.locator('.turn')).toHaveCount(1);
  await page.getByRole('button',{name:'编辑需求'}).click();await expect(page.getByRole('dialog',{name:'编辑需求'})).toBeVisible();await page.keyboard.press('Escape');
  expect(q.status).toBe('awaiting_planning');
  await page.setViewportSize({width:880,height:600});expect(await noHorizontalScroll(page)).toBe(true);
});

test('需求箱：每条需求一个主操作，次要操作低调可见；页签计数、项目筛选与完整原文保留',async({page})=>{
  const {a,project}=await bigProject(page,1);
  const samplePath=path.join(a.root,'测试',...Array(20).fill('目录'));
  const long='测试长需求：'+'含网址 https://example.com/'+'很长的路径/'.repeat(30)+' 与 '+samplePath+'。'.repeat(3)+'结尾标记';
  await a.post('/requests',{project_id:project.id,text:long,status:'draft'});
  const waiting=await startPlanningRequest(a,project.id,'测试待规划 '+randomUUID().slice(0,6));
  await page.goto('/#/requests/'+project.id+'?tab=drafts');
  await expect(page.getByLabel('筛选需求项目')).toHaveValue(project.id);
  await expect(page.getByRole('tab',{name:/^待开始/})).toContainText('1');await expect(page.getByRole('tab',{name:/^待规划/})).toContainText('1');
  const draft=page.getByRole('article',{name:long,exact:true});
  await expect(draft.getByRole('button',{name:'现在开始',exact:true})).toBeVisible();
  await expect(draft.getByRole('group',{name:'其他操作'}).getByRole('button',{name:'继续编辑'})).toBeVisible();
  await expect(draft.getByRole('button',{name:'复制规划请求'})).toHaveCount(0);
  await draft.getByRole('button',{name:'查看全文'}).click();
  const full=page.getByRole('dialog',{name:'需求全文'});await expect(full).toContainText('结尾标记');
  await page.context().grantPermissions(['clipboard-read','clipboard-write']);
  await full.getByRole('button',{name:'复制全文'}).click();expect(await page.evaluate(()=>navigator.clipboard.readText())).toBe(long);await page.keyboard.press('Escape');
  await page.getByRole('tab',{name:/^待规划/}).click();
  const card=page.getByRole('article',{name:waiting.text,exact:true});
  await expect(card.getByRole('button',{name:'复制规划请求',exact:true})).toBeVisible();await expect(card.getByRole('button',{name:'在聊天里规划'})).toBeVisible();
  const more=card.getByRole('group',{name:'其他操作'});
  for(const label of ['编辑需求','暂时不做','删除'])await expect(more.getByRole('button',{name:label,exact:true})).toBeVisible();
  await card.getByRole('button',{name:'在聊天里规划'}).click();await expect(page.getByRole('dialog',{name:'在聊天里规划'})).toBeVisible();await page.keyboard.press('Escape');
  await page.getByRole('tab',{name:/^已生成计划/}).click();
  await expect(page.getByRole('button',{name:'查看执行顺序'}).first()).toBeVisible();
  for(const width of [1360,880]){await page.setViewportSize({width,height:width===880?600:900});expect(await noHorizontalScroll(page)).toBe(true);}
});

test('项目：头部只留主操作，更多菜单键盘可用；资料与设置按需进入，旧链接有效；大量任务分页，需求只留摘要',async({page})=>{
  const {a,project}=await bigProject(page,30);
  const waiting=await startPlanningRequest(a,project.id,'测试项目页待规划 '+randomUUID().slice(0,6));
  await page.goto('/#/projects/'+project.id);
  const head=page.locator('.project-head .head-actions');
  await expect(head.getByRole('button',{name:'提需求',exact:true})).toBeVisible();await expect(head.getByRole('button',{name:'编辑资料',exact:true})).toBeVisible();
  await expect(head.getByRole('button',{name:'归档项目'})).toBeHidden();
  const menu=head.locator('.more-menu > summary');await menu.focus();await page.keyboard.press('Enter');
  await expect(head.getByRole('button',{name:'归档项目',exact:true})).toBeVisible();await expect(head.getByRole('button',{name:'收纳并暂缓新安排'})).toBeVisible();
  await page.keyboard.press('Escape');await expect(head.getByRole('button',{name:'归档项目'})).toBeHidden();await expect(menu).toBeFocused();
  await menu.click();await page.locator('h1').click();await expect(head.getByRole('button',{name:'归档项目'})).toBeHidden();
  // 需求区只有摘要和主操作，管理入口在需求箱
  const row=page.locator('.row.static').filter({hasText:waiting.text});
  await expect(row.getByRole('button',{name:'复制规划请求'})).toBeVisible();await expect(row.getByRole('button',{name:'编辑'})).toHaveCount(0);await expect(row.getByRole('button',{name:'删除'})).toHaveCount(0);
  // 大量任务：先显示 20 项，其余按需加载
  await expect(page.locator('.order-row')).toHaveCount(20);
  await page.getByRole('button',{name:/显示更多（共 30 项）/}).click();await expect(page.locator('.order-row')).toHaveCount(30);
  await page.getByRole('link',{name:'在需求箱管理'}).or(page.getByRole('button',{name:'在需求箱管理'})).click();
  await expect(page.getByLabel('筛选需求项目')).toHaveValue(project.id);await expect(page.getByRole('tab',{name:/^待规划/})).toHaveAttribute('aria-selected','true');
  await page.goBack();await expect(page.locator('.project-head h1')).toBeVisible();
  // 资料与设置：旧链接 tab=folders 仍可用，模型策略、交付信息、文件夹都在这里
  await page.goto('/#/projects/'+project.id+'?tab=folders');
  await expect(page.getByRole('tab',{name:'资料与设置'})).toHaveAttribute('aria-selected','true');
  await expect(page.getByText('默认交付',{exact:true})).toBeVisible();await expect(page.getByText('项目默认模型与子代理设置',{exact:true})).toBeVisible();await expect(page.getByRole('button',{name:'导出项目上下文'}).or(page.getByRole('link',{name:'导出项目上下文'}))).toBeVisible();
  // 任务、成果、用量与过程、关系图仍可进入
  const tabs=page.getByRole('tablist',{name:'项目内容'});
  for(const tab of ['成果','用量与过程','关系图','任务']){await tabs.getByRole('tab',{name:new RegExp('^'+tab)}).click();await expect(tabs.getByRole('tab',{name:new RegExp('^'+tab)})).toHaveAttribute('aria-selected','true');}
  await shot(page,'三页-项目任务',false);
});

test('项目：最小窗口无横向溢出，收纳与归档入口仍可发现',async({page})=>{
  const m=await makeTask(page,{title:'测试最小窗口项目'});
  await page.setViewportSize({width:880,height:600});
  for(const route of ['today','requests','projects','projects/'+m.project.id,'projects/'+m.project.id+'?tab=folders']){await page.goto('/#/'+route);await expect(page.locator('h1').first()).toBeVisible();expect(await noHorizontalScroll(page),route).toBe(true);}
  await page.goto('/#/projects/'+m.project.id);await page.locator('.more-menu > summary').click();
  const archive=page.getByRole('button',{name:'归档项目',exact:true});await expect(archive).toBeVisible();
  const box=await archive.boundingBox(),vp=page.viewportSize()!;expect(box!.x).toBeGreaterThanOrEqual(0);expect(box!.x+box!.width).toBeLessThanOrEqual(vp.width);
});

test('长网址与长路径的需求：三页最小窗口无横向溢出，全文保留',async({page})=>{
  const {a,project}=await bigProject(page,1);
  const longFolder=path.join(a.root,'长名-'+randomUUID().slice(0,8));fs.mkdirSync(longFolder);
  await a.post('/projects',{name:'很长的项目名称'.repeat(25),path:longFolder});
  const url='https://example.com/'+'very-long-segment-without-break/'.repeat(12),path_=['G:','项目','合成',...Array(12).fill('很长的目录名')].join(String.fromCharCode(92));
  const draft=await a.post('/requests',{project_id:project.id,text:'测试草稿 '+url+' '+path_,status:'draft'});
  const waiting=await startPlanningRequest(a,project.id,'测试待规划 '+url+' '+path_);
  await page.setViewportSize({width:880,height:600});
  for(const route of ['requests?tab=drafts','requests?tab=waiting','today','projects/'+project.id]){
    await page.goto('/#/'+route);await expect(page.locator('h1').first()).toBeVisible();
    const over=await page.evaluate(()=>{const w=window.innerWidth;return [...document.querySelectorAll('main *')].filter(el=>el.getBoundingClientRect().right>w+1&&getComputedStyle(el).position!=='fixed').slice(0,5).map(el=>el.className||el.tagName)});
    expect(await noHorizontalScroll(page),route+' '+JSON.stringify(over)).toBe(true);
  }
  expect(draft.text).toContain(url);expect(waiting.text).toContain(path_);
});
