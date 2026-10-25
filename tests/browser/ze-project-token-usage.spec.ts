import {test,expect} from '@playwright/test';
import {makeTask,shot,noHorizontalScroll} from './support.ts';
import {normalizeTokenMonitorDetails,projectTokenMonitorUsage} from '../../src/core/token-monitor-usage.ts';
import {aggregateProjectUsage,withLegacyJobUsage} from '../../src/core/project-usage.ts';
test.use({timezoneId:'Asia/Shanghai'});
test('Token Monitor会话统计显示独立范围、缓存和未知历史，不与调用小计相加',async({page})=>{
  const m=await makeTask(page,{title:'合成用量展示测试'});
  const token=projectTokenMonitorUsage({status:'connected',snapshot:{usage_details:normalizeTokenMonitorDetails({updatedAt:'2026-10-25T12:00:00Z',periods:{today:{sessions:{s:{client:'codex',sessionId:'synthetic-session',totalTokens:110,inputTokens:5,outputTokens:5,cacheReadTokens:100,cacheWriteTokens:0,models:{'synthetic-model':110},costUsd:0.01}}},month:{sessions:{s:{client:'codex',sessionId:'synthetic-session',totalTokens:220,inputTokens:10,outputTokens:10,cacheReadTokens:200,cacheWriteTokens:0,models:{'synthetic-model':220},costUsd:0.02}}},allTime:{sessions:{}}}})}},m.project.id,{sessions:[{agent:'codex',native_id:'synthetic-session',project_id:m.project.id}],jobs:[],projects:[],agents:[]});
  token.periods.month.windows=[{device_id:'synthetic-device',key:'month',ends_at:'2026-10-26T07:00:00Z',time_zone:'America/Los_Angeles',stale:false},{device_id:'synthetic-device',key:'unknown-zone',ends_at:'2026-10-26T07:00:00Z',time_zone:'Invalid/Zone',stale:false}];
  const legacyJobs=[{id:'synthetic-legacy',project_id:m.project.id,task_id:m.tid,run_id:'synthetic-run',status:'completed',started_at:'2026-10-25T11:00:00Z',ended_at:'2026-10-25T12:00:00Z',usage:{scope:'reported_total',totalTokens:70}}];
  const legacy=aggregateProjectUsage(withLegacyJobUsage([],legacyJobs),legacyJobs);
  await page.route('**/api/projects/'+m.project.id+'/insights*',async route=>{const response=await route.fetch(),json=await response.json();await route.fulfill({response,json:{...json,usage:legacy,token_monitor:token}});});
  await page.goto('/#/projects/'+m.project.id+'?tab=insights');await expect(page.getByRole('heading',{name:'Token Monitor · 项目会话用量'})).toBeVisible();const panel=page.locator('section').filter({has:page.getByRole('heading',{name:'Token Monitor · 项目会话用量'})});
  await expect(panel.getByText('220',{exact:true})).toBeVisible();await expect(panel.getByText('200 / 0',{exact:true})).toBeVisible();await expect(panel.getByText('仅估价，不是实际扣款')).toBeVisible();
  await page.getByLabel('Token Monitor 会话统计范围').selectOption('today');await expect(panel.getByText('110',{exact:true})).toBeVisible();await page.getByLabel('Token Monitor 会话统计范围').selectOption('allTime');await expect(panel.getByText('此统计范围没有可确认的项目会话用量')).toBeVisible();await expect(panel.getByText('来源未提供此时间范围的会话明细；不能将它解释为用量为零。')).toBeVisible();
  await page.getByLabel('Token Monitor 会话统计范围').selectOption('month');await expect(panel.getByText('220',{exact:true})).toBeVisible();await panel.getByText('来源统计窗口（2 项）').click();await expect(panel.getByText('结束时间：2026年10月26日 00:00 · 来源时区：America/Los_Angeles')).toBeVisible();await expect(panel.getByText(/2026-10-26T07:00:00.000Z（UTC；来源时区无效）/)).toBeVisible();
  await page.getByText('逐项追溯调用（1 项）').click();await page.getByText('调用 synthetic-legacy · 总量未知或不完整',{exact:true}).click();await expect(page.getByText('历史调用摘要：计入已知小计，覆盖完整度未知',{exact:true})).toBeVisible();expect(await noHorizontalScroll(page)).toBe(true);await shot(page,'合成-项目会话与缓存用量',false);
});
