// 新界面的“接力”翻译与时间呈现：只是展示层，但必须与后台状态语义一致，不能把未知或计划说成事实。
import test from 'node:test';
import assert from 'node:assert/strict';
import { relayOf, isYourTurn, isTheirTurn, byUrgency, folderSuggestions, statusText, reviewSkippedTask } from '../src/web/lib/flow.ts';
import { relative, daysUntil, dayCountText, money, subscriptionPrice, bigNumber } from '../src/web/lib/format.ts';
import { parseHash, routeHash } from '../src/web/app/store.tsx';
import { taskAction, taskDisplayStatus } from '../src/shared/workflow-view.ts';

const name = (id: string) => ({ codex: 'Codex', zcode: 'Zcode', 'grok-build': 'Grok Build', claude: 'Claude' } as Record<string, string>)[id] || id;
const task = (status: string, extra: Record<string, unknown> = {}) => ({ id: 'T-x', status, agent_id: 'zcode', reviewer_id: 'grok-build', review_policy: { mode: 'required' }, ...extra });

test('每个后台状态都映射到明确的一棒、持棒人和下一步', () => {
  const all = ['ready', 'awaiting_dispatch', 'dispatched', 'running', 'waiting_input', 'blocked', 'failed', 'submitted', 'changes_requested', 'in_review', 'awaiting_confirmation', 'accepted', 'cancelled','awaiting_closeout','closing','closeout_waiting_input','closeout_blocked'];
  for (const s of all) {
    const r = relayOf(task(s), name);
    assert.ok(statusText[s], s + ' 有中文名称');
    assert.ok(r.headline.length > 3 && r.next.length > 3, s + ' 有现在/下一步说明');
    assert.equal(r.legs.length, 7);
  }
  assert.equal(relayOf(task('awaiting_dispatch'), name).at, 2);
  assert.equal(relayOf(task('awaiting_dispatch'), name).holder, 'you');
  assert.equal(relayOf(task('running'), name).holder, 'agent');
  assert.equal(relayOf(task('submitted', {review_stage:'running'}), name).holder, 'reviewer');
  assert.equal(relayOf(task('in_review'), name).at, 5);
  assert.equal(relayOf(task('accepted'), name).at, 7);
  assert.equal(relayOf(task('cancelled'), name).at, -1);
});

test('改派后接力线显示当前执行者，而不是原计划执行者', () => {
  const r = relayOf(task('running'), name, 'codex');
  assert.equal(r.legs[3].who, 'Codex');
  assert.match(r.headline, /Codex/);
});

test('用户明确不审查：交付后由执行者收尾，完成后轮到用户；规划者单方面置空审查者不算', () => {
  const skip = task('awaiting_confirmation', { reviewer_id: null, review_policy: { mode: 'not_requested', source: 'user_requested' } });
  assert.equal(reviewSkippedTask(skip), true);
  assert.equal(relayOf(skip, name).legs[4].who, '本次不审查');
  assert.equal(isYourTurn(skip), true);
  const closeout={...skip,status:'awaiting_closeout',closeout_delivery:'agent'};
  assert.equal(relayOf(closeout,name).next,'Zcode 交付后继续完成剩余事项');
  assert.equal(isTheirTurn(closeout),true);
  assert.equal(isYourTurn(closeout),false);
  assert.equal(relayOf(task('awaiting_closeout',{closeout_delivery:'agent'}),name).next,'Zcode 收到审查结果后继续完成剩余事项');
  const forged = task('submitted', { reviewer_id: null, review_policy: { mode: 'not_requested', source: 'planner' } });
  assert.equal(reviewSkippedTask(forged), false);
  assert.equal(isYourTurn(forged), true);
  assert.equal(isTheirTurn(forged), false);
});

test('轮到你 / 正在处理 互不重叠，结束的任务不出现在任何一边', () => {
  for (const s of Object.keys(statusText)) {
    const t = task(s);
    assert.ok(!(isYourTurn(t) && isTheirTurn(t)), s + ' 不能同时出现在两边');
    if (['accepted', 'cancelled'].includes(s)) assert.ok(!isYourTurn(t) && !isTheirTurn(t));
  }
  const sorted = [task('ready'), task('waiting_input'), task('blocked')].sort(byUrgency).map(t => t.status);
  assert.deepEqual(sorted, ['waiting_input', 'blocked', 'ready']);
});

