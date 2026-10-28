import {test,expect} from '@playwright/test';
import {makeTask,noHorizontalScroll,shot} from './support.ts';
import {aggregateProjectUsage,type UsageEventInput} from '../../src/core/project-usage.ts';

test('调用来源默认20项，翻页搜索保留总量；统一关系图保留来源并携带任务定位',async({page})=>{
  const m=await makeTask(page,{title:'合成有界关系来源',stage:'running'});
  const jobs=Array.from({length:45},(_,i)=>({id:'synthetic-job-'+i,project_id:m.project.id,task_id:m.tid,run_id:m.rid}));
  const events:UsageEventInput[]=jobs.map((j,i)=>({source:'synthetic:bounded-ui',job_id:j.id,project_id:m.project.id,task_id:m.tid,run_id:m.rid,event_id:'synthetic-event-'+i,scope_id:j.id,epoch:j.id,sequence:0,mode:'incremental',occurred_at:'2026-10-28T00:00:00Z',usage:{total_tokens:10}}));
  const usage=aggregateProjectUsage(events,jobs,{project_id:m.project.id});
  await page.route('**/api/projects/'+m.project.id+'/insights*',async route=>{
    const response=await route.fetch(),json=await response.json(),nodes=Array.from({length:45},(_,i)=>({id:'delegation:synthetic-'+i,record_id:'synthetic-'+i,task_id:m.tid,kind:'delegation',label:'合成子代理来源 '+i,agent:'codex',source:'executor_reported',requested_model:'synthetic-planned-model',actual_model:i===44?'synthetic-reported-model':null,artifact_paths:i===44?['synthetic/path/report.txt']:[]}));
    const edges=nodes.map(n=>({from:'run:'+m.rid,to:n.id,kind:'delegation',label:'执行者报告的委派'}));
    await route.fulfill({response,json:{...json,usage,graph:{...json.graph,nodes:[...json.graph.nodes,...nodes],edges:[...json.graph.edges,...edges],unresolved:[...json.graph.unresolved,{from:'run:'+m.rid,to:'session:synthetic-unresolved',kind:'session_run',label:'合成未解析会话'}]}}});
  });
  await page.goto('/#/projects/'+m.project.id+'?tab=insights');
  await expect(page.getByRole('checkbox',{name:'显示已结束任务',exact:true})).not.toBeChecked();
  await expect(page.getByRole('group',{name:'项目阶段与 Agent 泳道'})).toHaveCount(0);
  await page.getByText('逐项追溯调用（45 项）',{exact:true}).click();
  const calls=page.getByRole('group',{name:'调用记录',exact:true});
  await expect(calls.locator('.pi-trace-job')).toHaveCount(20);
  await expect(calls.getByText('共 45 项 · 每页 20 项',{exact:true})).toBeVisible();
  await calls.getByRole('button',{name:'下一页',exact:true}).click();
  await expect(calls.locator('.pi-trace-job').first()).toContainText('synthetic-job-20');
  await calls.getByRole('button',{name:'下一页',exact:true}).click();
  await expect(calls.locator('.pi-trace-job')).toHaveCount(5);
  await calls.getByLabel('搜索调用记录',{exact:true}).fill('synthetic-job-44');
  await expect(calls.locator('.pi-trace-job')).toHaveCount(1);
  await expect(calls.getByText('共 45 项 · 匹配 1 项 · 每页 20 项',{exact:true})).toBeVisible();
  await page.getByRole('combobox',{name:'任务',exact:true}).selectOption(m.tid);
  await page.getByRole('button',{name:'查看完整关系图',exact:true}).click();
  await expect(page.getByRole('combobox',{name:'定位任务',exact:true})).toHaveValue(m.tid);
  await expect(page.getByRole('dialog',{name:'任务详情'})).toHaveCount(0);
  await expect(page.getByRole('group',{name:'项目阶段与 Agent 泳道'})).toBeVisible();
  const canvas=page.locator('.pi-flow-viewport');
  await expect.poll(()=>canvas.evaluate(e=>e.scrollHeight>e.clientHeight)).toBe(true);
  await page.getByRole('button',{name:'到画布末尾',exact:true}).click();
  expect(await canvas.evaluate(e=>e.scrollTop+e.clientHeight>=e.scrollHeight-1)).toBe(true);
  await page.getByText('文字流程与来源记录',{exact:false}).click();
  const source=page.getByRole('group',{name:'流程来源',exact:true});
  expect(await source.locator(':scope > .pi-record-window > .pi-source-record').count()).toBe(20);
  await source.getByLabel('搜索流程来源',{exact:true}).fill('synthetic-44');
  await expect(source.getByText('报告的产物路径（未核验）：synthetic/path/report.txt',{exact:true})).toBeVisible();
  await expect(source.getByText('synthetic-reported-model',{exact:false})).toBeVisible();
  await expect(page.getByText('未解析关系（1 项）',{exact:true})).toBeVisible();
  expect(await noHorizontalScroll(page)).toBe(true);await shot(page,'关系图-来源分页与任务定位',false);
  await page.getByRole('button',{name:'清除定位',exact:true}).click();
  await expect(page.getByRole('combobox',{name:'定位任务',exact:true})).toHaveValue('');
});

test('原关系视图保留任务依赖执行与会话，窄屏画布边界可滚动',async({page})=>{
  const m=await makeTask(page,{title:'合成关系视图保留',stage:'running'});
  await page.goto('/#/projects/'+m.project.id+'?tab=diagrams');
  await page.setViewportSize({width:390,height:844});
  const selector=page.getByRole('combobox',{name:'关系图类型',exact:true});
  for(const view of ['tasks','execution','sessions']){
    await selector.selectOption(view);await expect(page.getByRole('group',{name:'真实任务关系',exact:true})).toBeVisible();
    await page.getByRole('button',{name:'放大关系图',exact:true}).click();
    await page.getByRole('button',{name:'适应画布',exact:true}).click();
    expect(await noHorizontalScroll(page)).toBe(true);
  }
  await page.getByRole('checkbox',{name:'显示已结束任务',exact:true}).check();
  await expect(page.getByRole('checkbox',{name:'显示已结束任务',exact:true})).toBeChecked();
  await shot(page,'关系图-原视图与窄屏边界',false);
});
