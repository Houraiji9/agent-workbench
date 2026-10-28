import {test,expect} from '@playwright/test';
import {makeTask,drawer,shot} from './support.ts';

test('调整此审查者只改模型即可保存，模型清空显式发送null',async({page})=>{
 const m=await makeTask(page,{title:'合成审查模型保存复现',stage:'submitted'});
 await m.post('/review-orders',{run_id:m.rid,expected_revision:(await m.get('/tasks/'+m.tid)).task.revision,reviewer_id:'grok-build',requested_model:'grok-4.7-build',reason:'合成测试初始审查安排'});
 const posted:any[]=[];page.on('request',r=>{if(r.url().endsWith('/tasks/'+m.tid+'/reviews/manage')&&r.method()==='POST')posted.push(r.postDataJSON());});
 await page.goto('/#/today?task='+m.tid);const panel=drawer(page).getByRole('region',{name:'独立审查协作'});
 await panel.locator('article').filter({hasText:'计划模型：grok-4.7-build'}).getByRole('button',{name:'调整此审查者',exact:true}).click();
 await panel.getByLabel('审查模型',{exact:true}).fill('grok-4.7-build-fast');
 await shot(page,'审查成员-仅改模型的保存按钮',false);
 await expect(panel.getByRole('button',{name:'保存安排',exact:true})).toBeEnabled();
 await panel.getByRole('button',{name:'保存安排',exact:true}).click();
 await expect(panel.locator('article').filter({hasText:'计划模型：grok-4.7-build-fast'})).toHaveCount(1);
 expect(posted[0]).toMatchObject({action:'replace',requested_model:'grok-4.7-build-fast',reason:'用户在任务页调整此审查者与模型'});
 await panel.locator('article').filter({hasText:'计划模型：grok-4.7-build-fast'}).getByRole('button',{name:'调整此审查者',exact:true}).click();
 await panel.getByLabel('审查模型',{exact:true}).fill('');await panel.getByRole('button',{name:'保存安排',exact:true}).click();
 await expect(panel.locator('article').filter({hasText:'计划模型：未指定'})).toHaveCount(1);expect(posted[1].requested_model).toBeNull();
 const d=await m.get('/tasks/'+m.tid),active=d.review_summary.members.filter((a:any)=>!['cancelled','superseded','revoked'].includes(a.status));expect(active).toHaveLength(1);expect(active[0].requested_model).toBeNull();expect(d.task.current_run_id).toBe(m.rid);await shot(page,'审查成员-无理由保存及清空模型',false);
});

test('保存审查成员显示接口具体错误并保留用户输入供重试',async({page})=>{
 const m=await makeTask(page,{title:'合成审查保存错误',stage:'submitted'});
 await m.post('/review-orders',{run_id:m.rid,expected_revision:(await m.get('/tasks/'+m.tid)).task.revision,reviewer_id:'grok-build',requested_model:'grok-4.7-build',reason:'合成测试初始审查安排'});
 let calls=0;await page.route('**/api/tasks/'+m.tid+'/reviews/manage',async route=>{if(calls++===0)return route.fulfill({status:409,json:{error:'合成接口错误：审查成员版本已变化，请刷新后重试'}});return route.continue();});
 await page.goto('/#/today?task='+m.tid);const panel=drawer(page).getByRole('region',{name:'独立审查协作'});
 await panel.locator('article').getByRole('button',{name:'调整此审查者',exact:true}).click();await panel.getByLabel('审查模型',{exact:true}).fill('grok-4.7-build-fast');await panel.getByRole('button',{name:'保存安排',exact:true}).click();
 await expect(panel.getByRole('alert')).toContainText('合成接口错误：审查成员版本已变化，请刷新后重试');await expect(panel.getByLabel('审查模型',{exact:true})).toHaveValue('grok-4.7-build-fast');await shot(page,'审查成员-保存具体错误',false);
 await panel.getByRole('button',{name:'保存安排',exact:true}).click();await expect(panel.locator('article').filter({hasText:'计划模型：grok-4.7-build-fast'})).toHaveCount(1);expect(calls).toBe(2);
});
