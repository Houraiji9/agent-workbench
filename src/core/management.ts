import fs from 'node:fs';
import path from 'node:path';
import {z} from 'zod';
import type {Workbench} from './workbench.ts';
import type {Row} from './schema.ts';
import type {Integrations} from '../integrations/adapters.ts';
import type {TraceReader} from './review-evidence.ts';
import {assert,hash,now,DomainError,safePath,atomicWrite,readBounded} from './security.ts';
import {requestInput,saveRequest,deleteRequest,archiveProject} from './request-management.ts';
import {agentInput,quotaInput,versionInput,saveAgent,archiveAgent,saveQuota,archiveQuota} from './resource-management.ts';
import {quotaCacheInput,manualPointsInput,editQuotaCache,editWorkBuddyPoints} from './quota-cache.ts';
import {projectEditSchema,replySchema} from './user-input.ts';
import {subscriptionCreateSchema,subscriptionChangesSchema} from './subscriptions.ts';
import {reworkOrder} from './acceptance-feedback.ts';
import {addAuthorizedRoot,authorizeProject} from './roots.ts';
import {reviewOrderInput,exportReviewOrder,reviewFeedbackOrder} from './review-workflow.ts';
import {assertMayArrangeReview} from './review-permissions.ts';
import {prepareDecision,decisionReceipt} from './user-decisions.ts';
import {createBackup} from '../../scripts/backup.ts';
import {artifactFile,openArtifactFolder,type revealFile} from './artifact-folders.ts';

const text=z.string().trim().min(1).max(20000),key=text.max(200),version=z.number().int().positive();
const action=<T extends z.ZodRawShape>(name:string,fields:T)=>z.object({action:z.literal(name),...fields}).strict();
const envelope=(change:z.ZodTypeAny)=>z.object({request_id:z.string().uuid(),user_instruction:text.min(2).describe('本会话用户原话，记录操作来由。关键决定须用户在页面确认，此文本不是授权凭据。'),change}).strict();
export type ManagementServices={integrations:Integrations;readReviewTrace:TraceReader;revealArtifact:typeof revealFile;openProject:(projectId:string)=>unknown};
type Context={wb:Workbench;services:ManagementServices};
type Tool={description:string;schema:z.AnyZodObject;execute:(ctx:Context,v:any)=>any;asynchronous?:boolean|((v:any)=>boolean)};

