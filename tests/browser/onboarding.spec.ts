import { test, expect } from '@playwright/test';
const prompt = '合成首次配置提示词：只注册工作台 MCP，保留其他连接；Claude 跳过。';
const snapshot = {
  prompt,
  mcp: { status: 'current', connection_status: 'not_verified', config_path: 'G:/合成目录/config.toml', detail: '需要重连或开启新会话验证。' },
  team: { agents: [{ id: 'grok', name: 'Grok 合成记录', status: 'advertised', models: [{ id: 'Exact-Model.ID-fast', name: '模型展示名', status: 'configured', provider: 'fixture' }] }, { id: 'claude', name: 'Claude', status: 'skipped', models: [] }] },
  diagnostics: [{ id: 'test-failure', agent_name: 'Grok 合成记录', model: 'Exact-Model.ID-fast', status: 'failed', checked_at: '2026-10-29T00:00:00Z', reason: '合成诊断：需要登录' }],
};

test('首次配置仅复制与预览，配置完成和新会话连通分别显示', async ({ page }) => {
  let requests = 0;
  let posts = 0;
  await page.route('**/api/onboarding', route => { requests++; return route.fulfill({ json: snapshot }); });
  await page.route('**/api/agent-clients', route => route.fulfill({ json: { clients: [{ kind: 'claude', label: 'Claude Code', status: 'skipped', reason: '按用户要求跳过' }] } }));
  page.on('request', request => { if (request.method() === 'POST') posts++; });
  await page.goto('/#/settings');
  const card = page.getByRole('region', { name: '首次配置工作台', exact: true });
  await expect(card).toContainText('已配置');
  await expect(card).toContainText('新会话连通');
  await expect(card).toContainText('尚未验证');
  await expect(card).not.toContainText('已验证连通');
  await expect(card).toContainText('Claude / Claude Code：按用户要求跳过');
  await expect(card).toContainText('Exact-Model.ID-fast');
  await expect(card).toContainText('调用失败');
  await card.getByText('预览首次配置提示词', { exact: true }).click();
  await expect(card.getByRole('textbox', { name: '首次配置提示词', exact: true })).toHaveValue(prompt);
  await card.getByRole('button', { name: '复制首次配置提示词', exact: true }).click();
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(prompt);
  expect(requests).toBe(1);
  expect(posts).toBe(0);
  const clients = page.getByRole('region', { name: 'Agent 客户端', exact: true });
  await expect(clients).toContainText('按要求跳过');
  await expect(clients.getByText('高级修复', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('region', { name: '让规划 Agent 接入工作台' })).toHaveCount(0);
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ animations: 'disabled', path: 'G:/项目/工作台/工程/docs/handoff/planning-Qcc765a6c/ui/onboarding-light.png', fullPage: true });
  await page.getByRole('radio', { name: '深色', exact: true }).click();
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ animations: 'disabled', path: 'G:/项目/工作台/工程/docs/handoff/planning-Qcc765a6c/ui/onboarding-dark.png', fullPage: true });
  await page.setViewportSize({ width: 780, height: 1100 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
});

test('首次配置读取失败能重试，真实连通状态与成功及未知诊断独立呈现', async ({ page }) => {
  let requests = 0;
  await page.route('**/api/agent-clients', route => route.fulfill({ json: { clients: [{ kind: 'claude', label: 'Claude Code', status: 'skipped', reason: '按用户要求跳过' }] } }));
  await page.route('**/api/onboarding', route => {
    requests++;
    return route.fulfill(requests === 1 ? { status: 503, json: { error: '合成读取失败' } } : { json: { ...snapshot, mcp: { status: 'current', connection_status: 'connected', connected_at: '2026-10-29T00:00:00Z' }, diagnostics: [{ id: 'ok', agent_name: '成功入口', model: 'native-id', status: 'success' }, { id: 'unknown', agent_name: '未知入口', model: 'native-unknown', status: 'unknown' }] } });
  });
  await page.goto('/#/settings');
  const card = page.getByRole('region', { name: '首次配置工作台', exact: true });
  await expect(card.getByRole('alert')).toContainText('合成读取失败');
  await expect(card.getByRole('button', { name: '复制首次配置提示词', exact: true })).toBeDisabled();
  await card.getByRole('button', { name: '刷新记录', exact: true }).click();
  await expect(card).toContainText('已验证连通');
  await expect(card).toContainText('调用成功');
  await card.getByText('诊断历史（2）', {exact:true}).click();
  await expect(card).toContainText('未知入口');
  await expect(card.getByRole('alert')).toHaveCount(0);
});

