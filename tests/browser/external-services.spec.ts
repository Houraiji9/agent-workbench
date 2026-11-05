import { test, expect, type Page } from '@playwright/test';
import { noHorizontalScroll, shot } from './support.ts';

const presets = [
  { id: 'test-api', name: '测试 API 服务', vendor: '测试厂商', kind: 'api', protocol: 'openai-chat', baseUrl: 'https://api.example.com/v1', authFields: ['api_key'], capabilities: ['text', 'image'], operations: ['chat'], docsUrls: ['https://example.com/docs'], notes: ['隔离页面测试预设。'], availability: 'documented' },
  { id: 'test-cli', name: '测试 CLI 工具', vendor: '测试厂商', kind: 'cli', protocol: 'cli-json', authFields: [], capabilities: ['video'], operations: ['cli.invoke'], docsUrls: [], notes: [], availability: 'documented' },
  { id: 'test-design', name: '测试 Design MCP', vendor: '测试厂商', kind: 'agent_mcp', protocol: 'mcp', authFields: [], capabilities: ['image', 'canvas'], operations: ['mcp.call'], docsUrls: ['https://example.com/design'], notes: ['通过应用提供的外部 MCP 入口连接。'], availability: 'needs_verification' },
  { id: 'test-config-only', name: '测试待适配 API', vendor: '测试厂商', kind: 'api', protocol: 'volcengine-visual-signature', baseUrl: 'https://example.com', authFields: ['accessKey', 'secretKey'], capabilities: ['image', 'video'], operations: [], docsUrls: [], notes: [], availability: 'needs_verification' },
];
const connection = (extra: Record<string, unknown> = {}) => ({ id: 'ES-test', preset_id: 'test-api', name: '测试已保存连接', enabled: false, base_url: 'https://api.example.com/v1', model: '', region: '', credential_configured: true, credential_fields: ['api_key'], executable: '', args: [], cwd: '', profile: '', mcp_transport: 'stdio', mcp_url: '', timeout_ms: 120000, allowed_project_ids: [], allowed_agent_ids: [], allow_paid: false, daily_call_limit: 20, status: 'configured', version: 2, ...extra });

async function stub(page: Page, initial: any[] = [], invocations: any[] = []) {
  let connections = initial;
  const saves: any[] = [], probes: any[] = [], deletes: any[] = [];
  let saveFailure = false;
  await page.route('**/api/external-services', route => route.fulfill({ json: { presets, connections, invocations, vault: { available: true } } }));
  await page.route('**/api/external-services/invocations/*', route => route.fulfill({ json: invocations.find(i => route.request().url().endsWith('/' + i.id)) }));
  await page.route('**/api/external-services/save', async route => {
    const body = route.request().postDataJSON(); saves.push(body);
    if (saveFailure) return route.fulfill({ status: 409, json: { error: '连接已变化，请刷新后重试' } });
    const previous = connections.find(c => c.id === body.id);
    const next = connection({ ...previous, ...body, id: body.id || 'ES-new', version: (previous?.version || 0) + 1, credential_configured: body.wipe_secrets ? false : !!Object.keys(body.secrets || {}).length || !!previous?.credential_configured, credential_fields: body.wipe_secrets ? [] : [...new Set([...(previous?.credential_fields || []), ...Object.keys(body.secrets || {})])] });
    delete (next as any).secrets;
    connections = [...connections.filter(c => c.id !== next.id), next];
    await route.fulfill({ json: next });
  });
  await page.route('**/api/external-services/*/probe', async route => {
    probes.push(route.request().postDataJSON());
    connections = connections.map(c => ({ ...c, status: 'configuration_checked', last_probe: { reason: '测试：配置格式已核对，未执行生成', checked_at: '2026-11-04T12:00:00Z' } }));
    await route.fulfill({ json: { message: '测试探测已完成，未生成内容' } });
  });
  await page.route('**/api/external-services/*/calling', route => route.fulfill({ json: { markdown: '通过工作台 MCP 调用 service_id=ES-test；凭据由本机服务注入。', connection_id: 'ES-test', operations: ['chat'] } }));
  await page.route('**/api/external-services/*/delete', async route => { deletes.push(route.request().postDataJSON()); connections = []; await route.fulfill({ json: { ok: true } }); });
  return { saves, probes, deletes, failSave(value: boolean) { saveFailure = value; } };
}

