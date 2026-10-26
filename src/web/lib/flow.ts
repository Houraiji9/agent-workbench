import {reviewHandoffCopy,leadContinuedReview} from '../../shared/workflow-view.js';
import {planningOriginLabel} from '../../shared/planning-origin.js';
import {taskAction,hasSameSessionContinuation} from '../../shared/workflow-view.js';
export {taskDisplayStatus} from '../../shared/workflow-view.js';
// 工作接力：把账本里的任务状态翻译成“接力棒现在在谁手里、下一步做什么”。
// 只做展示层翻译，不改变后台状态语义；所有判断都可在单元测试中核对。
import {waitingForDependencies,byExecutionOrder} from '../../shared/execution-order.js';
export type R = Record<string, any>;

export type Holder = 'you' | 'agent' | 'reviewer' | 'planner' | 'none';
export type Tone = 'you' | 'working' | 'review' | 'problem' | 'done' | 'quiet';

export interface Leg { key: string; label: string; who: string }
export interface Relay {
  legs: Leg[];
  /** 当前所在一棒（0 起）；已完成为 legs.length，已取消为 -1 */
  at: number;
  holder: Holder;
  tone: Tone;
  /** 一句话：现在发生什么 */
  headline: string;
  /** 一句话：下一步由谁做什么 */
  next: string;
  skippedReview: boolean;
}

export const statusText: R = {
  awaiting_planning: '等待规划',
  planned: '已规划',
  ready: '待生成执行单',
  awaiting_dispatch: '待交给执行者',
  continuation_pending: '原会话待续接',
  dispatched: '已发出，待接单',
  running: '正在执行',
  waiting_input: '等你回答',
  blocked: '遇到阻碍',
  changes_requested: '审查要求修改',
  acceptance_rejected: '验收未通过，待返工',
  rework_linked: '验收未通过，已安排返工',
  submitted: '已交付，待审查',
  review_running: '审查中',
  review_decision: '待负责人决定',
  awaiting_confirmation: '收尾完成，待你试用',
  in_review: '待执行者收尾',
  awaiting_closeout: '待执行者收尾', closing: '正在收尾', closeout_waiting_input: '收尾等你回答', closeout_blocked: '收尾遇到阻碍',
  accepted: '已完成',
  failed: '没有完成',
  cancelled: '已取消',
};

export const toneOfStatus: Record<string, Tone> = {
  continuation_pending:'working',
  awaiting_planning: 'you', ready: 'you', awaiting_dispatch: 'you', waiting_input: 'you',
  awaiting_confirmation: 'you', in_review: 'you', awaiting_closeout:'you', closing:'working', closeout_waiting_input:'you', closeout_blocked:'problem',
  dispatched: 'working', running: 'working',
  submitted: 'review', review_running:'review', review_decision:'you',
  blocked: 'problem', failed: 'problem', changes_requested: 'problem',acceptance_rejected:'problem',rework_linked:'quiet',
  accepted: 'done', cancelled: 'quiet', planned: 'quiet',
};

export const hasPendingDecision=(t:R)=>!!t.pending_user_decision&&Date.parse(t.pending_user_decision.expires_at)>Date.now();

export function reviewSkippedTask(t: R): boolean {
  return t.reviewer_id === null && t.review_policy?.mode === 'not_requested' && t.review_policy?.source === 'user_requested';
}