/** Explicit business operations, reusing the same validation and state machine as the desktop UI. */
export const managementTools:Record<string,Tool>={
  manage_requests:{description:'代用户新建需求或备忘、编辑、删除、从待开始送去规划。只说一句即可办理；先读取当前版本。',schema:envelope(z.discriminatedUnion('action',[
    action('create',{data:requestInput}),action('update',{request_id:key,data:requestInput}),action('delete',{request_id:key,version})
  ])),execute:({wb},v)=>v.action==='delete'?deleteRequest(wb,v.request_id,{version:v.version}):saveRequest(wb,v.action==='create'?null:v.request_id,v.data)},
  manage_projects:{description:'登记或新建项目、授权准确项目目录、修改资料、关联路径、归档和恢复项目。',schema:envelope(z.discriminatedUnion('action',[
    action('create',{name:text.max(199),path:text.max(1000),goal:text.max(5000).optional(),create:z.boolean().default(false),authorize:z.boolean().default(false)}),
    action('update',{project_id:key,data:projectEditSchema}),action('add_path',{project_id:key,path:text.max(1000),version,authorize:z.boolean().default(false)}),
    action('archive',{project_id:key,version,archived:z.boolean()})
  ])),asynchronous:v=>['create','add_path'].includes(v.action),execute:({wb},v)=>{
    if(v.action==='create'){const {action:_,authorize,...data}=v;return authorize?authorizeProject(wb.config,data,p=>wb.registerProject({...data,path:p,create:false})).value:wb.registerProject(data)}
    if(v.action==='update')return wb.editProject(v.project_id,v.data);
    if(v.action==='archive')return archiveProject(wb,v.project_id,{version:v.version,archived:v.archived});
    // Check the optimistic version before any authorization file changes.
    assert(wb.get('projects',v.project_id).version===v.version,'项目资料已变化，请重新读取版本',409);
    const add=(p:string)=>{assert(!wb.privatePath(p),'项目路径不能指向凭据或工作台数据');return wb.addProjectPath(v.project_id,p,v.version)};
    return v.authorize?authorizeProject(wb.config,{path:v.path},add).value:add(safePath(v.path,wb.config.authorizedRoots));
  }},
  manage_agents:{description:'按用户要求新增团队、编辑职责/图标/模型列表、删除或恢复成员；预设资料从管理上下文读取。',schema:envelope(z.discriminatedUnion('action',[
    action('create',{data:agentInput}),action('update',{agent_id:key,data:agentInput}),action('delete',{agent_id:key,version:versionInput.shape.version}),action('restore',{agent_id:key,version:versionInput.shape.version})
  ])),execute:({wb},v)=>['delete','restore'].includes(v.action)?archiveAgent(wb,v.agent_id,{version:v.version},v.action==='restore'):saveAgent(wb,v.action==='create'?null:v.agent_id,v.data)},
  manage_quotas:{description:'新增、修改、删除、恢复额度；关联共享来源；修改 Claude/Antigravity 缓存和 WorkBuddy 月度积分。',schema:envelope(z.discriminatedUnion('action',[
    action('create',{data:quotaInput}),action('update',{quota_id:key,data:quotaInput}),action('hide_source',{data:quotaInput}),
    action('delete',{quota_id:key,version:versionInput.shape.version}),action('restore',{quota_id:key,version:versionInput.shape.version}),
    action('cache',{provider:z.enum(['claude','antigravity']),data:quotaCacheInput}),action('workbuddy_points',{data:manualPointsInput})
  ])),execute:({wb},v)=>{
    if(v.action==='cache')return editQuotaCache(wb,v.provider,v.data);
    if(v.action==='workbuddy_points')return editWorkBuddyPoints(wb,v.data);
    if(['delete','restore'].includes(v.action))return archiveQuota(wb,v.quota_id,{version:v.version},v.action==='restore');
    return saveQuota(wb,v.action==='update'?v.quota_id:null,v.data,v.action==='hide_source');
  }},
  manage_subscriptions:{description:'管理已登记订阅和接下来的安排：新增、编辑、删除、记录实际发生。只登记用户提供的事实，不操作购买或账号。',schema:envelope(z.discriminatedUnion('action',[
    action('create',{data:subscriptionCreateSchema}),action('update',{subscription_id:key,version,changes:subscriptionChangesSchema}),
    action('delete',{subscription_id:key,version}),action('confirm',{subscription_id:key,version,occurred_at:z.string().datetime({offset:true}),note:text.min(5),end_date:z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable()})
  ])),execute:({wb},v)=>{
    if(v.action==='create')return wb.createSubscription(v.data);
    if(v.action==='update')return wb.updateBaseline('subscriptions',v.subscription_id,v.changes,v.version);
    if(v.action==='delete')return wb.deleteSubscription(v.subscription_id,{version:v.version});
    return wb.confirmSubscription(v.subscription_id,{version:v.version,occurred_at:v.occurred_at,note:v.note,end_date:v.end_date});
  }},
  manage_tasks:{description:'按用户会话中的决定标记已转发、取消、保存回答、验收通过或退回、新开返工。验收和退回只准备待用户确认卡片，用户在首页点击后才生效。',schema:envelope(z.discriminatedUnion('action',[
    action('dispatch',{task_id:key,revision:version}),action('cancel',{task_id:key,revision:version}),
    action('reply',{task_id:key,data:replySchema}),action('accept',{task_id:key,run_id:key,revision:version}),
    action('reject',{task_id:key,revision:version,run_id:key,note:text.max(10000),artifact_hashes:z.array(z.string().regex(/^[a-f0-9]{64}$/)).min(1),followup_task_id:key.optional()}),
    action('rework',{task_id:key,revision:version,feedback_id:key})
  ])),asynchronous:v=>v.action==='rework',execute:({wb},v)=>{
    if(v.action==='reply')return wb.saveReply(v.task_id,v.data);
    if(v.action==='accept'||v.action==='reject')return prepareDecision(wb,v.action,v);
    if(v.action==='rework')return reworkOrder(wb,v.task_id,{revision:v.revision,feedback_id:v.feedback_id});
    return wb.manualAction(v.task_id,v.action,v.revision);
  }},
  manage_reviews:{description:'安排首次独立审查、准备已有结论后的改派/撤回确认卡片、生成返工交接。报告由独立审查者本人回传；改派和撤回须用户在首页确认。',schema:envelope(z.discriminatedUnion('action',[
    action('assign',{data:reviewOrderInput}),action('revoke',{review_id:key,run_id:key,revision:version,reason:text.min(5).max(2000)}),
    action('return_to_executor',{run_id:key,revision:version})
  ])),asynchronous:v=>v.action==='return_to_executor'||v.action==='assign',execute:({wb},v)=>{
    if(v.action==='assign'){
      try{assertMayArrangeReview(wb,v.data.run_id,{role:'planner',id:'manager'})}
      catch(e){if(e instanceof DomainError&&e.status===403)return prepareDecision(wb,'assign',v);throw e}
      return exportReviewOrder(wb,v.data,{role:'planner',id:'manager'});
    }
    if(v.action==='revoke')return prepareDecision(wb,'revoke',v);
    return reviewFeedbackOrder(wb,v.run_id,v.revision);
  }},
  manage_memories:{description:'保存项目决定、已知问题、失败经验或交接记忆；可确认用户提供的事实，supersedes 用于替代旧记忆，保留来源。',schema:envelope(z.object({project_id:key,kind:z.enum(['decision','known_issue','failed_attempt','handoff']),content:text,status:z.enum(['candidate','confirmed']),source_id:key,supersedes:key.optional(),scope:text.max(100).default('project')}).strict()),execute:({wb},v)=>wb.memory(v)},
  link_execution_session:{description:'按用户要求把已采集的真实会话关联到指定执行记录。',schema:envelope(z.object({session_id:key,run_id:key}).strict()),execute:({wb},v)=>wb.linkSession(v.session_id,v.run_id)},
  refresh_integration:{description:'刷新 Token Monitor 或 AgentsView；返回实际连接结果。',schema:envelope(z.object({integration_id:z.enum(['tokenMonitor','agentsView']),cursor:z.string().max(1000).default('')}).strict()),asynchronous:true,execute:async({wb,services},v)=>{await services.integrations.refresh(v.integration_id,v.cursor);const {snapshot,...status}=wb.get('integrations',v.integration_id);return status}},
  manage_settings:{description:'授权用户指定的准确项目文件夹，或配置本机数据源地址及密钥引用。不会修改全局 Agent 配置。',schema:envelope(z.discriminatedUnion('action',[
    action('authorize_root',{path:text.max(1000)}),action('configure_integration',{integration_id:z.enum(['tokenMonitor','agentsView']),base_url:z.string().max(1000),secret_env:z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/).nullable().optional(),secret_file:z.string().max(1000).nullable().optional()})
  ])),asynchronous:true,execute:({wb},v)=>{
    if(v.action==='authorize_root')return addAuthorizedRoot(wb.config,v.path);
    if(v.base_url){const url=new URL(v.base_url);assert(['http:','https:'].includes(url.protocol)&&['127.0.0.1','localhost','[::1]'].includes(url.hostname)&&!url.username&&!url.password&&!url.search&&!url.hash,'数据源需要本机服务地址');}
    if(v.secret_file){const file=safePath(path.resolve(wb.config.root,v.secret_file),[wb.config.dataDir]);assert(!path.relative(wb.config.dataDir,file).split(/[\\/]/).some(p=>/^(keys\.json|run-keys|review-keys|workbench\.sqlite(?:-wal|-shm)?)$/i.test(p)),'请选择数据源自己的连接密钥文件');}
    const file=path.join(wb.config.root,'config/local.json'),raw=fs.existsSync(file)?JSON.parse(fs.readFileSync(file,'utf8')):{};
    const current=raw.integrations?.[v.integration_id]||wb.config.integrations[v.integration_id as 'tokenMonitor'|'agentsView'];
    const next={...current,baseUrl:v.base_url,...(v.secret_env!==undefined?{secretEnv:v.secret_env||undefined}:{}),...(v.secret_file!==undefined?{secretFile:v.secret_file||undefined}:{})};
    atomicWrite(file,JSON.stringify({...raw,integrations:{...raw.integrations,[v.integration_id]:next}},null,2));
    // Keep active readers on their original configuration until restart. Mixing an
    // old in-flight SSE/HTTP response with a newly saved source would mislabel data.
    return {integration_id:v.integration_id,base_url:next.baseUrl,saved:true,restart_required:true,next:'已保存；从托盘退出并重新打开工作台后使用新连接设置。'};
  }},
  create_workbench_backup:{description:'按用户要求备份本机工作台账本和执行包，返回实际备份位置。',schema:envelope(z.object({}).strict()),asynchronous:true,execute:({wb})=>createBackup(wb)},
  open_workbench_folder:{description:'直接打开项目文件夹或定位成果原件/归档文件，免去用户找目录。',schema:envelope(z.discriminatedUnion('action',[
    action('project',{project_id:key}),action('artifact',{artifact_id:key,target:z.enum(['original','archive'])})
  ])),asynchronous:true,execute:({wb,services},v)=>v.action==='project'?services.openProject(v.project_id):openArtifactFolder(wb,v.artifact_id,v.target,services.revealArtifact)}
};

