import { test, expect } from '@playwright/test';
import { makeTask, drawer, noHorizontalScroll, shot } from './support.ts';

test('客户端发现显示事实与刷新失败，路径修复仅在用户展开后提交', async ({ page }) => {
  const clients = [
    { kind: 'dsh', label: 'DeepSeek Harness / GLM', status: 'verified', version: '测试版本', executionSupported: true, supportsResume: true, reason: '已核验本机程序，账号与模型尚未调用', checkedAt: new Date().toISOString() },
    { kind: 'claude', label: 'Claude Code', status: 'missing', reason: '本机尚未找到客户端', checkedAt: new Date().toISOString() },
  ];
  let refreshCount = 0;
  let override: any;
  await page.route('**/api/agent-clients', route => route.fulfill({ json: { clients } }));
  await page.route('**/api/agent-clients/refresh', route => {
    refreshCount++;
    return route.fulfill(refreshCount === 1 ? { status: 503, json: { error: '测试：检测暂时受阻' } } : { json: { clients } });
  });
  await page.route('**/api/agent-clients/override', route => { override = route.request().postDataJSON(); return route.fulfill({ json: { clients } }); });
  await page.goto('/#/settings');
  const card = page.getByRole('region', { name: 'Agent 客户端', exact: true });
  await expect(card).toContainText('支持续接会话');
  await expect(card).toContainText('本机尚未找到客户端');
  await expect(card.getByRole('textbox')).toHaveCount(0);
  await card.getByRole('button', { name: '刷新检测' }).click();
  await expect(card.getByRole('alert')).toHaveText('测试：检测暂时受阻');
  await expect(card).toContainText('DeepSeek Harness / GLM');
  await card.getByRole('button', { name: '刷新检测' }).click();
  await expect(card.getByRole('status')).toHaveText('本机客户端状态已刷新');
  await card.getByText('高级修复', { exact: true }).click();
  await card.getByRole('button', { name: '指定已安装的程序路径' }).click();
  const input = card.getByRole('textbox', { name: 'Claude Code 的程序路径' });
  await input.fill('C:\\测试程序\\claude.exe');
  await card.getByRole('button', { name: '保存并检测' }).click();
  await expect.poll(() => override).toEqual({ kind: 'claude', executable: 'C:\\测试程序\\claude.exe' });
  expect(await noHorizontalScroll(page)).toBe(true);
  await shot(page, '客户端发现-浅色', false);
  await page.getByRole('radio', { name: '深色', exact: true }).click();
  await shot(page, '客户端发现-深色', false);
});

test('任务显示真实调用阶段，已结束不被显示为审查通过，正常审查无需转发', async ({ page }) => {
  const m = await makeTask(page, { title: '测试自动审查状态', stage: 'submitted' });
  let status = 'running';
  await page.route('**/api/tasks/' + m.tid, async route => {
    const response = await route.fetch(), detail = await response.json();
    detail.task.review_route = { client: 'dsh', model: '测试模型' };
    detail.task.automation_policy = { auto_review: true };
    detail.task.automation = { status, role: 'review', client: 'dsh', job_id: 'J-test', session_id: 'test-session', reason: status === 'failed' ? '测试：客户端账号尚未登录' : '' };
    await route.fulfill({ response, json: detail });
  });
  await page.goto('/#/projects/' + m.project.id + '?task=' + m.tid);
  const d = drawer(page);
  await expect(d.getByRole('region', { name: 'Agent 调用状态' })).toContainText('调用中');
  await expect(d.getByRole('button', { name: '同会话继续', exact: true })).toBeDisabled();
  await expect(d.getByRole('button', { name: '复制审查单', exact: true })).not.toBeVisible();
  await expect(d).toContainText('无需转发执行单或审查单');
  status = 'completed';
  await expect(d.getByRole('region', { name: 'Agent 调用状态' })).toContainText('调用已结束');
  await expect(d).toContainText('交付、审查通过与验收仍以各自的正式记录为准');
  await expect(d.getByRole('button', { name: '试用后确认完成' })).toHaveCount(0);
  status = 'failed';
  await page.reload();
  await expect(d.getByRole('region', { name: 'Agent 调用状态' })).toContainText('测试：客户端账号尚未登录');
  await expect(d.getByRole('region', { name: '现在要做什么' })).toContainText('客户端调用受阻');
  await expect(d.getByRole('button', { name: '原会话已结束，重试审查' })).toBeVisible();
  await shot(page, '任务调用失败-实际原因', false);
});