/** 一项任务的七棒接力。审查被用户明确取消时，审查一棒显示为“本次不审查”。 */
export function relayOf(t: R, name: (id: string) => string, executor?: string): Relay {
  const skippedReview = reviewSkippedTask(t);
  const doer = name(executor || t.agent_id);
  const continuing=hasSameSessionContinuation(t)&&taskAction(t).owner==='agent';
  const reviewer = skippedReview ? '本次不审查' : name(t.reviewer_id);
  const legs: Leg[] = [
    { key: 'ask', label: '提出需求', who: '你' },
    { key: 'plan', label: '规划拆分', who: planningOriginLabel(t) },
    { key: 'handoff', label: continuing?'原会话续接':'交给执行者', who: continuing?doer:t.execution_route ? '工作台' : '你' },
    { key: 'work', label: '执行', who: doer },
    { key: 'review', label: '独立审查', who: reviewer },
    { key: 'closeout', label: '执行收尾', who: doer },
    { key: 'confirm', label: '你试用确认', who: '你' },
  ];
  const r = (at: number, holder: Holder, tone: Tone, headline: string, next: string): Relay => ({ legs, at, holder, tone, headline, next, skippedReview });
  if(['waiting_input','closeout_waiting_input'].includes(t.status)&&t.question_answered)return r(3,'you','you','答复已保存，等待执行者继续','把续作简讯交回原会话，无需再次回答');
  if(t.status==='awaiting_confirmation'&&t.delivery_target==='runtime'&&!t.deployment?.verified)return r(5,'agent','working','等待本机安装验证','执行者先完成运行目录更新与验证，再交你试用');
  if(waitingForDependencies(t))return r(2,'none','quiet','等待前序任务完成','先完成下方列出的任务并确认验收，再交给执行者');
  if(hasPendingDecision(t))return r(['accept','reject'].includes(t.pending_user_decision.action)?6:4,'you','you',t.pending_user_decision.title,'查看已填好的事项，确认后生效');
  if(t.automation&&(!t.automation.superseded||t.automation.recovery_required||t.automation.process_may_be_running===true)&&['failed','interrupted'].includes(t.automation.status)&&!['waiting_input','closeout_waiting_input','accepted','cancelled','rework_linked'].includes(t.status))return r(t.automation.role==='review'?4:3,'you','problem','客户端调用受阻',t.automation.reason||'查看调用记录，处理本机客户端问题后再继续');
  if(t.automation&&['queued','launching','running'].includes(t.automation.status)&&!['waiting_input','closeout_waiting_input','awaiting_confirmation','accepted','cancelled','rework_linked'].includes(t.status))return r(t.automation.role==='review'?4:3,t.automation.role==='review'?'reviewer':'agent',t.automation.role==='review'?'review':'working',t.automation.role==='review'?'正在调用独立审查者':'正在调用执行者','等待实际回执更新进度，无需转发执行单或审查单');
  if(['submitted','in_review'].includes(t.status)&&t.review_stage==='awaiting_decision')return r(4,'you','you','审查报告已齐，等待负责人决定','查看各方意见，记录继续推进、退回修改或追加审查的理由');
  if(t.status==='in_review'&&t.review_stage==='running'){const review=reviewHandoffCopy(t);return r(4,'reviewer','review',review.headline,review.next);}
  if(continuing)return t.status==='awaiting_closeout'?r(5,'agent','working','原会话继续收尾',`${doer} 在当前会话完成剩余事项，回执会更新进度`):r(3,'agent','working','原会话继续返修，等待接单',`${doer} 在当前会话读取本轮修改并回报接单，无需再次转发`);
  switch (t.status) {
    case 'ready': return t.execution_route?r(2,'agent','quiet','计划已经排好，等待调用执行者',`按计划调用 ${doer}，接单后自动更新`):r(2, 'you', 'you', '计划已经排好，还没生成执行单', `生成执行单并复制，发给 ${doer}`);
    case 'awaiting_dispatch': return t.execution_route?r(2,'agent','quiet','执行单已准备好，等待调用执行者',`按计划调用 ${doer}，接单后自动更新`):r(2, 'you', 'you', `执行单已准备好，等你交给 ${doer}`, `把简版执行单粘贴给 ${doer}，接单回执会自动更新状态`);
    case 'dispatched': return r(3, 'agent', 'working', `已经发给 ${doer}，等它确认接单`, `${doer} 读完执行单后会回报“开始”，你不用做什么`);
    case 'running': return r(3, 'agent', 'working', `${doer} 正在做`, `等 ${doer} 回报进展或交付；有问题它会来问你`);
    case 'waiting_input': return r(3, 'you', 'you', `${doer} 有个问题要问你`, '写下你的回答，保存后复制给它');
    case 'blocked': return r(3, 'you', 'problem', `${doer} 遇到了阻碍，暂时停下了`, '看看它说的原因；可以回原会话协助，或换一位执行者重做');
    case 'failed': return r(3, 'you', 'problem', '这一次没有完成', '可以换一位执行者重新做，原来的记录都会保留');
    case 'submitted': {
      if(skippedReview)return r(5,'you','you',`${doer} 已交付，等待收尾`,`把收尾单交给 ${doer}`);
      const review=reviewHandoffCopy(t);return r(4,review.holder as Holder,'review',review.headline,review.next);
    }
    case 'changes_requested': return r(4, 'you', 'problem', `${reviewer} 审查后要求修改`, '在原会话继续，只处理本轮新增修改意见');
    case 'acceptance_rejected': return r(6,'you','problem','你已确认本次结果不通过',`复制返工要求，交给 ${doer} 修改`);
    case 'rework_linked': return r(3,'none','quiet','本次验收未通过，已由后续任务接替','查看后续任务的进展；原交付与意见保留在这里');
    case 'in_review': case 'awaiting_closeout': return r(5, t.closeout_delivery==='agent'?'agent':'you', t.closeout_delivery==='agent'?'working':'you', skippedReview ? `${doer} 已交付，等待收尾` : leadContinuedReview(t)?'负责人决定继续，等待执行者收尾':'成果已交付，等待执行者收尾', t.closeout_delivery==='agent'?(skippedReview?`${doer} 交付后继续完成剩余事项`:leadContinuedReview(t)?`${doer} 按负责人决定继续完成剩余事项`:`${doer} 收到审查结果后继续完成剩余事项`):`复制收尾单，交回 ${doer}`);
    case 'closing': return r(5, 'agent', 'working', `${doer} 正在收尾`, '等执行者完成剩余事项，再试用验收');
    case 'closeout_waiting_input': return r(5, 'you', 'you', `${doer} 收尾时需要你回答`, '保存回答并复制回执行者');
    case 'closeout_blocked': return r(5, 'you', 'problem', `${doer} 收尾遇到阻碍`, '查看原因，协助执行者继续，或新开执行处理修改');
    case 'awaiting_confirmation': return r(6, 'you', 'you', `${doer} 已完成收尾，等你试用`, '打开成果试用一下，符合需求就确认完成');
    case 'accepted': return r(7, 'none', 'done', '已经完成', '成果和全部记录都已归档，可以随时回来查看');
    case 'cancelled': return r(-1, 'none', 'quiet', '这项任务已取消', '已有的执行记录和成果都保留着');
    default: return r(1, 'planner', 'quiet', statusText[t.status] || t.status, '等待新的进展');
  }
}