test('等待用户问题优先于执行或审查调用的活动与失败状态', () => {
  for (const status of ['waiting_input', 'closeout_waiting_input']) {
    for (const automationStatus of ['queued', 'launching', 'running', 'failed', 'interrupted']) {
      for (const role of ['execution', 'review']) {
        const waiting = task(status, { automation: { status: automationStatus, role, reason: '客户端调用原因' } });
        const context = `${status} / ${automationStatus} / ${role}`;
        assert.deepEqual(taskAction(waiting), { group: 'answer', owner: 'user', label: '去回答' }, context);
        assert.equal(isYourTurn(waiting), true, context);
        assert.equal(isTheirTurn(waiting), false, context);
        const relay = relayOf(waiting, name);
        assert.equal(relay.holder, 'you', context);
        assert.equal(relay.tone, 'you', context);
        assert.match(relay.headline, /问题|回答/, context);

        const answered = { ...waiting, question_answered: true };
        assert.deepEqual(taskAction(answered), { group: 'arrange', owner: 'user', label: '答复已保存，继续原会话' }, context);
        assert.equal(isYourTurn(answered), true, context);
        assert.equal(isTheirTurn(answered), false, context);
        assert.match(relayOf(answered, name).headline, /答复已保存/, context);
      }
    }
  }
});

test('文件夹建议只来自真实会话目录，排除已登记项目，不猜测路径', () => {
  const sessions = [
    { agent: 'codex', source_cwd: 'E:\\项目\\记账APP', updated_at: '2026-10-20T01:00:00Z', source_project: '记账APP' },
    { agent: 'zcode', source_cwd: 'E:\\项目\\记账APP\\', updated_at: '2026-10-21T01:00:00Z' },
    { agent: 'codex', source_cwd: 'C:\\Projects\\Workbench', updated_at: '2026-10-21T02:00:00Z' },
    { agent: 'codex', source_cwd: null },
    { agent: 'codex', source_cwd: 'relative\\path' },
    { agent: 'codex', source_cwd: 'C:\\' },
  ];
  const r = folderSuggestions(sessions, [{ paths: ['C:\\Projects\\Workbench'] }]);
  assert.equal(r.length, 1);
  assert.equal(r[0].path, 'E:\\项目\\记账APP');
  assert.equal(r[0].count, 2);
  assert.deepEqual(r[0].agents.sort(), ['codex', 'zcode']);
  assert.equal(r[0].name, '记账APP');
});

test('时间与金额：未知就说未知，计划日期按天计算', () => {
  const now = Date.parse('2026-10-21T12:00:00Z');
  assert.equal(relative(null, 'UTC', now), '时间未知');
  assert.equal(relative('2026-10-21T11:00:00Z', 'UTC', now), '1 小时前');
  assert.equal(relative('2026-10-21T15:00:00Z', 'UTC', now), '3 小时后');
  assert.equal(daysUntil('2026-12-17', 'UTC', now), 57);
  assert.equal(daysUntil('2026-10-20', 'UTC', now), -1);
  assert.equal(daysUntil(null, 'UTC', now), null);
  assert.equal(dayCountText(-1), '已过 1 天，请核对');
  assert.equal(money(null, 'USD'), '金额未知');
  assert.equal(money(30, 'USD', 'month'), '$30 / 月');
  assert.equal(subscriptionPrice({ amount_minor: 82000, currency: 'CNY', interval: 'month' }), '¥820 / 月');
  assert.equal(subscriptionPrice({}), '金额未知');
  assert.equal(bigNumber(75900683), '7,590.1 万');
  assert.equal(bigNumber(undefined), '未知');
});

test('页面地址：刷新后仍回到同一页面、页签和任务', () => {
  const r = { page: 'projects', id: 'P-1', tab: 'files', task: 'T-9' };
  assert.deepEqual(parseHash(routeHash(r)), r);
  assert.deepEqual(parseHash(routeHash({ page: 'resources', tab: 'plans' })), { page: 'resources', id: undefined, tab: 'plans', task: undefined });
  assert.equal(parseHash('#/unknown').page, 'today');
  assert.equal(parseHash('').page, 'today');
});

test('多人审查等待同伴与负责人决定具有不同持棒人',()=>{
 const active=task('in_review',{review_stage:'running'}),waiting=task('submitted',{review_stage:'awaiting_decision'});
 assert.equal(taskAction(active).owner,'reviewer');assert.equal(relayOf(active,name).holder,'reviewer');assert.match(relayOf(active,name).headline,/审查/);
 assert.equal(taskAction(waiting).group,'decision');assert.equal(taskAction(waiting).owner,'user');assert.equal(relayOf(waiting,name).holder,'you');assert.match(taskAction(waiting).label,/负责人决定/);
});

