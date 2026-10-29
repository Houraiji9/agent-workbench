import {test,expect} from '@playwright/test';
import path from 'node:path';
import {makeTask,drawer} from './support.js';
async function report(m:any,order:any,verdict='passed'){const d=await m.get('/tasks/'+m.tid),a=d.review_assignments.find((r:any)=>r.id===order.review_id);await m.post('/review-receipts',{review_id:a.id,task_id:m.tid,run_id:m.rid,review_digest:a.review_digest,verdict,findings:verdict==='passed'?[]:['隔离发现：需负责人判断'],limitations:['合成浏览器回归'],evidence:['读取测试材料'],report_markdown:'# 合成报告\n\n仅用于文案回归，不是真实模型审查。'});}
async function order(m:any,reviewer_id:string){const d=await m.get('/tasks/'+m.tid);return m.post('/review-orders',{run_id:m.rid,reviewer_id,expected_revision:d.task.revision,delivery_mode:'manual',reason:'隔离测试：核对已安排与已回报文案'});}
async function capture(locator:any,name:string){if(process.env.WORKBENCH_EVIDENCE_DIR)await locator.screenshot({animations:'disabled',path:path.join(process.env.WORKBENCH_EVIDENCE_DIR,name+'.png')});}
test('待接单安排与部分回报主卡不会再说尚未安排',async({page})=>{
 const m=await makeTask(page,{title:'测试：已安排和部分回报文案',stage:'submitted'});await page.goto('/#/today?task='+m.tid);let now=drawer(page).getByRole('region',{name:'现在要做什么'});await expect(now.getByText(/尚未安排独立审查/).first()).toBeVisible();
 const a=await order(m,'claude');await order(m,'zcode');await page.reload();now=drawer(page).getByRole('region',{name:'现在要做什么'});await expect(now.getByText('审查已安排 · 已回报 0/2',{exact:true})).toBeVisible();await expect(now.getByText(/等待规划者安排/)).toHaveCount(0);await capture(now,'arranged-awaiting-start');
 await report(m,a);await page.reload();now=drawer(page).getByRole('region',{name:'现在要做什么'});await expect(now.getByText('审查已安排 · 已回报 1/2',{exact:true})).toBeVisible();await expect(now.getByText(/尚未安排|等待规划者安排/)).toHaveCount(0);await capture(now,'partial-reported-awaiting-start');
});
for(const mode of ['zero','disagreement','single-passed'])test('收尾语义 '+mode,async({page})=>{
 const m=await makeTask(page,{title:'测试：收尾授权来源 '+mode,stage:'submitted'});
 if(mode==='single-passed'){const a=await order(m,'claude');await report(m,a);}
 else {if(mode==='disagreement'){const a=await order(m,'claude'),b=await order(m,'zcode');await report(m,a);await report(m,b,'changes_requested');}else await order(m,'claude');const d=await m.get('/tasks/'+m.tid);await m.post('/tasks/'+m.tid+'/reviews/manage',{action:'decide',run_id:m.rid,expected_revision:d.task.revision,decision:'continue',reason:'隔离测试：负责人选择继续并保留已有意见'});}
 await page.goto('/#/today?task='+m.tid);const now=drawer(page).getByRole('region',{name:'现在要做什么'});await expect(now.getByText(mode==='single-passed'?'审查已通过，等待执行者收尾':'负责人决定继续，等待执行者收尾',{exact:true})).toBeVisible();if(mode!=='single-passed')await expect(now.getByText(/审查已通过|收到审查结果/)).toHaveCount(0);await capture(now,'closeout-'+mode);await drawer(page).getByRole('button',{name:'关闭任务',exact:true}).click();if(mode!=='single-passed')await expect(page.getByText(/审查已通过|收到审查结果/)).toHaveCount(0);
});