test('外部 API 连接默认停用且无授权范围，密钥替换不回显，保存失败保留编辑', async ({ page }) => {
  const state = await stub(page);
  await page.goto('/#/team?tab=external');
  await expect(page.getByRole('tab', { name: '外部服务', exact: true })).toHaveAttribute('aria-selected', 'true');
  await page.getByRole('article', { name: '测试 API 服务', exact: true }).getByRole('button', { name: '添加连接' }).click();
  const dialog = page.getByRole('dialog', { name: '添加连接 · 测试 API 服务' });
  await expect(dialog.getByLabel('启用此连接')).not.toBeChecked();
  await expect(dialog.getByLabel('启用此连接')).toBeDisabled();
  await expect(dialog.getByLabel('允许消耗额度或产生 API 费用')).not.toBeChecked();
  await dialog.getByLabel('连接名称', { exact: true }).fill('测试私有连接');
  await dialog.getByLabel('API Key', { exact: true }).fill('fixture-secret-never-persist-browser');
  state.failSave(true);
  await dialog.getByRole('button', { name: '保存连接', exact: true }).click();
  await expect(dialog.getByRole('alert')).toContainText('连接已变化');
  await expect(dialog.getByLabel('连接名称', { exact: true })).toHaveValue('测试私有连接');
  state.failSave(false);
  await dialog.getByRole('button', { name: '保存连接', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  expect(state.saves[1]).toMatchObject({ enabled: false, allow_paid: false, allowed_project_ids: [], allowed_agent_ids: [], daily_call_limit: 20, secrets: { api_key: 'fixture-secret-never-persist-browser' } });
  expect(await page.evaluate(() => JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage } }))).not.toContain('fixture-secret');
  const card = page.getByRole('article', { name: '测试私有连接', exact: true });
  await expect(card).toContainText('未授权项目');
  await card.getByRole('button', { name: '编辑', exact: true }).click();
  const edit = page.getByRole('dialog', { name: '编辑连接 · 测试私有连接' });
  await expect(edit.getByLabel('API Key', { exact: true })).toHaveValue('');
  await shot(page, '外部服务-编辑连接');
  await expect(edit.getByLabel('启用此连接')).toBeDisabled();
  await expect(edit).toContainText('选择至少一个项目和一位 Agent 后才可启用');
  await edit.getByRole('button', { name: '选择调用范围', exact: true }).click();
  await edit.getByLabel('全部项目', { exact: true }).check();
  await expect(edit.getByLabel('启用此连接')).toBeDisabled();
  await edit.getByLabel('工作台管理连接', { exact: true }).check();
  await edit.getByLabel('启用此连接').check();
  await edit.getByLabel('全部项目', { exact: true }).uncheck();
  await expect(edit.getByLabel('启用此连接')).toBeDisabled();
  await expect(edit.getByLabel('启用此连接')).not.toBeChecked();
  await edit.getByLabel('全部项目', { exact: true }).check();
  await edit.getByLabel('启用此连接').check();
  await edit.getByRole('button', { name: '保存连接', exact: true }).click();
  await expect(edit).toHaveCount(0);
  expect(state.saves.at(-1)).toMatchObject({ id: 'ES-new', version: 1, enabled: true, allowed_project_ids: ['*'], allowed_agent_ids: ['manager'], secrets: {} });
});