test('续接与新会话操作提交版本及唯一编号，不复制入口冒充发送', async ({ page }) => {
  const m = await makeTask(page, { title: '测试真实调用入口', stage: 'order' });
  const calls: any[] = [];
  await page.route('**/api/tasks/' + m.tid, async route => {
    const response = await route.fetch(), detail = await response.json();
    detail.task.execution_route = { client: 'dsh', model: '测试模型' };
    await route.fulfill({ response, json: detail });
  });
  await page.route('**/api/tasks/' + m.tid + '/continue', route => { calls.push(route.request().postDataJSON()); return route.fulfill({ json: { job_id: 'J-test', status: 'queued' } }); });
  await page.goto('/#/projects/' + m.project.id + '?task=' + m.tid);
  await drawer(page).getByRole('button', { name: '同会话继续', exact: true }).click();
  await expect.poll(() => calls.length).toBe(1);
  await drawer(page).getByRole('button', { name: '新会话接手', exact: true }).click();
  await expect.poll(() => calls.length).toBe(2);
  expect(calls[0]).toMatchObject({ fresh_session: false });
  expect(calls[1]).toMatchObject({ fresh_session: true });
  expect(calls[0].expected_revision).toBeGreaterThan(0);
  expect(calls[0].request_id).not.toBe(calls[1].request_id);
});

test('首次开始执行先建立Run，再用最新版本请求调用', async ({ page }) => {
  const m = await makeTask(page, { title: '测试首次客户端执行' });
  let dispatched: any;
  await page.route('**/api/tasks/' + m.tid, async route => {
    const response = await route.fetch(), detail = await response.json();
    detail.task.execution_route = { client: 'dsh', model: '测试模型' };
    await route.fulfill({ response, json: detail });
  });
  await page.route('**/api/tasks/' + m.tid + '/dispatch', route => { dispatched = route.request().postDataJSON(); return route.fulfill({ json: { job_id: 'J-test', status: 'queued' } }); });
  const before = (await m.get('/tasks/' + m.tid)).task;
  await page.goto('/#/projects/' + m.project.id + '?task=' + m.tid);
  await drawer(page).getByRole('button', { name: '开始执行', exact: true }).click();
  await expect.poll(() => dispatched).toBeTruthy();
  const after = (await m.get('/tasks/' + m.tid)).task;
  expect(after.current_run_id).toMatch(/^R-/);
  expect(after.revision).toBeGreaterThan(before.revision);
  expect(dispatched.expected_revision).toBe(after.revision);
  expect(after.status).toBe('awaiting_dispatch');
});

test('自动执行的续作按钮遵守任务阶段，调用结束也不能在执行中或待审查时重启', async ({ page }) => {
  const m = await makeTask(page, { title: '测试续作阶段门槛', stage: 'order' });
  let status = 'running';
  await page.route('**/api/tasks/' + m.tid, async route => {
    const response = await route.fetch(), detail = await response.json();
    detail.task.status = status;
    detail.task.execution_route = { client: 'claude', model: '测试模型' };
    detail.task.automation = { status: 'completed', role: 'execution', client: 'claude', job_id: 'J-test' };
    await route.fulfill({ response, json: detail });
  });
  await page.goto('/#/projects/' + m.project.id + '?task=' + m.tid);
  const d = drawer(page);
  for (const phase of ['running', 'submitted']) {
    status = phase; await page.reload();
    await expect(d.getByRole('button', { name: '同会话继续', exact: true })).toBeDisabled();
    await expect(d.getByRole('button', { name: '新会话接手', exact: true })).toBeDisabled();
  }
  for (const phase of ['blocked', 'changes_requested']) {
    status = phase; await page.reload();
    await expect(d.getByRole('button', { name: '同会话继续', exact: true })).toBeEnabled();
    await expect(d.getByRole('button', { name: '新会话接手', exact: true })).toBeEnabled();
  }
});

