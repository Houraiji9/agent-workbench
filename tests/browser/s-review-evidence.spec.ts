import {test,expect} from '@playwright/test';
import {makeTask,drawer,shot} from './support.ts';

test('审查误贴不保存，弹窗明确当前任务；撤回保留痕迹并恢复待审',async({page})=>{
 const m=await makeTask(page,{title:'测试：审查归属与纠正',stage:'submitted'});
 await page.goto('/#/today?task='+m.tid);
 await drawer(page).getByRole('button',{name:'登记审查结果',exact:true}).click();
 const d=page.getByRole('dialog',{name:'登记审查结果',exact:true});
 await expect(d).toContainText(m.title);await d.locator('label').filter({hasText:/^通过$/}).click();
 await d.getByLabel('审查依据').fill('审查报告：T-2b9482af-... / R-78eeeefc-...，这是另一任务的审查');
 await d.getByLabel('我确认独立审查者已审查这项任务的当前成果').check();
 await d.getByRole('button',{name:'登记结果'}).click();await expect(d.getByRole('alert')).toContainText('其他任务');
 expect((await m.get('/tasks/'+m.tid)).task.status).toBe('submitted');
 await d.getByLabel('审查依据').fill(`仅测试夹具，当前任务 ${m.tid} / ${m.rid} 的审查，不是真实 Grok 结果`);
 await d.getByRole('button',{name:'登记结果'}).click();await expect(d).toHaveCount(0);
 await drawer(page).getByRole('button',{name:'撤回误登记'}).click();
 const revoke=page.getByRole('dialog',{name:'撤回误登记的审查',exact:true});
 await revoke.getByLabel('撤回原因').fill('测试：这条记录误登记，保留历史以便核对');
 await revoke.getByRole('button',{name:'撤回这条审查'}).click();await expect(revoke).toHaveCount(0);
 await expect(drawer(page)).toContainText('已撤回');await expect(drawer(page).getByRole('button',{name:'试用后确认完成'})).toHaveCount(0);
 const detail=await m.get('/tasks/'+m.tid);expect(detail.task.status).toBe('submitted');expect(detail.reviews).toHaveLength(1);expect(detail.reviews[0].revoked_at).toBeTruthy();
 await shot(page,'审查撤回保留历史');
});

test('Grok 回传入口只要求会话编号，复制审查单携带当前绑定',async({page})=>{
 const m=await makeTask(page,{title:'测试：Grok 回传入口',stage:'submitted'});await page.goto('/#/today?task='+m.tid);
 await drawer(page).getByRole('button',{name:'复制审查单',exact:true}).click();
 await expect.poll(()=>page.evaluate(()=>navigator.clipboard.readText())).toContain(m.tid);
 const copied=await page.evaluate(()=>navigator.clipboard.readText());expect(copied).toContain(m.tid);expect(copied).toContain('REVIEW.md');
 await drawer(page).getByRole('button',{name:'读取 Grok 审查',exact:true}).click();const d=page.getByRole('dialog',{name:'读取 Grok 审查',exact:true});
 await expect(d).toContainText(m.title);await expect(d.getByLabel('Grok 会话编号')).toBeVisible();expect(await d.getByRole('radio').count()).toBe(0);
 await d.getByLabel('Grok 会话编号').fill('不是会话编号');await d.getByRole('button',{name:'读取并登记'}).click();await expect(d.getByRole('alert')).toBeVisible();
 expect((await m.get('/tasks/'+m.tid)).reviews).toHaveLength(0);
});