test('CLI 参数保留逐项边界，环境变量凭据独立保存，程序位置留在连接中', async ({ page }) => {
  const state = await stub(page);
  await page.goto('/#/team?tab=external');
  await page.getByRole('article', { name: '测试 CLI 工具', exact: true }).getByRole('button', { name: '添加连接' }).click();
  const d = page.getByRole('dialog', { name: '添加连接 · 测试 CLI 工具' });
  await d.getByLabel('程序完整路径').fill('C:\\测试工具\\cli.exe');
  await d.getByText('高级设置 · 区域、参数、调用范围', { exact: true }).click();
  await d.getByLabel('固定参数').fill('--profile\nmy profile\n--output=json');
  await d.getByText('补充环境变量凭据', { exact: true }).click();
  await d.getByLabel('新增凭据名称', { exact: true }).fill('MINIMAX_API_KEY');
  await d.getByRole('button', { name: '添加凭据字段', exact: true }).click();
  await d.getByLabel('MINIMAX_API_KEY', { exact: true }).fill('fixture-cli-key');
  await d.getByRole('button', { name: '保存连接', exact: true }).click();
  await expect(d).toHaveCount(0);
  expect(state.saves[0]).toMatchObject({ executable: 'C:\\测试工具\\cli.exe', args: ['--profile', 'my profile', '--output=json'], secrets: { MINIMAX_API_KEY: 'fixture-cli-key' } });
});

test('Design MCP 导入把环境变量和请求头拆为凭据，拒绝在参数和 URL 放密钥', async ({ page }) => {
  const state = await stub(page);
  await page.goto('/#/team?tab=external');
  await page.getByRole('article', { name: '测试 Design MCP', exact: true }).getByRole('button', { name: '添加连接' }).click();
  const d = page.getByRole('dialog', { name: '添加连接 · 测试 Design MCP' });
  await d.getByText('导入应用提供的 MCP 配置', { exact: true }).click();
  const json = d.getByLabel('MCP 配置 JSON', { exact: true });
  await json.fill('null');
  await d.getByRole('button', { name: '填入配置' }).click();
  await expect(d.getByRole('alert')).toContainText('请粘贴单个 MCP 服务配置对象');
  await json.fill(JSON.stringify({ command: 'node.exe', args: ['server.js', '--api-key', 'fixture-secret'] }));
  await d.getByRole('button', { name: '填入配置' }).click();
  await expect(d.getByRole('alert')).toContainText('不要把密钥或令牌放在程序参数中');
  await json.fill(JSON.stringify({ url: 'https://example.com/mcp?token=fixture-secret' }));
  await d.getByRole('button', { name: '填入配置' }).click();
  await expect(d.getByRole('alert')).toContainText('服务地址不能包含');
  await json.fill(JSON.stringify({ mcpServers: { design: { type: 'http', url: 'http://127.0.0.1:8000/mcp', headers: { Authorization: 'Bearer fixture-secret', 'X-Application-Key': 'fixture-header-secret' }, env: { DESIGN_ACCOUNT: 'fixture-account' } } } }));
  await d.getByRole('button', { name: '填入配置' }).click();
  await expect(json).toHaveValue('');
  await expect(d.getByLabel('MCP 连接方式')).toHaveValue('streamable-http');
  await expect(d.getByLabel('MCP 服务地址', { exact: true })).toHaveValue('http://127.0.0.1:8000/mcp');
  await expect(d.getByLabel('Authorization 请求头', { exact: true })).toHaveAttribute('type', 'password');
  await d.getByRole('button', { name: '保存连接', exact: true }).click();
  await expect(d).toHaveCount(0);
  expect(state.saves[0]).toMatchObject({ mcp_transport: 'streamable-http', mcp_url: 'http://127.0.0.1:8000/mcp', args: [], secrets: { Authorization: 'Bearer fixture-secret', 'header_X-Application-Key': 'fixture-header-secret', DESIGN_ACCOUNT: 'fixture-account' } });
});

