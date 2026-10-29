import type {ClientRecord} from './client-discovery.ts';
import type {AgentRoute} from './agent-route-schema.ts';

export type HarnessAdapterEvidence={provider:string;status:'configured'|'disabled'|'unknown';source:string};
export function staticRouteDiagnostics(record:ClientRecord,route:AgentRoute,adapters:HarnessAdapterEvidence[]=[]){
 const adapter=route.provider?adapters.find(x=>x.provider===route.provider):undefined;
 return {blocking:false,client:route.client,model:route.model||null,provider:route.provider||null,client_version:record.version||null,observed_at:record.checkedAt,
  preference_source:'unspecified',adapter:route.client==='dsh'?adapter||{provider:route.provider||null,status:'unknown',source:'no_static_evidence'}:null,
  model_validation:'not_probed',limitations:['静态配置不是登录、额度或实际调用成功证据',...(route.client==='dsh'&&!adapter?['未取得 provider adapter 的静态注册证据；保留未知，不阻止调用']:[])]};
}
export function effectiveRouteView(route:AgentRoute,actualModel?:string|null,displayName?:string|null,source='task_route'){
 return {client:route.client,provider:route.provider||null,requested_model:route.model||null,preference_source:source,actual_model:actualModel||null,actual_model_display:displayName||null,
  comparison:!route.model||!actualModel?'unknown':route.model===actualModel?'matches':'different',blocking:false};
}
export type ReviewInterruption={kind:'tool_permission_denied'|'tool_approval_unavailable'|'cancelled'|'incomplete';cancel_source:'unknown';recoverable:true;verification_limits:string[]};
/** Classification records an observed tool result, never infers who cancelled it. */
export function classifyReviewInterruption(stopReason?:string,evidence?:{tool?:string;status?:string;code?:string}):ReviewInterruption{
 const code=evidence?.code?.toLowerCase(),status=evidence?.status?.toLowerCase();
 const kind=code==='permission_denied'||code==='eacces'?'tool_permission_denied':code==='approval_unavailable'||code==='approval_required'?'tool_approval_unavailable':stopReason==='cancelled'||status==='cancelled'?'cancelled':'incomplete';
 const limitation=kind==='tool_permission_denied'?'工具权限不足，相关命令未验证':kind==='tool_approval_unavailable'?'工具审批不可交互，相关命令未验证':kind==='cancelled'?'客户端报告本段或工具取消；取消来源未知，相关验证未确认完成':'客户端未交付正式报告，验证范围仍待确认';
 return {kind,cancel_source:'unknown',recoverable:true,verification_limits:[limitation]};
}