// Real isolated API + team editor: hand registration, not the static catalogue, supplies all four model pickers.
test('团队手工登记Cursor原生型号进入需求和任务执行审查选项，枚举参考独立展示', async ({page}) => {
  const {api: browserApi, makeTask, drawer}=await import('./support.ts');
  const a=await browserApi(page);
  const agent=await a.post('/agents',{version:0,preset_id:'cursor',name:'测试 Cursor 常用型号',scope:'合成测试专用团队登记',restriction:'不做真实调用',model:null,icon_key:'cursor',allowed_kinds:['engineering','review'],models:[]});
  await page.goto('/#/team/'+agent.id);
  await page.getByRole('button',{name:'编辑模型',exact:true}).click();
  const editor=page.getByRole('dialog',{name:'编辑 测试 Cursor 常用型号',exact:true});
  await editor.getByRole('button',{name:'添加模型',exact:true}).click();
  await editor.getByLabel('模型名称',{exact:true}).fill('常用 Grok 展示名');
  await editor.getByLabel('型号（选填）',{exact:true}).fill('grok-4.7-xhigh-fast');
  await editor.getByLabel('建议用途',{exact:true}).fill('用户选择的常用型号，调用可用性仍未知');
  await editor.getByRole('button',{name:'保存',exact:true}).click();
  await expect(editor).toHaveCount(0);
  const state=await a.get('/state');
  expect(state.model_catalog.find((g:any)=>g.agent_id===agent.id).models).toMatchObject([{id:'grok-4.7-xhigh-fast',name:'常用 Grok 展示名'}]);
  await page.getByRole('banner').getByRole('button',{name:'提需求',exact:true}).click();
  const request=page.getByRole('dialog',{name:'提一个需求',exact:true});
  const assertOption=async(input:import('@playwright/test').Locator)=>{
    const list=await input.getAttribute('list');expect(list).toBeTruthy();
    await expect(page.locator('datalist').filter({has:page.locator('option[value="grok-4.7-xhigh-fast"]')}).locator('option[value="grok-4.7-xhigh-fast"]').first()).toHaveCount(1);
    expect(await input.evaluate((el:any)=>Array.from((el.list?.options||[]) as HTMLOptionElement[]).map((o:any)=>o.value))).toContain('grok-4.7-xhigh-fast');
  };
  await request.getByLabel('执行者（可选）',{exact:true}).selectOption(agent.id);
  await assertOption(request.getByLabel('执行模型（可选）',{exact:true}));
  await request.getByLabel('执行模型（可选）',{exact:true}).fill('grok-4.7-xhigh-fast');
  // Each role is checked separately because self-review is deliberately not offered.
  await request.getByLabel('执行者（可选）',{exact:true}).selectOption('codex');
  await request.getByLabel('审查者（可选）',{exact:true}).selectOption(agent.id);
  await assertOption(request.getByLabel('审查模型（可选）',{exact:true}));
  await request.getByLabel('审查模型（可选）',{exact:true}).fill('grok-4.7-xhigh-fast');
  await request.getByLabel('你想完成什么？').fill('合成Cursor团队型号需求');
  await request.getByRole('button',{name:'先记下来',exact:true}).click();await expect(request).toHaveCount(0);
  expect((await a.get('/state')).requests.find((q:any)=>q.text==='合成Cursor团队型号需求').agent_selection.review.model).toBe('grok-4.7-xhigh-fast');
  const task=await makeTask(page,{title:'合成Cursor团队型号任务'});
  await page.goto('/#/today?task='+task.tid);const d=drawer(page);
  await d.getByRole('button',{name:'修改执行安排',exact:true}).click();
  await d.getByRole('combobox',{name:'执行负责人',exact:true}).selectOption(agent.id);
  await assertOption(d.getByRole('combobox',{name:'主模型建议（可留空）',exact:true}));
  await d.getByRole('combobox',{name:'主模型建议（可留空）',exact:true}).fill('grok-4.7-xhigh-fast');
  await d.getByRole('button',{name:'保存安排',exact:true}).click();
  await expect.poll(async()=>(await task.get('/tasks/'+task.tid)).task.requested_model).toBe('grok-4.7-xhigh-fast');
  // A Codex task can independently choose this Cursor member as reviewer.
  const reviewTask=await makeTask(page,{title:'合成Cursor团队型号审查'});await page.goto('/#/today?task='+reviewTask.tid);
  const panel=page.getByRole('region',{name:'审查安排',exact:true});await panel.getByRole('button',{name:'修改审查安排',exact:true}).click();
  const reviewEditor=panel.getByRole('region',{name:'修改审查安排',exact:true});
  await reviewEditor.getByLabel('审查者',{exact:true}).selectOption(agent.id);await assertOption(reviewEditor.getByLabel('审查模型（可选）',{exact:true}));
  await reviewEditor.getByLabel('审查模型（可选）',{exact:true}).fill('grok-4.7-xhigh-fast');await reviewEditor.getByRole('button',{name:'保存审查安排',exact:true}).click();
  await expect(reviewEditor).toHaveCount(0);expect((await reviewTask.get('/tasks/'+reviewTask.tid)).task.review_arrangement.requested_model).toBe('grok-4.7-xhigh-fast');
  await page.route('**/api/agent-clients',route=>route.fulfill({json:{clients:[]}}));
  await page.route('**/api/onboarding',route=>route.fulfill({json:{...snapshot,team:{agents:[{id:agent.id,name:'测试 Cursor 常用型号',status:'recorded',registered_models:[{id:'grok-4.7-xhigh-fast',name:'常用 Grok 展示名',status:'configured',source:'team_registration'}],models:[{id:'unusable-enumerated-id',name:'枚举参考型号',status:'advertised',source:'client_models',evidence_state:'stale'}]}]}}}));
  await page.goto('/#/settings');const onboarding=page.getByRole('region',{name:'首次配置工作台',exact:true});
  await onboarding.getByText('查看团队型号与参考目录',{exact:true}).click();
  await expect(onboarding.getByText('团队登记 · 任务型号选项',{exact:true})).toBeVisible();
  await expect(onboarding.getByText('原生 ID：',{exact:false}).filter({hasText:'grok-4.7-xhigh-fast'})).toBeVisible();
  await expect(onboarding.getByText('枚举参考型号',{exact:true})).not.toBeVisible();
  await onboarding.getByText('客户端参考记录（1）',{exact:true}).click();
  await expect(onboarding.getByText('枚举参考型号',{exact:true})).toBeVisible();await expect(onboarding).toContainText('来源：客户端枚举');await expect(onboarding).toContainText('记录已过期');
});