test('连接探测、调用卡与撤销各自明确，预设过滤及窄屏不溢出', async ({ page }) => {
  const state = await stub(page, [connection()]);
  await page.goto('/#/team?tab=external');
  const card = page.getByRole('article', { name: '测试已保存连接', exact: true });
  await card.getByRole('button', { name: '检查配置' }).click();
  await expect(card).toContainText('配置格式已核对，未执行生成');
  await expect(page.getByText('配置检查与本机探测不会生成内容；真实调用的执行状态见下方“最近调用”。', { exact: true })).toBeVisible();
  expect(state.probes).toEqual([{}]);
  await card.getByRole('button', { name: '调用方式', exact: true }).click();
  const calling = page.getByRole('dialog', { name: '测试已保存连接 · 调用方式' });
  await expect(calling.getByLabel('外部服务调用卡')).toContainText('service_id=ES-test');
  await calling.getByRole('button', { name: '复制调用方式', exact: true }).click();
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toContain('service_id=ES-test');
  await calling.getByRole('button', { name: '关闭', exact: true }).click();
  await card.getByRole('button', { name: '撤销凭据', exact: true }).click();
  const revoke = page.getByRole('dialog', { name: '撤销保存的凭据', exact: true });
  await expect(revoke).toContainText('不会注销服务商账号');
  await revoke.getByRole('button', { name: '撤销并停用', exact: true }).click();
  await expect(card).toContainText('未保存凭据');
  expect(state.saves.at(-1)).toMatchObject({ id: 'ES-test', version: 2, enabled: false, wipe_secrets: true });
  await page.getByLabel('外部服务类型').selectOption('agent_mcp');
  await expect(page.getByRole('article', { name: '测试 Design MCP', exact: true })).toBeVisible();
  await expect(page.getByRole('article', { name: '测试 CLI 工具', exact: true })).toHaveCount(0);
  expect(await noHorizontalScroll(page)).toBe(true);
  await shot(page, '外部服务-浅色');
  await page.evaluate(() => { document.documentElement.dataset.theme = 'dark'; });
  await shot(page, '外部服务-深色');
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await noHorizontalScroll(page)).toBe(true);
  await shot(page, '外部服务-窄屏');
});

test('预设明确协议与已适配操作，尚未适配的服务只保存配置，调用未知状态不冒充验证', async ({ page }) => {
  const state = await stub(page, [connection()], [
    { id: 'EI-unknown', service_id: 'ES-test', operation: 'image.generate', status: 'unknown', created_at: '2026-11-04T12:00:00Z', error: '测试：远程提交响应丢失，待核实' },
    { id: 'EI-submitted', service_id: 'ES-test', operation: 'video.create', status: 'submitted', created_at: '2026-11-04T12:01:00Z' },
  ]);
  await page.goto('/#/team?tab=external');
  const supported = page.getByRole('article', { name: '测试 API 服务', exact: true });
  await expect(supported).toContainText('OpenAI 对话兼容（openai-chat）');
  await expect(supported).toContainText('平台能力');
  await expect(supported).toContainText('工作台已适配：对话');
  await expect(supported).not.toContainText('工作台已适配：生成图片');
  const configOnly = page.getByRole('article', { name: '测试待适配 API', exact: true });
  await expect(configOnly).toContainText('接入方式待核验');
  await expect(configOnly).toContainText('仅支持保存配置，调用适配尚待完成');
  await configOnly.getByRole('button', { name: '添加连接', exact: true }).click();
  const d = page.getByRole('dialog', { name: '添加连接 · 测试待适配 API' });
  await d.getByText('高级设置 · 区域、参数、调用范围', { exact: true }).click();
  await d.getByLabel('全部项目', { exact: true }).check();
  await d.getByLabel('全部 Agent', { exact: true }).check();
  await expect(d.getByLabel('启用此连接')).toBeDisabled();
  await expect(d).toContainText('此预设尚无调用适配，可先保存配置');
  await d.getByRole('button', { name: '保存连接', exact: true }).click();
  await expect(d).toHaveCount(0);
  expect(state.saves[0]).toMatchObject({ enabled: false, preset_id: 'test-config-only' });
  await expect(page.getByText('已提交远程任务', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: /测试已保存连接.*结果未知，需核实/ }).click();
  const detail = page.getByRole('dialog', { name: '外部服务调用详情', exact: true });
  await expect(detail).toContainText('结果未知，需核实');
  await expect(detail).toContainText('远程提交响应丢失，待核实');
  await expect(detail).toContainText('不代表用户验收');
});