// 模拟旧版本保留的待决投影；回报和交回动作仍经过隔离业务接口。
test('旧多人通过卡有明确交回入口，保留追加审查并停在执行收尾',async({page})=>{
 const m=await makeTask(page,{title:'测试：旧多人审查待决交回',stage:'submitted'});
 const a=await order(m,'claude'),b=await order(m,'zcode');await report(m,a);await report(m,b);
 let legacy=true;
 await page.route('**/api/tasks/'+m.tid,async route=>{const response=await route.fetch();const body=await response.json();if(legacy){body.task.status='submitted';body.task.review_stage='awaiting_decision';}await route.fulfill({response,json:body});});
 await page.goto('/#/today?task='+m.tid);
 const collaboration=drawer(page).getByRole('region',{name:'独立审查协作'});
 await expect(collaboration.getByRole('button',{name:'添加审查者',exact:true})).toBeVisible();
 await expect(collaboration.getByText('回报：通过',{exact:true})).toHaveCount(2);
 await capture(collaboration,'legacy-multi-passed-handoff');
 legacy=false;
 await collaboration.getByRole('button',{name:'交回执行者收尾',exact:true}).click();
 await expect.poll(async()=>(await m.get('/tasks/'+m.tid)).task.status).toBe('awaiting_closeout');
 const detail=await m.get('/tasks/'+m.tid);expect(detail.review_summary.decision.decision).toBe('continue');expect(detail.review_summary.members.filter((x:any)=>x.report)).toHaveLength(2);
 await expect(drawer(page).getByRole('button',{name:'复制收尾单给执行者',exact:true})).toBeVisible();
 expect(detail.task.status).not.toBe('awaiting_confirmation');expect(detail.task.status).not.toBe('accepted');
});

test('多人分歧交回需明确依据且可继续添加审查者',async({page})=>{
 const m=await makeTask(page,{title:'测试：分歧明确决定',stage:'submitted'});
 const a=await order(m,'claude'),b=await order(m,'zcode');await report(m,a);await report(m,b,'changes_requested');
 await page.goto('/#/today?task='+m.tid);
 const collaboration=drawer(page).getByRole('region',{name:'独立审查协作'});
 await expect(collaboration.getByRole('button',{name:'添加审查者',exact:true})).toBeVisible();
 await collaboration.getByRole('button',{name:'交回执行者收尾',exact:true}).click();
 const confirm=collaboration.getByRole('button',{name:'确认交回执行者收尾',exact:true});await expect(confirm).toBeDisabled();
 await collaboration.getByRole('textbox',{name:'调整原因或决定依据'}).fill('负责人明确保留分歧并交执行者处理剩余事项');
 await expect(confirm).toBeEnabled();await capture(collaboration,'disagreement-decision-form');await confirm.click();
 await expect.poll(async()=>(await m.get('/tasks/'+m.tid)).task.status).toBe('awaiting_closeout');
 const d=await m.get('/tasks/'+m.tid);expect(d.review_summary.disagreement).toBe(true);expect(d.review_summary.members.filter((x:any)=>x.report)).toHaveLength(2);
});

test('两份通过后仍可从界面追加第三位审查者，已有报告保留',async({page})=>{
 const m=await makeTask(page,{title:'测试：双通过追加第三位',stage:'submitted'});
 const a=await order(m,'claude'),b=await order(m,'zcode');await report(m,a);await report(m,b);
 await page.goto('/#/today?task='+m.tid);const collaboration=drawer(page).getByRole('region',{name:'独立审查协作'});
 await collaboration.getByRole('button',{name:'添加审查者',exact:true}).click();
 await collaboration.getByRole('combobox',{name:'审查者',exact:true}).selectOption('grok-build');
 await collaboration.getByRole('button',{name:'保存安排',exact:true}).click();
 await expect.poll(async()=>(await m.get('/tasks/'+m.tid)).review_summary.counts.active).toBe(3);
 const d=await m.get('/tasks/'+m.tid);expect(d.task.status).toBe('submitted');expect(d.review_summary.members.filter((x:any)=>x.report)).toHaveLength(2);
 await expect(collaboration.getByRole('article',{name:'Grok Build 审查'})).toBeVisible();await capture(collaboration,'third-reviewer-added');
});