test('审查已接单后失败或中断仍可明确新会话重试，旧进程拒绝原因如实显示', async ({ page }) => {
  const m = await makeTask(page, { title: '测试已接单审查重试', stage: 'submitted' });
  let status = 'running';
  const requests: any[] = [];
  await page.route('**/api/tasks/' + m.tid, async route => {
    const response = await route.fetch(), detail = await response.json();
    detail.task.review_stage = 'running';
    detail.task.review_route = { client: 'grok', model: '测试审查模型' };
    detail.task.automation_policy = { auto_review: true };
    detail.task.automation = { status, role: 'review', client: 'grok', job_id: 'J-test', reason: status === 'running' ? '测试：审查客户端正在运行' : '测试：审查客户端未正常结束' };
    await route.fulfill({ response, json: detail });
  });
  await page.route('**/api/tasks/' + m.tid + '/dispatch-review', route => {
    requests.push(route.request().postDataJSON());
    return route.fulfill({ status: 409, json: { error: '测试：原审查客户端仍在运行，禁止重复启动' } });
  });
  await page.goto('/#/projects/' + m.project.id + '?task=' + m.tid);
  const d = drawer(page), retry = d.getByRole('button', { name: '原会话已结束，重试审查', exact: true });
  await expect(retry).toHaveCount(0);
  for (const phase of ['failed', 'interrupted']) {
    status = phase; await page.reload();
    await expect(retry).toBeEnabled();
    await expect(d.getByRole('region', { name: '现在要做什么' })).toContainText('审查调用已停止更新');
    await retry.click();
    await expect(page.getByRole('alert')).toContainText('原审查客户端仍在运行，禁止重复启动');
    await expect(d.getByRole('region', { name: 'Agent 调用状态' })).toContainText(phase === 'failed' ? '调用失败' : '调用已中断');
  }
  expect(requests).toHaveLength(2);
  for (const request of requests) { expect(request.fresh_session).toBe(true); expect(request.expected_revision).toBeGreaterThan(0); expect(request.request_id).toMatch(/^[a-f0-9-]{36}$/); }
  await shot(page, '已接单审查重试-旧进程拦截', false);
});

