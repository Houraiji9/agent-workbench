/** Navigation advice shared by the page and Agent handoffs; never a read allowlist. */
type Row=Record<string,any>;
export type HandoffRole='planner'|'executor'|'reviewer';
export function roleFiles(contract:Row|undefined,role:HandoffRole){
  return [...(contract?.required||[]).map((f:Row)=>({...f,kind:'required'})),...(contract?.supplemental||[]).map((f:Row)=>({...f,kind:'supplemental'}))]
    .filter(f=>!f.roles?.length||f.roles.includes(role));
}
export function taskHandoff(task:Row,role:HandoffRole='executor'){
  const c=task.context_contract;
  return {plan:c?.plan||{content:task.scope||task.goal||''},files:roleFiles(c,role),output_dir:c?.output_dir||null,
    review_focus:c?.review_focus||[],guidance:'从本轮方案和相关文件开始；已有资料不重读。只在发现缺口、影响关联功能或检查失败时补读，并记录原因。资料清单是导航，可按需扩展。'};
}
