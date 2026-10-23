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
  dispatched: '已发出，待接单',
  running: '正在执行',
  waiting_input: '等你回答',
  blocked: '遇到阻碍',
  changes_requested: '审查要求修改',
  acceptance_rejected: '验收未通过，待返工',
  rework_linked: '验收未通过，已安排返工',
  submitted: '已交付，待审查',
  awaiting_confirmation: '已交付，待你试用',
  in_review: '审查通过，待你确认',
  accepted: '已完成',
  failed: '没有完成',
  cancelled: '已取消',
};

export const toneOfStatus: Record<string, Tone> = {
  awaiting_planning: 'you', ready: 'you', awaiting_dispatch: 'you', waiting_input: 'you',
  awaiting_confirmation: 'you', in_review: 'you',
  dispatched: 'working', running: 'working',
  submitted: 'review',
  blocked: 'problem', failed: 'problem', changes_requested: 'problem',acceptance_rejected:'problem',rework_linked:'quiet',
  accepted: 'done', cancelled: 'quiet', planned: 'quiet',
};

export function reviewSkippedTask(t: R): boolean {
  return t.reviewer_id === null && t.review_policy?.mode === 'not_requested' && t.review_policy?.source === 'user_requested';
}

/** 一项任务的六棒接力。审查被用户明确取消时，审查一棒显示为“本次不审查”。 */
export function relayOf(t: R, name: (id: string) => string, executor?: string): Relay {
  const skippedReview = reviewSkippedTask(t);
  const doer = name(executor || t.agent_id);
  const reviewer = skippedReview ? '本次不审查' : name(t.reviewer_id);
  const legs: Leg[] = [
    { key: 'ask', label: '提出需求', who: '你' },
    { key: 'plan', label: '规划拆分', who: 'Codex' },
    { key: 'handoff', label: '交给执行者', who: '你' },
    { key: 'work', label: '执行', who: doer },
    { key: 'review', label: '独立审查', who: reviewer },
    { key: 'confirm', label: '你试用确认', who: '你' },
  ];
  const r = (at: number, holder: Holder, tone: Tone, headline: string, next: string): Relay => ({ legs, at, holder, tone, headline, next, skippedReview });
  if(waitingForDependencies(t))return r(2,'none','quiet','等待前序任务完成','先完成下方列出的任务并确认验收，再交给执行者');
  switch (t.status) {
    case 'ready': return r(2, 'you', 'you', '计划已经排好，还没生成执行单', `生成执行单并复制，发给 ${doer}`);
    case 'awaiting_dispatch': return r(2, 'you', 'you', `执行单已准备好，等你交给 ${doer}`, `把执行单粘贴给 ${doer}，然后点“我已经发给它”`);
    case 'dispatched': return r(3, 'agent', 'working', `已经发给 ${doer}，等它确认接单`, `${doer} 读完执行单后会回报“开始”，你不用做什么`);
    case 'running': return r(3, 'agent', 'working', `${doer} 正在做`, `等 ${doer} 回报进展或交付；有问题它会来问你`);
    case 'waiting_input': return r(3, 'you', 'you', `${doer} 有个问题要问你`, '写下你的回答，保存后复制给它');
    case 'blocked': return r(3, 'you', 'problem', `${doer} 遇到了阻碍，暂时停下了`, '看看它说的原因；可以回原会话协助，或换一位执行者重做');
    case 'failed': return r(3, 'you', 'problem', '这一次没有完成', '可以换一位执行者重新做，原来的记录都会保留');
    case 'submitted':
      return skippedReview
        ? r(5, 'you', 'you', `${doer} 已交付，按你的要求不安排审查`, '打开成果试用一下，符合需求就确认完成')
        : r(4, 'reviewer', 'review', `${doer} 已交付，等 ${reviewer} 独立审查`, t.review_stage==='running'?`${reviewer} 已接单，完成后会回传报告`:`把审查单发给 ${reviewer}，完成后报告会附在任务里`);
    case 'changes_requested': return r(4, 'you', 'problem', `${reviewer} 审查后要求修改`, '新开一次执行，让执行者按审查意见返工');
    case 'acceptance_rejected': return r(5,'you','problem','你已确认本次结果不通过',`复制返工要求，交给 ${doer} 修改`);
    case 'rework_linked': return r(3,'none','quiet','本次验收未通过，已由后续任务接替','查看后续任务的进展；原交付与意见保留在这里');
    case 'in_review': return r(5, 'you', 'you', '审查已通过，等你试用确认', '打开成果试用一下，符合需求就确认完成');
    case 'awaiting_confirmation': return r(5, 'you', 'you', `${doer} 已交付，等你试用`, '打开成果试用一下，符合需求就确认完成');
    case 'accepted': return r(6, 'none', 'done', '已经完成', '成果和全部记录都已归档，可以随时回来查看');
    case 'cancelled': return r(-1, 'none', 'quiet', '这项任务已取消', '已有的执行记录和成果都保留着');
    default: return r(1, 'planner', 'quiet', statusText[t.status] || t.status, '等待新的进展');
  }
}

/** 需求在规划前的两棒。 */
export function requestRelay(): Relay {
  return {
    legs: [
      { key: 'ask', label: '提出需求', who: '你' },
      { key: 'plan', label: '规划拆分', who: 'Codex' },
      { key: 'handoff', label: '交给执行者', who: '你' },
      { key: 'work', label: '执行', who: '待定' },
      { key: 'review', label: '独立审查', who: '待定' },
      { key: 'confirm', label: '你试用确认', who: '你' },
    ],
    at: 1, holder: 'you', tone: 'you', skippedReview: false,
    headline: '需求已记下，等 Codex 规划',
    next: '复制规划请求发给 Codex；它提交计划后，任务会自动出现在这里',
  };
}

/** 首页排序：越靠前越需要你先处理。 */
const urgency = ['waiting_input', 'blocked', 'failed', 'acceptance_rejected','changes_requested', 'awaiting_confirmation', 'in_review', 'awaiting_dispatch', 'ready', 'submitted', 'dispatched', 'running'];
export function byUrgency(a: R, b: R): number {
  const d = urgency.indexOf(a.status) - urgency.indexOf(b.status);
  if(['ready','awaiting_dispatch'].includes(a.status)&&['ready','awaiting_dispatch'].includes(b.status))return byExecutionOrder(a,b);
  return d || String(b.updated_at || '').localeCompare(String(a.updated_at || ''));
}

export const yourTurn = ['waiting_input', 'blocked', 'failed', 'acceptance_rejected','changes_requested', 'awaiting_confirmation', 'in_review', 'awaiting_dispatch', 'ready'];
export const theirTurn = ['dispatched', 'running', 'submitted'];
export const finished = ['accepted', 'cancelled','rework_linked'];

export function isYourTurn(t: R): boolean {
  if(waitingForDependencies(t))return false;
  if (t.status === 'submitted') return reviewSkippedTask(t);
  return yourTurn.includes(t.status);
}
export function isTheirTurn(t: R): boolean {
  if (t.status === 'submitted') return !reviewSkippedTask(t);
  return theirTurn.includes(t.status);
}

/** 事件的人话描述（不显示原始协议字段名）。 */
export function eventText(e: R, doer: string): string {
  const base: R = {
    started: `${doer} 开始工作`,
    progress: `${doer} 回报了进展`,
    waiting_input: `${doer} 提了一个问题`,
    blocked: `${doer} 遇到阻碍`,
    failed: `${doer} 报告没有完成`,
    submitted: `${doer} 交付了成果`,
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