export const managementContextInput=z.object({section:z.enum(['all','projects','requests','resources','tasks','memories','integrations']).default('all'),project_id:key.optional(),task_id:key.optional()}).strict();
export function managementContext(wb:Workbench,input:unknown){
  const v=managementContextInput.parse(input),s=wb.snapshot();
  const groups:Record<string,string[]>={projects:['projects','authorized_roots'],requests:['requests','projects'],resources:['agents','agent_presets','model_catalog','accounts','subscriptions','quota_definitions','quota_sources','quota_pools','quota_windows'],tasks:['tasks','projects','user_decisions'],memories:['memories','projects'],integrations:['integrations']};
  const fields=v.section==='all'?[...new Set(Object.values(groups).flat())]:groups[v.section];
  const out:Row={server_time:s.server_time,timezone:s.timezone,mode:'manager',tools:Object.keys(managementTools)};
  for(const k of fields)out[k]=s[k];
  if(v.section==='resources'||v.section==='all')out.quota_cache=wb.all('quota_cache');
  if(v.section==='integrations'||v.section==='all'){
    const file=path.join(wb.config.root,'config/local.json'),saved=fs.existsSync(file)?JSON.parse(fs.readFileSync(file,'utf8')).integrations||{}:{};
    out.connection_settings=Object.fromEntries(Object.entries(wb.config.integrations).map(([id,active])=>{const c=saved[id]||active;return [id,{base_url:c.baseUrl,active_base_url:active.baseUrl,secret_env:c.secretEnv||null,secret_file:c.secretFile||null,managed:!!c.managed,restart_required:JSON.stringify(c)!==JSON.stringify(active)}]}));
  }
  if(v.project_id){wb.get('projects',v.project_id);for(const k of ['requests','tasks','memories','user_decisions'])if(out[k])out[k]=out[k].filter((r:Row)=>r.project_id===v.project_id);if(out.projects)out.projects=out.projects.filter((p:Row)=>p.id===v.project_id)}
  if(v.task_id){const detail=wb.taskDetail(v.task_id);assert(!v.project_id||detail.task.project_id===v.project_id,'任务不属于所选项目',409);out.task_detail=detail}
  return out;
}
export const managementResultInput=z.object({request_id:z.string().uuid()}).strict();
export const artifactReadInput=z.object({artifact_id:key}).strict();
export const managementReadTools={
  get_management_context:{description:'读取可管理项目、需求、团队、额度、订阅、任务和当前版本；修改前先读取。',schema:managementContextInput},
  get_management_result:{description:'按操作编号查询是否已保存、失败或中断；重试前核对，避免重复操作。',schema:managementResultInput},
  get_task_detail:{description:'读取任务、执行、问题回答、产物与审查完整记录。',schema:z.object({task_id:key}).strict()},
  get_planning_entry:{description:'读取指定需求当前版本及规划指令。',schema:z.object({request_id:key}).strict()},
  search_external_history:{description:'通过 AgentsView 搜索外部会话，返回真实来源和连接状态；source_project 为上游项目名。',schema:z.object({query:z.string().trim().min(1).max(200),source_project:key.optional(),agent:key.optional(),from:key.optional(),to:key.optional(),cursor:z.number().int().min(0).optional()}).strict()},
  get_session_messages:{description:'分页读取已登记会话消息。',schema:z.object({session_id:key,from:z.number().int().min(0).default(0)}).strict()},
  read_artifact:{description:'读取已登记成果，校验归档内容；按成果编号读取。',schema:artifactReadInput}
};
export async function readManagement(wb:Workbench,services:ManagementServices,name:string,input:unknown){
  const definition=managementReadTools[name as keyof typeof managementReadTools];assert(definition,'读取工具不存在',404);const v=definition.schema.parse(input) as Row;
  if(name==='get_management_context')return managementContext(wb,v);
  if(name==='get_management_result'){const call=wb.get('management_calls',v.request_id);return call.decision_id?{...call,...decisionReceipt(wb,wb.get('user_decisions',call.decision_id))}:call}
  if(name==='get_task_detail')return wb.taskDetail(v.task_id);
  if(name==='get_planning_entry')return wb.planningEntry(v.request_id);
  if(name==='search_external_history')return services.integrations.search(v);
  if(name==='get_session_messages')return services.integrations.sessionPage(v.session_id,v.from);
  return readManagedArtifact(wb,v);
}
export function readManagedArtifact(wb:Workbench,input:unknown){const v=artifactReadInput.parse(input),a=wb.get('artifacts',v.artifact_id),bytes=readBounded(artifactFile(wb,a.id,'archive'),20*1024*1024);assert(hash(bytes)===a.sha256,'成果内容校验失败',409);const isText=/^\.(md|txt|json|csv|log|diff|patch|html|htm)$/.test(a.extension);return {artifact:a,encoding:isText?'utf8':'base64',content:bytes.toString(isText?'utf8':'base64')}}

