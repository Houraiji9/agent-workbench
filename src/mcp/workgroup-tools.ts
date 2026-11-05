import {WORKGROUP_TOOL_SCHEMAS,workgroupManagementInput,type WorkgroupCaller} from '../core/workgroup-schema.ts';
import type {Workgroups} from '../core/workgroups.ts';
import {assert} from '../core/security.ts';
export const workgroupToolNames=new Set([...Object.keys(WORKGROUP_TOOL_SCHEMAS),'manage_workgroups']);
export function registerWorkgroupTools(register:(name:string,description:string,shape:any)=>void,includeManagement=false){
  const descriptions:Record<string,string>={list_workgroups:'列出当前项目授权范围内的工作群',get_workgroup_context:'读取工作群近期消息、成员和真实派活状态',post_workgroup_message:'以本人身份发公开消息；普通发言不启动成员',dispatch_workgroup_task:'在已授权群内明确派活或请求成员讨论，实际启动客户端并自动回报',get_workgroup_inbox:'读取本成员增量收件箱，不自动确认',ack_workgroup_inbox:'确认本成员已投递的消息序号',get_workgroup_job:'查询本群真实调用，不冒充审查或用户验收'};
  for(const [name,schema] of Object.entries(WORKGROUP_TOOL_SCHEMAS))register(name,descriptions[name],schema.shape);
  if(includeManagement)register('manage_workgroups','按用户原话创建或管理已授权项目工作群；成员job凭据不能自增授权',workgroupManagementInput.shape);
}
export function callWorkgroupTool(groups:Workgroups,tool:string,input:unknown,caller:WorkgroupCaller){
  if(tool==='manage_workgroups')return groups.manage(input,caller);
  const schema=WORKGROUP_TOOL_SCHEMAS[tool as keyof typeof WORKGROUP_TOOL_SCHEMAS];assert(schema,'工作群工具不存在',404);const v=schema.parse(input) as Record<string,any>;
  if(tool==='list_workgroups')return groups.list(v.project_id,caller);
  if(tool==='get_workgroup_context'){const {room_id,...page}=v;return groups.detail(room_id,page,caller);}
  if(tool==='post_workgroup_message'){const {room_id,...message}=v;return groups.post(room_id,message,caller);}
  if(tool==='dispatch_workgroup_task'){const {room_id,...dispatch}=v;return groups.dispatch(room_id,dispatch,caller);}
  if(tool==='get_workgroup_inbox')return groups.inbox(v,caller);
  if(tool==='ack_workgroup_inbox')return groups.ack(v,caller);
  return groups.getJob(v.room_id,v.job_id,caller);
}