test('运行调用可填写原因停止，拒绝保留输入，成功后明确显示等待核实结束', async ({ page }) => {
  const m = await makeTask(page, { title: '测试停止客户端调用', stage: 'running' });
  const calls: any[] = [];
  let stopped = false;
  let taskRevision = 0;
  await page.route('**/api/tasks/' + m.tid, async route => {
    const response = await route.fetch(), detail = await response.json();
    taskRevision = detail.task.revision;
    detail.task.execution_route = { client: 'dsh', model: '测试模型' };
    const job = { job_id: 'J-stop-test', run_id: m.rid, client: 'dsh', role: 'execution', status: stopped ? 'interrupted' : 'running', cancel_requested: stopped, recovery_required: stopped, reason: stopped ? '测试：已请求停止，等待原客户端结束' : '测试：客户端正在运行' };
    detail.task.automation = job;
    detail.agent_jobs = [job];
    await route.fulfill({ response, json: detail });
  });
  await page.route('**/api/tasks/' + m.tid + '/agent-cancel', route => {
    calls.push(route.request().postDataJSON());
    if (calls.length === 1) return route.fulfill({ status: 409, json: { error: '测试：任务已变化，请刷新后重试' } });
    stopped = true;
    return route.fulfill({ json: { job_id: 'J-stop-test', status: 'interrupted', cancel_requested: true } });
  });
  await page.goto('/#/projects/' + m.project.id + '?task=' + m.tid);
  const d = drawer(page);
  await d.getByRole('button', { name: '停止调用', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '停止这次调用', exact: true });
  const submit = dialog.getByRole('button', { name: '确认停止调用', exact: true });
  await expect(submit).toBeDisabled();
  await dialog.getByRole('textbox', { name: '停止原因' }).fill('先停');
  await expect(submit).toBeDisabled();
  expect(calls).toHaveLength(0);
  await dialog.getByRole('textbox', { name: '停止原因' }).fill('  测试：我需要先核对本次任务  ');
  await submit.click();
  await expect(page.getByRole('alert')).toContainText('任务已变化，请刷新后重试');
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('textbox', { name: '停止原因' })).toHaveValue('  测试：我需要先核对本次任务  ');
  await submit.click();
  await expect(dialog).toHaveCount(0);
  await expect(d.getByRole('region', { name: 'Agent 调用状态' })).toContainText('已请求停止，待核实结束');
  await expect(d.getByRole('button', { name: '停止调用', exact: true })).toHaveCount(0);
  expect(calls).toHaveLength(2);
  expect(calls[1]).toEqual({ job_id: 'J-stop-test', expected_revision: taskRevision, reason: '测试：我需要先核对本次任务' });
  expect((await m.get('/tasks/' + m.tid)).task.status).toBe('running');
  await d.locator('.task-title').scrollIntoViewIfNeeded();
  await shot(page, '停止调用-等待核实结束', false);
});

test('旧执行遗留调用默认收起，恢复需勾选及原因，拒绝不绕过也不自动重试', async ({ page }) => {
  const m = await makeTask(page, { title: '测试遗留调用显式恢复', stage: 'order' });
  const calls: any[] = [];
  let recovered = false;
  let autoDispatches = 0;
  let taskRevision = 0;
  await page.route('**/api/tasks/' + m.tid, async route => {
    const response = await route.fetch(), detail = await response.json();
    taskRevision = detail.task.revision;
    detail.task.execution_route = { client: 'claude', model: '测试模型' };
    detail.task.automation = { job_id: 'J-current-test', run_id: m.rid, client: 'claude', role: 'execution', status: 'completed' };
    detail.agent_jobs = [detail.task.automation, { job_id: 'J-old-test', run_id: 'R-older-test', client: 'dsh', role: 'review', status: 'interrupted', recovery_required: !recovered, process_end_evidence: recovered ? 'user_attested' : null, reason: '测试：旧执行未记录可核实的进程编号' }];
    await route.fulfill({ response, json: detail });
  });
  await page.route('**/api/tasks/' + m.tid + '/agent-recovery', route => {
    calls.push(route.request().postDataJSON());
    if (calls.length === 1) return route.fulfill({ status: 409, json: { error: '测试：已记录的进程仍存在，不能确认结束' } });
    recovered = true;
    return route.fulfill({ json: { job_id: 'J-old-test', status: 'interrupted', recovery_required: false, process_end_evidence: 'user_attested' } });
  });
  await page.route(new RegExp('/api/tasks/' + m.tid + '/(continue|dispatch|dispatch-review)$'), route => { autoDispatches++; return route.fulfill({ status: 500, json: { error: '测试不允许自动调用' } }); });
  await page.goto('/#/projects/' + m.project.id + '?task=' + m.tid);
  const d = drawer(page);
  const recovery = d.getByRole('button', { name: '确认原调用已结束', exact: true });
  await expect(recovery).not.toBeVisible();
  await d.getByText('高级恢复（遗留调用 1）', { exact: true }).click();
  await expect(d.getByRole('region', { name: 'Agent 调用操作' })).toContainText('较早执行的遗留调用');
  await expect(d.getByRole('region', { name: 'Agent 调用操作' })).toContainText('R-older-test');
  await recovery.click();
  const dialog = page.getByRole('dialog', { name: '核实遗留调用', exact: true });
  const submit = dialog.getByRole('button', { name: '保存核实结果', exact: true });
  const checkbox = dialog.getByRole('checkbox', { name: '我已核实原调用已经结束' });
  await expect(checkbox).not.toBeChecked();
  await expect(submit).toBeDisabled();
  await dialog.getByRole('textbox', { name: '核实方式与原因' }).fill('测试：已从原客户端核实进程结束');
  await expect(submit).toBeDisabled();
  await checkbox.check();
  await dialog.getByRole('textbox', { name: '核实方式与原因' }).fill('确认');
  await expect(submit).toBeDisabled();
  expect(calls).toHaveLength(0);
  await dialog.getByRole('textbox', { name: '核实方式与原因' }).fill('测试：已从原客户端核实进程结束');
  await submit.click();
  await expect(page.getByRole('alert')).toContainText('已记录的进程仍存在，不能确认结束');
  await expect(dialog).toBeVisible();
  await expect(checkbox).toBeChecked();
  await shot(page, '遗留调用恢复-明确确认与拒绝原因', false);
  await submit.click();
  await expect(dialog).toHaveCount(0);
  await expect(d.getByRole('region', { name: 'Agent 调用操作' })).toHaveCount(0);
  expect(calls).toHaveLength(2);
  expect(calls[1]).toEqual({ job_id: 'J-old-test', expected_revision: taskRevision, confirmed: true, reason: '测试：已从原客户端核实进程结束' });
  expect(autoDispatches).toBe(0);
  expect((await m.get('/tasks/' + m.tid)).task.status).toBe('awaiting_dispatch');
  expect(await noHorizontalScroll(page)).toBe(true);
});