test('CLI 退出和 MCP 返回仅显示待核实，超时、超限、取消显示失败并展示确认依据', async ({ page }) => {
  const failures = [
    { id: 'EI-timeout', error_code: 'timeout', message: '测试：CLI 等待超时，未确认媒体完成' },
    { id: 'EI-limit', error_code: 'limit_exceeded', message: '测试：CLI 输出超过上限，调用失败' },
    { id: 'EI-cancelled', error_code: 'cancelled', message: '测试：服务报告任务已取消' },
  ];
  await stub(page, [connection()], [
    { id: 'EI-command', service_id: 'ES-test', operation: 'cli.invoke', status: 'command_completed', evidence: 'command_completed', message: '测试：只确认进程退出，请继续查询原任务', created_at: '2026-11-04T12:00:00Z' },
    { id: 'EI-tool', service_id: 'ES-test', operation: 'mcp.call', status: 'tool_completed', evidence: 'tool_completed', message: '测试：只确认工具返回，请核实任务状态', created_at: '2026-11-04T12:01:00Z' },
    ...failures.map(f => ({ ...f, service_id: 'ES-test', operation: 'cli.invoke', status: 'failed', evidence: 'invocation_failed', created_at: '2026-11-04T12:02:00Z' })),
    { id: 'EI-artifact', service_id: 'ES-test', operation: 'cli.invoke', status: 'succeeded', evidence: 'local_artifacts_verified', message: '测试：本次 mmx 图片已经读取并归档', created_at: '2026-11-04T12:03:00Z' },
  ]);
  await page.goto('/#/team?tab=external');
  for (const [status, title, evidence] of [
    ['command_completed', '命令已退出，任务待核实', '仅确认 CLI 进程正常退出（command_completed）'],
    ['tool_completed', '工具已返回，结果待核实', '仅确认 MCP 工具已返回（tool_completed）'],
  ]) {
    const row = page.locator(`.ext-invocation[data-call-status="${status}"]`);
    await expect(row.getByText(title, { exact: true })).toBeVisible();
    await expect(row).toContainText('证据：' + evidence);
    await expect(row).not.toContainText('已完成');
    const neutralColor = await row.locator('small').first().evaluate(el => getComputedStyle(el).color);
    await expect(row.locator('.ext-invocation-state')).toHaveCSS('color', neutralColor);
    await row.click();
    const detail = page.getByRole('dialog', { name: '外部服务调用详情', exact: true });
    await expect(detail.getByText(title, { exact: true })).toBeVisible();
    await expect(detail).toContainText('证据：' + evidence);
    await expect(detail).toContainText('命令退出或工具返回不代表异步媒体任务完成');
    await detail.getByRole('button', { name: '关闭', exact: true }).click();
  }
  const failed = page.locator('.ext-invocation[data-call-status="failed"]');
  await expect(failed).toHaveCount(3);
  for (const [index, failure] of failures.entries()) {
    const row = failed.nth(index);
    await expect(row.getByText('失败', { exact: true })).toBeVisible();
    await expect(row).toContainText('证据：调用失败（invocation_failed）');
    await expect(row).not.toContainText('已完成');
    await row.click();
    const detail = page.getByRole('dialog', { name: '外部服务调用详情', exact: true });
    await expect(detail.getByText(failure.message, { exact: true })).toBeVisible();
    await expect(detail).toContainText(failure.error_code);
    await detail.getByRole('button', { name: '关闭', exact: true }).click();
  }
  const archived = page.locator('.ext-invocation[data-call-status="succeeded"]');
  await expect(archived.getByText('已完成', { exact: true })).toBeVisible();
  await expect(archived).toContainText('本次产物已读取并归档（local_artifacts_verified）');
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await noHorizontalScroll(page)).toBe(true);
  await shot(page, '外部服务-调用状态');
});