/** Sync writes and their receipt commit together; interrupted async calls stay visibly pending. */
export async function manage(wb:Workbench,services:ManagementServices,name:string,input:unknown){
  assert(name!=='import_execution_receipt','执行回报请使用本 Run 的独立连接；远程回执由用户在页面导入',403);
  assert(name!=='import_grok_review_for_user'&&!(name==='manage_reviews'&&['record','import_result'].includes((input as Row)?.change?.action)),'管理连接不能代写或导入审查结论，请由独立审查者回传',403);
  const tool=managementTools[name];assert(tool,'管理工具不存在',404);const v=tool.schema.parse(input),digest=hash(JSON.stringify({tool:name,input:v}));
  const old=wb.maybe('management_calls',v.request_id);
  if(old){assert(old.policy_version===2||!['manage_reviews','manage_tasks'].includes(name),'旧权限版本的操作回执仅供历史查看，请读取当前状态并使用新操作编号',409);assert(old.digest===digest,'同一操作编号对应不同内容，请使用新的 request_id',409);if(old.decision_id)return decisionReceipt(wb,wb.get('user_decisions',old.decision_id));assert(old.status==='completed',old.status==='failed'?'上次操作失败，请查看错误后使用新操作编号重试':'上次操作仍在处理或曾中断，请先核对结果',409);return old.result}
  const context={request_id:v.request_id,tool:name,user_instruction:v.user_instruction};
  const record:Row={id:v.request_id,digest,...context,status:'pending',policy_version:2,created_at:now()};
  const finish=(value:any)=>{const waiting=value?.status==='awaiting_user_confirmation',result=waiting?value:{request_id:v.request_id,status:'completed',result:value??null};wb.put('management_calls',{...record,status:result.status,completed_at:waiting?null:now(),decision_id:waiting?value.result.decision_id:undefined,result});wb.audit('manager',name,v.request_id,{status:result.status});return result};
  const external=typeof tool.asynchronous==='function'?tool.asynchronous(v.change):tool.asynchronous;
  if(!external)return wb.managementContext.run(context,()=>wb.transaction(()=>finish(tool.execute({wb,services},v.change))));
  wb.transaction(()=>wb.put('management_calls',record));
  return wb.managementContext.run(context,async()=>{
    try{const result=await tool.execute({wb,services},v.change);return wb.transaction(()=>finish(result))}
    catch(e){wb.transaction(()=>{wb.put('management_calls',{...record,status:'failed',ended_at:now(),error:e instanceof DomainError?e.message:'操作未完成，请核对本机服务和记录'});wb.audit('manager',name,v.request_id,{status:'failed'})});throw e}
  });
}
