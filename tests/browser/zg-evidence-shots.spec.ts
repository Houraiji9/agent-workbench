import {test,expect,type Page} from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {api,makeTask,shot} from './support.ts';
import {taskInput} from '../helpers.ts';

// 合成数据渲染证据：同一场景在改动前后各截一轮。数据全部写入隔离临时账本，标题带“合成”。
const PREFIX=process.env.SHOT_PREFIX||'after';
const WINDOWS=[{name:'常用1360',width:1360,height:900},{name:'最小880',width:880,height:600}];

async function seedScenario(page:Page){
  const a=await api(page);
  const stages=[
    ['合成待生成执行单：整理海外项目季度计划与前端展示效果的长标题用于检查换行','ready'],
    ['合成待交给执行者','order'],
    ['合成执行中任务','running'],
    ['合成待审查任务','submitted'],
    ['合成待试用确认','reviewed'],
    ['合成待收尾任务','closeout'],
  ] as const;
  const made=[];
  for(const [title,stage] of stages)made.push(await makeTask(page,{title,stage}));
  const asking=await makeTask(page,{title:'合成等待回答的任务',stage:'running'});await asking.report('waiting_input',{message:'合成问题：选择哪种外观？'});
  const blocked=await makeTask(page,{title:'合成遇到阻碍的任务',stage:'running'});await blocked.report('blocked',{message:'合成阻碍：缺少素材目录'});
  // 依赖：第二项等待第一项验收
  const folder=path.join(a.root,'合成依赖-'+randomUUID().slice(0,8));fs.mkdirSync(folder);
  const dep=await a.post('/projects',{name:'合成依赖项目',path:folder});
  const dq=await a.post('/requests',{project_id:dep.id,text:'合成需求：两步顺序任务'});
  await a.post('/plans',{schema_version:1,plan_id:'dep-'+randomUUID(),request_id:dq.id,expected_version:1,tasks:[{...taskInput(folder,'s1'),title:'合成前序任务'},{...taskInput(folder,'s2'),title:'合成后续任务（等待前序）',dependencies:['s1']}]});
  // 大量待安排任务
  const bigFolder=path.join(a.root,'合成大量-'+randomUUID().slice(0,8));fs.mkdirSync(bigFolder);
  const big=await a.post('/projects',{name:'合成大量任务项目',path:bigFolder});
  const bq=await a.post('/requests',{project_id:big.id,text:'合成需求：大量任务'});
  await a.post('/plans',{schema_version:1,plan_id:'big-'+randomUUID(),request_id:bq.id,expected_version:1,tasks:Array.from({length:30},(_,i)=>({...taskInput(bigFolder,'b'+i),title:'合成批量任务 '+i}))});
  // 需求：待开始、待规划（含长文与网址路径）
  const samplePath=path.join(a.root,'合成',...Array(4).fill('很长的目录名'));
  const long='合成长需求：'+'需要检查长中文、网址 https://example.com/very/long/path/'+'segment/'.repeat(8)+' 与路径 '+samplePath+'是否换行；';
  await a.post('/requests',{project_id:big.id,text:long.repeat(4),status:'draft'});
  const draft=await a.post('/requests',{project_id:dep.id,text:'合成草稿需求：先记下，以后再做',status:'draft'});
  const waiting=await a.post('/requests',{project_id:dep.id,text:'合成待规划需求：已开始，等 Codex 拆分'});
  await a.post('/requests/'+waiting.id+'/edit',{project_id:dep.id,text:waiting.text,status:'awaiting_planning',kind:'idea',version:waiting.version,workflow_kind:'standard',desired_output:'',success_criteria:'',review_mode:'required',review_focus:[],skip_review:false,review_note:''});
  void draft;
  // 收纳项目
  const shelf=await makeTask(page,{title:'合成收纳项目任务'});
  const sp=(await a.get('/state')).projects.find((p:any)=>p.id===shelf.project.id);
  await a.post('/projects/'+sp.id+'/hold',{version:sp.version,shelved:true});
  // 已结束：验收通过的任务（放进大量任务项目，使“已经结束”区块可见）；归档：独立项目
  const done=await makeTask(page,{title:'合成已验收任务',stage:'reviewed'});
  const doneTask=(await a.get('/tasks/'+done.tid)).task;
  await a.post('/tasks/'+done.tid+'/accept',{revision:doneTask.revision,mode:'user_experience',user_checks:[true,true]});
  const goneFolder=path.join(a.root,'合成归档-'+randomUUID().slice(0,8));fs.mkdirSync(goneFolder);
  const gone=await a.post('/projects',{name:'合成已归档项目',path:goneFolder,goal:'保存旧成果'});
  await a.post('/requests',{project_id:gone.id,text:'合成已归档项目的备忘',status:'draft',kind:'memo'});
  await a.post('/projects/'+gone.id+'/archive',{version:gone.version,archived:true});
  return {first:made[0],big,dep,done};
}

test('三页合成场景渲染证据',async({page})=>{
  test.setTimeout(240000);
  const s=await seedScenario(page);
  for(const w of WINDOWS){
    await page.setViewportSize({width:w.width,height:w.height});
    const name=(p:string)=>`${PREFIX}-${p}-${w.name}`;
    await page.goto('/#/today');await expect(page.locator('.hero h1')).toBeVisible();await shot(page,name('今天-首屏'),false);await shot(page,name('今天-整页'),true);
    for(const tab of ['drafts','waiting','planned']){await page.goto('/#/requests?tab='+tab);await expect(page.locator('h1')).toHaveText('需求箱');await shot(page,name('需求箱-'+tab),false);}
    await page.goto('/#/projects');await expect(page.locator('h1')).toHaveText('项目');await shot(page,name('项目列表'),false);
    await page.goto('/#/projects?tab=archived');await expect(page.locator('h1')).toHaveText('项目');await shot(page,name('项目-已归档列表'),false);
    await page.goto('/#/projects?tab=shelved');await expect(page.locator('h1')).toHaveText('项目');await shot(page,name('项目-收纳列表'),false);
    await page.goto('/#/projects/'+s.done.project.id);await expect(page.locator('.project-head h1')).toBeVisible();await shot(page,name('项目-已结束任务'),false);
    for(const tab of ['progress','files','insights','diagrams','memory','folders']){await page.goto('/#/projects/'+s.big.id+'?tab='+tab);await expect(page.locator('.project-head h1')).toBeVisible();await page.waitForTimeout(300);await shot(page,name('项目-'+tab),false);}
  }
});
