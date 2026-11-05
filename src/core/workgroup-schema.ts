import {z} from 'zod';
const key=z.string().trim().min(1).max(100),request=z.string().uuid(),content=z.string().trim().min(1).max(20000);
export const roomCreateInput=z.object({request_id:request,project_id:key,name:z.string().trim().min(1).max(100),leader_agent_id:key,member_agent_ids:z.array(key).max(16).default([]),allowed_paths:z.array(z.string().min(1).max(2000)).min(1).max(10).optional(),auto_dispatch:z.boolean().default(true),max_followups:z.number().int().min(0).max(16).default(4),max_concurrency:z.number().int().min(1).max(4).default(2)}).strict().refine(v=>new Set([v.leader_agent_id,...v.member_agent_ids]).size<=16,'工作群最多16位成员（包含负责人）');
export const roomUpdateInput=z.object({expected_revision:z.number().int().positive(),name:z.string().trim().min(1).max(100).optional(),leader_member_id:key.optional(),auto_dispatch:z.boolean().optional(),max_followups:z.number().int().min(0).max(16).optional(),max_concurrency:z.number().int().min(1).max(4).optional(),status:z.enum(['active','paused']).optional()}).strict();
export const roomMemberInput=z.object({request_id:request,agent_id:key,role:z.literal('member').optional(),model:z.string().trim().min(1).max(100).optional()}).strict();
export const roomMessageInput=z.object({request_id:request,content,reply_to:key.optional(),mentions:z.array(key).max(16).default([]),wake:z.enum(['none','leader']).default('none')}).strict();
export const roomDispatchInput=z.object({request_id:request,member_id:key,instruction:content,source_message_id:key.optional(),reply_to_job_id:key.optional(),fresh_session:z.boolean().default(false),task_id:key.optional(),run_id:key.optional()}).strict();
export const roomPageInput=z.object({after_seq:z.coerce.number().int().min(0).optional(),before_seq:z.coerce.number().int().positive().optional(),limit:z.coerce.number().int().min(1).max(100).default(100)}).strict().refine(v=>v.after_seq===undefined||v.before_seq===undefined,'不能同时指定前后游标');
export const roomResumeInput=z.object({request_id:request,fresh_session:z.boolean().default(false)}).strict();
export const roomInboxInput=z.object({room_id:key,after_seq:z.number().int().min(0).optional(),limit:z.number().int().min(1).max(100).default(100)}).strict();
export const roomAckInput=z.object({room_id:key,through_seq:z.number().int().min(0)}).strict();
export const WORKGROUP_TOOL_SCHEMAS={
  list_workgroups:z.object({project_id:key.optional()}).strict(),
  get_workgroup_context:z.object({room_id:key,after_seq:z.number().int().min(0).optional(),limit:z.number().int().min(1).max(100).default(100)}).strict(),
  post_workgroup_message:roomMessageInput.omit({wake:true}).extend({room_id:key}).strict(),
  dispatch_workgroup_task:roomDispatchInput.extend({room_id:key}).strict(),
  get_workgroup_inbox:roomInboxInput,
  ack_workgroup_inbox:roomAckInput,
  get_workgroup_job:z.object({room_id:key,job_id:key}).strict(),
};
const string={type:'string'},uuid={type:'string',format:'uuid'},seq={type:'integer',minimum:0},limit={type:'integer',minimum:1,maximum:100};
const object=(properties:Record<string,unknown>,required:string[]=[])=>({type:'object' as const,properties,required,additionalProperties:false});
export const WORKGROUP_TOOL_DEFINITIONS=[
  {name:'list_workgroups',description:'列出当前身份可参与的项目工作群。',inputSchema:object({project_id:string})},
  {name:'get_workgroup_context',description:'读取工作群成员、近期公开消息和真实调用状态。',inputSchema:object({room_id:string,after_seq:seq,limit},['room_id'])},
  {name:'post_workgroup_message',description:'以本人身份发公开消息；普通消息不会唤醒成员，不代表独立审查或验收。',inputSchema:object({room_id:string,request_id:uuid,content:{type:'string',minLength:1,maxLength:20000},mentions:{type:'array',items:string,maxItems:16},reply_to:string},['room_id','request_id','content'])},
  {name:'dispatch_workgroup_task',description:'在已授权工作群内向指定成员明确派活或请求讨论；实际启动客户端并异步回报，受本轮跟进预算约束。',inputSchema:object({room_id:string,request_id:uuid,member_id:string,instruction:{type:'string',minLength:1,maxLength:20000},source_message_id:string,reply_to_job_id:string,fresh_session:{type:'boolean'},task_id:string,run_id:string},['room_id','request_id','member_id','instruction'])},
  {name:'get_workgroup_inbox',description:'读取本成员尚未确认的消息；读取不自动确认。',inputSchema:object({room_id:string,after_seq:seq,limit},['room_id'])},
  {name:'ack_workgroup_inbox',description:'确认本成员已经读到的收件序号，不能确认未投递消息。',inputSchema:object({room_id:string,through_seq:seq},['room_id','through_seq'])},
  {name:'get_workgroup_job',description:'查询本群真实派活状态和公开结果。',inputSchema:object({room_id:string,job_id:string},['room_id','job_id'])},
];
export const workgroupManagementInput=z.object({request_id:request,user_instruction:z.string().trim().min(2).max(20000),action:z.enum(['create','update','add_member','remove_member']),room_id:key.optional(),data:z.record(z.unknown())}).strict();
export type WorkgroupToolDefinition={name:string;description:string;inputSchema:Record<string,unknown>};
export type WorkgroupCaller={kind:'user'|'manager'|'agent';id:string;project_ids?:string[];agent_id?:string;room_id?:string;member_id?:string;job_id?:string;management?:boolean;allowed_paths?:string[]};
export type WorkgroupRuntimeInput={jobId:string;roomId:string;memberId:string;agentId:string;clientId:'codex'|'claude'|'deepseek-harness'|'api-agent';dataDir:string;cwd:string;allowedRoots:string[];artifactDir:string;prompt:string;nativeSessionId?:string;model?:string;signal:AbortSignal;timeoutMs:number;onSessionId:(id:string)=>void;onBeforeSpawn?:()=>void;onBeforeRequest?:()=>void;onSpawn:(pid:number)=>void;onActivity:(activity:unknown)=>void;mcp:{baseUrl:string;token:string;tools:WorkgroupToolDefinition[]}};
export type WorkgroupRuntimeResult={status:'completed'|'failed'|'cancelled'|'blocked';text:string;nativeSessionId?:string;actualModel?:string;errorCode?:string;errorMessage?:string;exitCode:number|null;processStopped:boolean};
export type WorkgroupRunner=(input:WorkgroupRuntimeInput)=>Promise<WorkgroupRuntimeResult>;