/** 需求在规划前的两棒。 */
export function requestRelay(): Relay {
  return {
    legs: [
      { key: 'ask', label: '提出需求', who: '你' },
      { key: 'plan', label: '规划拆分', who: '规划模型' },
      { key: 'handoff', label: '交给执行者', who: '你' },
      { key: 'work', label: '执行', who: '待定' },
      { key: 'review', label: '独立审查', who: '待定' },
      { key: 'closeout', label: '执行收尾', who: '待定' },
      { key: 'confirm', label: '你试用确认', who: '你' },
    ],
    at: 1, holder: 'you', tone: 'you', skippedReview: false,
    headline: '需求已记下，等待规划',
    next: '选择规划连接，或在 GPT 聊天里规划并粘贴回传；保存计划后任务会出现在这里',
  };
}

/** 首页排序：越靠前越需要你先处理。 */
const urgency = ['closeout_waiting_input','waiting_input', 'closeout_blocked','blocked', 'failed', 'acceptance_rejected','changes_requested', 'awaiting_confirmation', 'in_review','awaiting_closeout', 'awaiting_dispatch', 'ready', 'submitted', 'dispatched', 'running'];
export function byUrgency(a: R, b: R): number {
  const d = urgency.indexOf(a.status) - urgency.indexOf(b.status);
  if(['ready','awaiting_dispatch'].includes(a.status)&&['ready','awaiting_dispatch'].includes(b.status))return byExecutionOrder(a,b);
  return d || String(b.updated_at || '').localeCompare(String(a.updated_at || ''));
}

export const yourTurn = ['closeout_waiting_input','waiting_input', 'closeout_blocked','blocked', 'failed', 'acceptance_rejected','changes_requested', 'awaiting_confirmation', 'in_review','awaiting_closeout', 'awaiting_dispatch', 'ready'];
export const theirTurn = ['dispatched', 'running', 'closing'];
export const finished = ['accepted', 'cancelled','rework_linked'];

export function isYourTurn(t:R):boolean{return taskAction(t).owner==='user';}
export function isTheirTurn(t:R):boolean{return ['agent','reviewer'].includes(taskAction(t).owner);}

/** 事件的人话描述（不显示原始协议字段名）。 */
export function eventText(e: R, doer: string): string {
  const base: R = {
    started: `${doer} 开始工作`,
    progress: `${doer} 回报了进展`,
    waiting_input: `${doer} 提了一个问题`,
    blocked: `${doer} 遇到阻碍`,
    failed: `${doer} 报告没有完成`,
    submitted: `${doer} 交付了成果`,
    closeout_started:`${doer} 开始收尾`,closeout_progress:`${doer} 回报收尾进展`,closeout_waiting_input:`${doer} 收尾时提出问题`,closeout_blocked:`${doer} 回报收尾阻碍`,closeout_completed:`${doer} 完成收尾`,
  };
  return base[e.event_type] || e.event_type;
}

export function dispositionText(d: string): string {
  return d === 'applied' ? '' : d === 'pending' ? '（等前面的回报到齐后处理）' : '（校验未通过，没有改变状态）';
}

/** 会话所在文件夹 → 可登记的项目建议；只用真实会话里出现过的目录，不猜测路径。 */
export function folderSuggestions(sessions: R[], projects: R[], limit = 8): { path: string; name: string; count: number; agents: string[]; last: string }[] {
  const norm = (p: string) => p.replace(/[\\/]+$/, '').toLowerCase();
  const registered = new Set(projects.flatMap(p => (p.paths || []).map(norm)));
  const map = new Map<string, { path: string; name: string; count: number; agents: Set<string>; last: string }>();
  for (const s of sessions) {
    const cwd = typeof s.source_cwd === 'string' ? s.source_cwd.trim() : '';
    if (!cwd || !/^([a-zA-Z]:[\\/]|\/)/.test(cwd)) continue;
    const key = norm(cwd);
    if (registered.has(key)) continue;
    const parts = cwd.split(/[\\/]/).filter(Boolean);
    if (parts.length < 2) continue;
    const row = map.get(key) || { path: cwd.replace(/[\\/]+$/, ''), name: s.source_project || parts[parts.length - 1], count: 0, agents: new Set<string>(), last: '' };
    row.count++;
    row.agents.add(s.agent);
    const at = String(s.updated_at || s.started_at || '');
    if (at > row.last) row.last = at;
    map.set(key, row);
  }
  return [...map.values()]
    .sort((a, b) => b.last.localeCompare(a.last) || b.count - a.count)
    .slice(0, limit)
    .map(r => ({ ...r, agents: [...r.agents] }));
}
