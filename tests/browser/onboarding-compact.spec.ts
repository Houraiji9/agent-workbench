import { test, expect } from '@playwright/test';

const evidence = 'G:/项目/工作台/工程/docs/handoff/planning-Qcc765a6c/ui';
const models = Array.from({length:1000}, (_, i) => ({id:`native-${String(i).padStart(4,'0')}`,name:`合成型号 ${i}`,status:'configured',source:'team_registration',provider:'fixture'}));
const snapshot = {
  prompt: '合成提示词，仅复制，不执行。',
  mcp: {status:'current',connection_status:'not_verified'},
  team: {checked_at:'2026-10-29T00:00:00Z',agents:[{id:'first',name:'第一位合成 Agent',status:'recorded',registered_models:models,models:models.map(m => ({...m,source:'client_models',status:'advertised',evidence_state:'stale'}))},{id:'second',name:'第二位合成 Agent',status:'not_observed',registered_models:[{...models[0],id:'second-native',name:'另一团队型号'}],models:[]}]},
  diagnostics:Array.from({length:1000},(_,i) => ({id:`diag-${i}`,agent_name:`合成入口 ${i}`,model:`diagnostic-native-${i}`,status:i===999?'success':'unknown',checked_at:`2026-10-${i===999?'29':'28'}T00:00:00Z`,reason:`合成原因 ${i}`})),
};

test('默认卡片高度不随一千条型号和诊断增长', async ({page}) => {
  let large=false;
  await page.route('**/api/agent-clients',route=>route.fulfill({json:{clients:[]}}));
  await page.route('**/api/onboarding',route=>route.fulfill({json:large?snapshot:{...snapshot,team:{...snapshot.team,agents:snapshot.team.agents.map(agent=>({...agent,registered_models:agent.registered_models.slice(0,1),models:agent.models.slice(0,1)}))},diagnostics:[snapshot.diagnostics[999]]}}));
  await page.goto('/#/settings');
  const card=page.getByRole('region',{name:'首次配置工作台',exact:true});
  await expect(card).toContainText('2 个团队登记型号');
  const compactHeight=(await card.boundingBox())!.height;
  large=true;
  await card.getByRole('button',{name:'刷新记录',exact:true}).click();
  await expect(card).toContainText('1001 个团队登记型号');
  expect((await card.boundingBox())!.height).toBeLessThanOrEqual(compactHeight+1);
});

test('千条型号与诊断默认收起，搜索分页、Agent切换和窄屏键盘操作有界且只读', async ({page}) => {
  let onboardingRequests=0;
  const mutations:string[]=[];
  const discoveries:string[]=[];
  await page.route('**/api/onboarding',route=>{onboardingRequests++;return route.fulfill({json:snapshot});});
  await page.route('**/api/agent-clients',route=>route.fulfill({json:{clients:[]}}));
  page.on('request',request=>{if(request.method()!=='GET')mutations.push(request.url());if(/discover|probe|invoke|refresh-models/.test(request.url()))discoveries.push(request.url());});
  await page.goto('/#/settings');
  const card=page.getByRole('region',{name:'首次配置工作台',exact:true});
  await expect(card).toContainText('1001 个团队登记型号');
  await expect(card).toContainText('合成入口 999');
  await expect(card.getByText('合成型号 0',{exact:true})).toHaveCount(0);
  await expect(card.getByRole('combobox',{name:'选择 Agent',exact:true})).toHaveCount(0);
  await expect(card.getByRole('textbox',{name:'首次配置提示词',exact:true})).not.toBeVisible();
  const height=(await card.boundingBox())!.height;
  expect(height).toBeLessThan(700);
  await page.screenshot({path:`${evidence}/onboarding-1000-collapsed-light.png`,fullPage:true,animations:'disabled'});
  await card.getByText('查看团队型号与参考目录',{exact:true}).click();
  const team=card.locator('.onboarding-detail').first();
  await expect(team.locator('.onboarding-records').first().locator('li')).toHaveCount(10);
  expect((await team.boundingBox())!.height).toBeLessThanOrEqual(481);
  await team.getByRole('button',{name:'下一页',exact:true}).first().click();
  await expect(team.getByText('native-0010',{exact:true})).toBeVisible();
  const search=team.getByRole('searchbox',{name:'团队登记型号搜索',exact:true});
  await search.fill('native-0999');
  await expect(team.locator('.onboarding-records').first().locator('li')).toHaveCount(1);
  await expect(team.getByText('native-0999',{exact:true})).toBeVisible();
  await team.getByText('客户端参考记录（1000）',{exact:true}).click();
  await team.getByRole('searchbox',{name:'客户端参考型号搜索',exact:true}).fill('native-0500');
  await expect(team).toContainText('来源：客户端枚举');
  await expect(team).toContainText('记录已过期');
  await expect(team).toContainText('客户端提供，未试调用');
  await card.getByRole('combobox',{name:'选择 Agent',exact:true}).selectOption('second');
  await expect(team.getByText('second-native',{exact:true})).toBeVisible();
  await expect(team.getByText('native-0999',{exact:true})).toHaveCount(0);
  await card.getByText('诊断历史（1000）',{exact:true}).click();
  const history=card.locator('.onboarding-detail').last();
  await expect(history.locator('li')).toHaveCount(10);
  await history.getByRole('searchbox',{name:'搜索诊断历史',exact:true}).fill('diagnostic-native-999');
  await expect(history.locator('li')).toHaveCount(1);
  await expect(history).toContainText('调用成功');
  await history.getByRole('searchbox').fill('没有这样的记录');
  await expect(history).toContainText('没有匹配记录');
  await history.getByRole('searchbox').fill('');
  await page.setViewportSize({width:390,height:844});
  await expect.poll(()=>page.evaluate(()=>document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  await card.getByRole('combobox',{name:'选择 Agent',exact:true}).selectOption('first');
  await search.fill('native-0999');
  await search.focus();
  await page.keyboard.press('Tab');
  const focused=await page.evaluate(()=>{const r=document.activeElement!.getBoundingClientRect();return {top:r.top,bottom:r.bottom};});
  expect(focused.top).toBeGreaterThanOrEqual(0);
  expect(focused.bottom).toBeLessThanOrEqual(844);
  await page.screenshot({path:`${evidence}/onboarding-1000-expanded-narrow.png`,fullPage:true,animations:'disabled'});
  await card.getByText('查看团队型号与参考目录',{exact:true}).click();
  await card.getByText('诊断历史（1000）',{exact:true}).click();
  await page.getByRole('radio',{name:'深色',exact:true}).click();
  await page.screenshot({path:`${evidence}/onboarding-1000-collapsed-dark-narrow.png`,fullPage:true,animations:'disabled'});
  expect(onboardingRequests).toBe(1);
  expect(mutations).toEqual([]);
  expect(discoveries).toEqual([]);
});
