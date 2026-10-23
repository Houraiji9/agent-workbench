type Row = Record<string, any>;

/** Follow explicit rework links. Missing/cyclic records remain unresolved. */
export function resolveDependency(tasks: Map<string, Row>, id: string) {
  const seen = new Set<string>();
  let task = tasks.get(id);
  while (task?.status === 'rework_linked') {
    if (seen.has(task.id) || !task.rework_task_id) return { task, satisfied: false, invalid: true };
    seen.add(task.id);
    task = tasks.get(task.rework_task_id);
  }
  return { task, satisfied: task?.status === 'accepted', invalid: !task };
}

const pending = new Set(['ready', 'awaiting_dispatch']);
export function waitingForDependencies(t: Row): boolean {
  return pending.has(t.status) && t.execution?.dependencies_ready === false;
}

/** A read-only projection: planning order stays stable when receipts update timestamps. */
export function withExecutionOrder(tasks: Row[], runs: Row[], plans: Row[], agents: Row[] = []): Row[] {
  const byId = new Map(tasks.map(t => [t.id, t]));
  const runById = new Map(runs.map(r => [r.id, r]));
  const member = (id: string) => agents.find(a => a.id === id)?.merged_into || id;
  const executor = (t: Row) => member(runById.get(t.current_run_id)?.agent_id || t.agent_id);
  const planOrder = new Map<string, { date: string; plan: string; index: number }>();
  for (const p of plans) (p.task_ids || []).forEach((id: string, index: number) => planOrder.set(id, { date: p.created_at || '', plan: p.id, index }));
  const rank = (t: Row) => planOrder.get(t.id) || { date: t.created_at || '', plan: t.request_id || '', index: 0 };
  const compare = (a: Row, b: Row) => {
    const x = rank(a), y = rank(b);
    return x.date.localeCompare(y.date) || x.plan.localeCompare(y.plan) || x.index - y.index || a.id.localeCompare(b.id);
  };
  const depths = new Map<string, number | null>();
  const visiting = new Set<string>();
  const depth = (id: string): number | null => {
    if (depths.has(id)) return depths.get(id)!;
    const t = byId.get(id);
    if (!t || visiting.has(id)) return null;
    visiting.add(id);
    const dependencies = [...(t.dependencies || []), ...(t.status === 'rework_linked' && t.rework_task_id ? [t.rework_task_id] : [])];
    const levels = dependencies.map(d => depth(d));
    const value = levels.some(n => n === null) ? null : 1 + Math.max(0, ...(levels as number[]));
    visiting.delete(id); depths.set(id, value);
    return value;
  };
  const reference = (t: Row) => ({ id: t.id, title: t.title, project_id: t.project_id, status: t.status });
  const projected: Row[] = tasks.map(t => {
    const dependencies = (t.dependencies || []).map((id: string) => {
      const resolved = resolveDependency(byId, id), original = byId.get(id);
      return { id, title: original?.title || '找不到前序任务', effective_id: resolved.task?.id || id,
        effective_title: resolved.task?.title || '找不到前序任务', status: resolved.task?.status || 'missing',
        satisfied: resolved.satisfied, invalid: resolved.invalid };
    });
    const step = depth(t.id);
    return { ...t, execution: { step, plan_position: (planOrder.get(t.id)?.index ?? 0) + 1,
      dependencies, dependencies_ready: step !== null && dependencies.every((d: Row) => d.satisfied),
      executor_id: executor(t), queue_position: null as number | null, ahead: null as Row | null,
      active_work: [] as Row[], unlocks: tasks.filter(next => (next.dependencies || []).some((id: string) => id === t.id || resolveDependency(byId, id).task?.id === t.id)).map(reference) } };
  });
  const queues = new Map<string, Row[]>();
  for (const t of projected.filter(t => pending.has(t.status) && t.execution.dependencies_ready && !t.request_withdrawn).sort(compare)) {
    const who = t.execution.executor_id, queue = queues.get(who) || [];
    t.execution.queue_position = queue.length + 1;
    t.execution.ahead = queue.length ? reference(queue[queue.length - 1]) : null;
    t.execution.active_work = projected.filter(x => x.id !== t.id && x.execution.executor_id === who && ['dispatched', 'running', 'waiting_input', 'blocked'].includes(x.status)).map(reference);
    queue.push(t); queues.set(who, queue);
  }
  return projected;
}

export function byExecutionOrder(a: Row, b: Row): number {
  return (a.execution?.step ?? Number.MAX_SAFE_INTEGER) - (b.execution?.step ?? Number.MAX_SAFE_INTEGER)
    || String(a.created_at || '').localeCompare(String(b.created_at || ''))
    || (a.execution?.plan_position ?? 0) - (b.execution?.plan_position ?? 0)
    || String(a.id).localeCompare(String(b.id));
}
