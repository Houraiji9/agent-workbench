import {test,expect} from '@playwright/test';
import {makeTask,drawer,noHorizontalScroll} from './support.js';

test('更换审查者、复制完整审查单、导入报告并一键返回执行者',async({page})=>{
  const m=await makeTask(page,{title:'测试：通用独立审查闭环',stage:'submitted'});await page.goto('/#/today?task='+m.tid);
  await drawer(page).getByRole('button',{name:'更换审查者',exact:true}).click();const d=page.getByRole('dialog',{name:'安排独立审查',exact:true});
  await d.getByRole('combobox',{name:'审查者',exact:true}).selectOption('claude');await d.getByLabel('安排说明（可选）').fill('Grok 额度不足，交给 Claude 审查');
  await d.getByRole('button',{name:'生成并复制审查单',exact:true}).click();const ready=page.getByRole('dialog',{name:'审查单已准备好',exact:true});await expect(ready).toBeVisible();
  await expect.poll(()=>page.evaluate(()=>navigator.clipboard.readText())).toContain(m.rid);
  const copied=await page.evaluate(()=>navigator.clipboard.readText());expect(copied).toContain('REVIEW.md');expect(copied).toContain('Claude');expect(copied).toContain(m.rid);
  await ready.locator('footer').getByRole('button',{name:'关闭',exact:true}).click();let detail=await m.get('/tasks/'+m.tid);expect(detail.task.status).toBe('submitted');expect(detail.task.reviewer_id).toBe('claude');
  const a=detail.review_assignments[0];expect(a.status).toBe('awaiting_dispatch');
  await drawer(page).getByRole('button',{name:'导入审查回执',exact:true}).click();const receipt=page.getByRole('dialog',{name:'导入审查回执',exact:true});
  await receipt.getByLabel('粘贴审查者返回的完整回执').fill(JSON.stringify({review_id:a.id,task_id:m.tid,run_id:m.rid,review_digest:a.review_digest,verdict:'changes_requested',findings:['窄窗口按钮需对齐'],limitations:['仅隔离测试，非真实模型审查'],evidence:['阅读了隔离测试材料'],report_markdown:'# 模拟审查报告\n\n发现窄窗口下按钮未对齐，建议调整排列。此报告仅用于验证流程。'}));
  await receipt.getByRole('button',{name:'导入并附上报告'}).click();await expect(drawer(page).getByRole('button',{name:'复制修改意见给执行者'})).toBeVisible();
  await drawer(page).getByText('查看完整审查报告',{exact:true}).click();await expect(drawer(page).getByRole('link',{name:'下载报告',exact:true})).toBeVisible();
  expect(await noHorizontalScroll(page)).toBe(true);await page.setViewportSize({width:1000,height:780});expect(await noHorizontalScroll(page)).toBe(true);
  await drawer(page).getByRole('button',{name:'复制修改意见给执行者'}).click();await expect.poll(async()=>(await m.get('/tasks/'+m.tid)).task.current_run_id).not.toBe(m.rid);detail=await m.get('/tasks/'+m.tid);
  await expect.poll(()=>page.evaluate(()=>navigator.clipboard.readText())).toContain(detail.task.current_run_id);
  const feedback=await page.evaluate(()=>navigator.clipboard.readText());expect(feedback).toContain('窄窗口按钮需对齐');expect(feedback).toContain(detail.task.current_run_id);expect(detail.runs.find((r:any)=>r.id===detail.task.current_run_id).agent_id).toBe('codex');
});