test('审查主说明区分未安排、待接单与部分回报，其余待接单',()=>{
 const pending=[{reviewer_id:'claude',status:'awaiting_dispatch',delivery_mode:'manual'}];
 const none=relayOf(task('submitted'),name),arranged=relayOf(task('submitted',{active_reviewers:pending,review_stage:'awaiting_dispatch'}),name),partial=relayOf(task('submitted',{active_reviewers:pending,review_report_counts:{completed:1}}),name);
 assert.match(none.headline,/尚未安排/);assert.match(arranged.headline,/已安排/);assert.match(arranged.next,/已准备的审查单/);assert.match(partial.headline,/部分审查已回报.*待接单/);assert.equal(taskAction(task('submitted',{active_reviewers:pending,review_report_counts:{completed:1}})).owner,'user');
});
test('负责人继续与真实单人通过的收尾说明不能混同',()=>{
 for(const context of [{review_decision:{decision:'continue'}},{review_closeout_decision_id:'RD'},{closeout:{review_decision_id:'RD'}}]){const relay=relayOf(task('awaiting_closeout',{...context,closeout_delivery:'agent'}),name);assert.match(relay.headline,/负责人决定继续/);assert.doesNotMatch(relay.headline,/审查已通过/);assert.doesNotMatch(relay.next,/收到审查结果/);}
 assert.match(relayOf(task('awaiting_closeout'),name).headline,/审查已通过/);
});

test('同会话续单保留未接单事实，当前执行者持棒且旧标记不扩大到新负责人',()=>{
 const marker={run_id:'R-current',source_run_id:'R-old',agent_id:'zcode'};
 const awaiting=task('awaiting_dispatch',{current_run_id:'R-current',same_session_continuation:marker});assert.equal(taskAction(awaiting).owner,'agent');assert.match(taskAction(awaiting).label,/等待接单/);assert.equal(awaiting.status,'awaiting_dispatch');
 assert.equal(taskAction({...awaiting,current_run_id:'R-other'}).owner,'user');assert.equal(taskAction({...awaiting,agent_id:'codex'}).owner,'user');
 assert.equal(taskAction({...awaiting,automation:{status:'failed',role:'execution',run_id:'R-current'}}).group,'decision');
 assert.equal(taskAction({...awaiting,status:'awaiting_confirmation',automation:{status:'completed',role:'execution'}}).owner,'user');
 assert.equal(taskAction({...awaiting,status:'awaiting_closeout'}).owner,'agent');
});

test('手工同会话续接的分类、状态标签、接力说明一致，初次交接和阻碍不被掩盖',()=>{
 const t=task('awaiting_dispatch',{execution_route:null,automation:null,current_run_id:'R-new',same_session_continuation:{run_id:'R-new',agent_id:'zcode'}});
 const relay=relayOf(t,name);assert.equal(relay.holder,'agent');assert.equal(relay.headline,'原会话继续返修，等待接单');assert.match(relay.next,/无需再次转发/);assert.equal(relay.legs[2].who,'Zcode');assert.equal(relay.legs[2].label,'原会话续接');assert.equal(taskDisplayStatus(t),'continuation_pending');assert.equal(isYourTurn(t),false);assert.equal(t.status,'awaiting_dispatch');
 for(const legacy of [{...t,same_session_continuation:null},{...t,current_run_id:'R-other'},{...t,agent_id:'codex'}]){assert.equal(relayOf(legacy,name).holder,'you');assert.match(relayOf(legacy,name).next,/粘贴/);assert.equal(taskDisplayStatus(legacy),'awaiting_dispatch');}
 for(const extra of [{automation:{status:'failed',role:'execution'}},{pending_user_decision:{expires_at:new Date(Date.now()+60000).toISOString(),action:'accept',title:'用户决定'}},{status:'waiting_input'},{status:'awaiting_confirmation'}]){const changed={...t,...extra};assert.equal(relayOf(changed,name).holder,'you');assert.notEqual(taskDisplayStatus(changed),'continuation_pending');}
 const closeout=relayOf({...t,status:'awaiting_closeout'},name);assert.equal(closeout.holder,'agent');assert.match(closeout.headline,/原会话继续收尾/);assert.doesNotMatch(closeout.next,/复制/);
});