test('已接单执行停止后须核实再以新会话请求新Run，同会话续作保持禁用', async ({ page }) => {
  const m = await makeTask(page, { title: '测试已接单执行停止后重新开始', stage: 'running' });
  const initial = await m.get('/tasks/' + m.tid);
  const originalRun = initial.runs.find((run: any) => run.id === m.rid);
  expect(initial.task.status).toBe('running');
  expect(originalRun.status).toBe('running');
  expect(originalRun.has_started).toBe(true);
  const newRunId = 'R-new-session-test';
  const continueRequests: any[] = [];
  let stopped = false, recoveryRequired = false, restarted = false;
  let recoveryRequests = 0;
  await page.route('**/api/tasks/' + m.tid, async route => {
    const response = await route.fetch(), detail = await response.json();
    detail.task.execution_route = { client: 'dsh', model: '测试模型' };
    const oldJob = { job_id: 'J-started-test', run_id: m.rid, client: 'dsh', role: 'execution', status: stopped ? 'interrupted' : 'running', cancel_requested: stopped, recovery_required: recoveryRequired, session_id: 'original-session-test', reason: stopped ? '测试：已请求停止原执行' : '测试：执行者已接单' };
    if (restarted) {
      detail.task.status = 'awaiting_dispatch';
      detail.task.current_run_id = newRunId;
      detail.task.revision++;
      detail.runs.push({ ...originalRun, id: newRunId, status: 'awaiting_dispatch', has_started: false, seq: 0, session_id: null });
      detail.task.automation = { job_id: 'J-new-session-test', run_id: newRunId, client: 'dsh', role: 'execution', status: 'queued', session_mode: 'fresh' };
      detail.agent_jobs = [oldJob, detail.task.automation];
    } else {
      detail.task.automation = oldJob;
      detail.agent_jobs = [oldJob];
    }
    await route.fulfill({ response, json: detail });
  });
  await page.route('**/api/tasks/' + m.tid + '/agent-cancel', route => {
    stopped = true; recoveryRequired = true;
    return route.fulfill({ json: { job_id: 'J-started-test', status: 'interrupted', cancel_requested: true, recovery_required: true } });
  });
  await page.route('**/api/tasks/' + m.tid + '/agent-recovery', route => {
    expect(route.request().postDataJSON()).toMatchObject({ job_id: 'J-started-test', confirmed: true });
    recoveryRequests++; recoveryRequired = false;
    return route.fulfill({ json: { job_id: 'J-started-test', status: 'interrupted', recovery_required: false, process_end_evidence: 'user_attested' } });
  });
  await page.route('**/api/tasks/' + m.tid + '/continue', route => {
    continueRequests.push(route.request().postDataJSON());
    restarted = true;
    return route.fulfill({ json: { job_id: 'J-new-session-test', run_id: newRunId, previous_run_id: m.rid, status: 'queued', session_mode: 'fresh' } });
  });
  await page.goto('/#/projects/' + m.project.id + '?task=' + m.tid);
  const d = drawer(page);
  const sameSession = d.getByRole('button', { name: '同会话继续', exact: true });
  const restart = d.getByRole('button', { name: '停止后重新开始', exact: true });
  await expect(sameSession).toBeDisabled();
  await expect(restart).toHaveCount(0);
  await d.getByRole('button', { name: '停止调用', exact: true }).click();
  const stopDialog = page.getByRole('dialog', { name: '停止这次调用', exact: true });
  await stopDialog.getByRole('textbox', { name: '停止原因' }).fill('测试：停止本次已接单执行');
  await stopDialog.getByRole('button', { name: '确认停止调用', exact: true }).click();
  await expect(restart).toBeVisible();
  await expect(restart).toBeDisabled();
  await expect(sameSession).toBeDisabled();
  await expect(d).toContainText('仍有调用的进程状态待核验；工作台会自动核实已记录的进程编号。');
  expect(continueRequests).toHaveLength(0);
  await d.getByText('高级恢复（遗留调用 1）', { exact: true }).click();
  await d.getByRole('button', { name: '确认原调用已结束', exact: true }).click();
  const recoveryDialog = page.getByRole('dialog', { name: '核实遗留调用', exact: true });
  await recoveryDialog.getByRole('checkbox', { name: '我已核实原调用已经结束' }).check();
  await recoveryDialog.getByRole('textbox', { name: '核实方式与原因' }).fill('测试：已核实原客户端会话结束');
  await recoveryDialog.getByRole('button', { name: '保存核实结果', exact: true }).click();
  await expect(restart).toBeEnabled();
  await expect(sameSession).toBeDisabled();
  await expect(d).toContainText('使用新会话重新开始，原会话与已有回执保留');
  expect(recoveryRequests).toBe(1);
  expect(continueRequests).toHaveLength(0);
  await d.locator('.task-title').scrollIntoViewIfNeeded();
  await shot(page, '已接单停止后重新开始-核实后入口', false);
  await restart.click();
  await expect.poll(() => continueRequests.length).toBe(1);
  expect(continueRequests[0]).toMatchObject({ fresh_session: true, expected_revision: initial.task.revision });
  expect(continueRequests[0].request_id).toMatch(/^[a-f0-9-]{36}$/);
  await expect(restart).toHaveCount(0);
  await expect(d.getByRole('region', { name: 'Agent 调用状态' })).toContainText('等待调用');
  await expect(sameSession).toBeDisabled();
  const untouched = await m.get('/tasks/' + m.tid);
  expect(untouched.runs.find((run: any) => run.id === m.rid).has_started).toBe(true);
  expect(untouched.events.some((event: any) => event.run_id === m.rid && event.event_type === 'started')).toBe(true);
  expect(await noHorizontalScroll(page)).toBe(true);
});
