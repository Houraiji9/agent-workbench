import {chatContextInput} from '../core/chat-planning.ts';
import {nativeReviewRecoveryInput} from '../core/native-review-recovery.ts';
import {delegationInput,delegationReportInput} from '../core/workflow-policy.ts';
import {agentDispatchInput,agentJobInput} from '../core/agent-route-schema.ts';
import {runContextReadInput} from '../core/execution-context.ts';
import {reviewContextInput as reviewDeltaInput,reviewContextAckInput,reviewContextReadInput} from '../core/review-context.ts';
import {contextInput,contextAckInput,activityInput,waitInput,finishInput} from '../core/execution-context.ts';
import {deploymentInput} from '../core/runtime-delivery.ts';
import {deploymentContextInput,deploymentReceiptInput} from '../core/deployment-evidence.ts';
import {managementTools,managementReadTools} from '../core/management.ts';
import {sessionManagementWrites,sessionManagementReads} from '../core/session-management.ts';
import {reviewReportInput} from '../core/review-submission.ts';
import {reviewHandoffInput} from '../core/review-workflow.ts';
import {closeoutInput,closeoutOrderInput} from '../core/closeout.ts';
import {reviewScopeInput,reviewStartInput,reviewResultInput,reviewOrderInput,reviewId} from '../core/review-workflow.ts';
import {reviewContextInput,reviewSessionInput} from '../core/review-evidence.ts';
import {diagramInput} from '../integrations/archify.ts';
import {McpServer} from '@modelcontextprotocol/sdk/server/mcp.js';
import {StdioServerTransport} from '@modelcontextprotocol/sdk/server/stdio.js';
import {z} from 'zod';
import fs from 'node:fs';
import path from 'node:path';
import {loadConfig} from '../core/config.ts';
import {planSchema,eventSchema} from '../core/schema.ts';
const configuredRole=process.env.WORKBENCH_ROLE;
if(configuredRole&&!['manager','planner','chat_planner'].includes(configuredRole))throw Error('WORKBENCH_ROLE 仅支持 manager、planner 或 chat_planner');
const c=loadConfig(),runner=process.env.WORKBENCH_RUN_ID,reviewer=process.env.WORKBENCH_REVIEW_ID;
if(configuredRole&&(runner||reviewer))throw Error('管理/规划模式与独立执行/审查模式不能同时设置');
const chatPlanner=configuredRole==='chat_planner';
const manager=!runner&&!reviewer&&!chatPlanner&&configuredRole!=='planner';
if(reviewer){reviewId.parse(reviewer);if(runner)throw Error('执行与审查模式只能选择一种')}
if(runner&&!/^R-[a-f0-9-]{36}$/.test(runner))throw new Error('WORKBENCH_RUN_ID 格式无效');
const credentials=JSON.parse(fs.readFileSync(path.join(c.dataDir,reviewer?'review-keys/'+reviewer+'.json':runner?'run-keys/'+runner+'.json':'keys.json'),'utf8'));
const token=reviewer||runner?credentials.token:manager?credentials.manager:chatPlanner?credentials.chat_planner:credentials.planner;
if(!token)throw Error('工作台后台需要升级：请从托盘退出并重新打开工作台，然后重连 MCP。');
const server=new McpServer({name:'agent-workbench',version:'0.1.0'},{instructions:'工作台记录项目流转，模型负责理解用户要求。当前执行或审查会话可直接办理本项目管理：先读 get_management_context 获取版本，用 request_id 幂等、user_instruction 记录用户原话；历史保留实际办理者。审查成员、模型和任务补充可在同任务修改，无须新开关联单或让用户重复转述。主执行启动仍由用户控制；本人获直接做授权可接单；执行者可直接调用独立审查和获准子代理。审查者用 submit_review_report 回传本人结论。多人意见分别保留，负责人记录继续、返修或补审决定。用户最终验收仍由用户确认，不能代填他人报告。按需读取 brief/delta，缺失时补读必要资料，不重复读取全项目。'});
const call=async(name:string,input:any)=>{if(runner)input={...input,run_id:runner};if(reviewer)input={...input,review_id:reviewer};try{const res=await fetch(`http://127.0.0.1:${c.port}/api/mcp/${name}`,{method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json',...(runner&&process.env.WORKBENCH_EXECUTION_JOB_ID&&process.env.WORKBENCH_EXECUTION_JOB_TOKEN?{'x-workbench-execution-job-id':process.env.WORKBENCH_EXECUTION_JOB_ID,'x-workbench-execution-job-token':process.env.WORKBENCH_EXECUTION_JOB_TOKEN}:{})},body:JSON.stringify(input),signal:AbortSignal.timeout(['submit_grok_review','create_workbench_backup','refresh_integration'].includes(name)?120000:name==='create_project_diagram'?100000:['wait_run_update','get_agent_job'].includes(name)?40000:['get_dispatch_context','get_agent_clients','get_review_candidates'].includes(name)?120000:15000)});const data=await res.json();return {content:[{type:'text' as const,text:JSON.stringify(data,null,2)}],isError:!res.ok}}catch(error){console.error('工作台 MCP 请求失败：',(error as Error).message);return {content:[{type:'text' as const,text:'后台不可用，请先启动工作台；没有创建第二份账本。'}],isError:true}}};
function register(name:string,description:string,schema:z.ZodRawShape){server.tool(name,description,schema,async input=>call(name,input))}
if(!manager&&!runner&&!reviewer&&!chatPlanner){const tool=managementReadTools.get_project_memories;register('get_project_memories',tool.description,tool.schema.shape)}
if(manager){for(const [name,tool] of Object.entries({...managementTools,...managementReadTools}))register(name,tool.description,tool.schema.shape)}
if(runner||reviewer){for(const [name,tool] of Object.entries({...managementTools,...managementReadTools}))if([...sessionManagementWrites,...sessionManagementReads].includes(name))register(name,tool.description,tool.schema.shape)}
if(chatPlanner){register('get_chat_planning_context','读取一条需求的脱敏精简规划包，不调用模型和执行者',chatContextInput.shape);register('submit_task_plan','提交真实聊天模型编写的计划，只登记不执行',planSchema.shape)}else if(reviewer){
register('get_review_assignment','读取本审查单精简或同会话增量上下文；缺失时重建brief，不重复全量读取。',reviewDeltaInput.shape);
register('ack_review_context','确认本次审查上下文版本，不代表模型已理解全部源码',reviewContextAckInput.shape);
register('read_review_context_file','在本审查合同内按范围和预算读取文件',reviewContextReadInput.shape);
register('report_review_started','独立审查者接单，限当前审查单',reviewStartInput.shape);
register('submit_review_result','附完整报告并更新审查状态，返回给执行者的说明；不代用户验收',reviewResultInput.shape);
register('submit_review_report','直接提交本人结论和报告；任务、执行和交付版本由本审查单自动绑定',reviewReportInput.shape);
}else{
register('recover_native_review','从工作台已保存的独立调用补登记原报告；只收调用编号，不接收作者填写的结论或文件',nativeReviewRecoveryInput.shape);
register('dispatch_review','按已规划路由直接调用独立审查；不需要用户转发，不代写审查结论',agentDispatchInput.shape);
register('continue_run','当前执行会话直接续接返修或收尾，不启动另一执行者；保留旧交付，管理者启动规则不变',agentDispatchInput.shape);
register('get_agent_job','等待或查询本执行的客户端调用状态；终态不等于审查通过',agentJobInput.shape);
register('read_run_context_file','在本执行阅读合同内按片段和预算读取资料',runContextReadInput.shape);
register('get_run_context','读取当前Run的简版/增量上下文；只有缺失时读取full。',contextInput.shape);
register('get_closeout_context','读取本次收尾清单、审查报告、状态与下一个回报序号',closeoutInput.shape);
register('export_closeout_order','生成给原执行者的收尾单；完成逐项收尾后才进入用户验收',closeoutOrderInput.shape);
register('get_review_candidates','查询该任务的独立审查候选、当前额度和选择限制',{task_id:z.string(),run_id:z.string().optional()});
register('export_review_order','尚无有效审查结论时指定或更换审查者，生成真实审查单；自动派审使用 dispatch_review，只有手动模式才转交入口。已有结论后的改派或补审由用户入口决定；需要修改时新开 Run 返工。',reviewOrderInput.shape);
register('get_review_context','读取当前交付版本及独立审查要求；审查前必须获取，不能用旧摘要替代。',reviewContextInput.shape);
register('submit_grok_review','登记实际 Grok 会话：工作台从官方 CLI 核验身份、完成状态、Task/Run 和交付摘要，只接受会话编号。已有结论时仅允许原结果幂等重试，新结论需用户安排。通过后进入执行者收尾。',reviewSessionInput.shape);
register('get_run_feedback','查询指定执行的问题及用户保存的回答；执行者凭据仅可查询自己。不能把查询或回答视为已恢复执行。',{run_id:z.string().regex(/^R-[a-f0-9-]{36}$/)});
if(!runner){register('get_chat_planning_context','读取小需求聊天规划资料和返回格式',chatContextInput.shape);register('get_agent_clients','仅向规划大脑提供本机自动发现的能力摘要，不返回安装路径',{});register('dispatch_run','兼容入口：MCP Agent无权启动外部主执行，请导出执行单交用户启动',agentDispatchInput.shape);register('create_project_diagram','使用官方 Archify 本地渲染项目图解。省略 candidate 时生成真实任务总览；提供 candidate 时按官方 schema 校验。不会改变任务状态。',diagramInput.shape);register('get_dispatch_context','默认读取精简调度上下文，detail=full时按需展开。',{project_id:z.string().optional(),detail:z.enum(['brief','full']).default('brief')});register('get_project_context','按项目 ID 恢复上下文',{project_id:z.string(),detail:z.enum(['brief','full']).default('brief')});register('get_project_graph','读取真实依赖、返工或会话关联，未关联保持未知。',{project_id:z.string(),view:z.enum(['tasks','execution','sessions']).default('tasks'),include_history:z.boolean().default(true)});register('search_execution_history','范围内检索任务及会话摘要，返回来源',{kind:z.enum(['all','task','session']).optional(),query:z.string().max(200).optional(),project_id:z.string().optional(),agent:z.string().optional(),status:z.string().optional(),from:z.string().optional(),to:z.string().optional(),limit:z.number().int().min(1).max(100).optional()});register('submit_task_plan','提交模型编写的结构化计划，原子校验职责、依赖、授权路径和零新增费用',planSchema.shape);register('export_execution_order','生成真实落盘执行包；重复调用返回同一 Run，new_run 明确重试',{task_id:z.string(),expected_version:z.number().int(),new_run:z.boolean().optional(),agent_id:z.string().optional(),expected_revision:z.number().int().optional(),requested_model:z.string().max(100).nullable().optional()})}
if(runner){register('register_delegation','登记本Run子代理范围和预算；型号仅作可选建议，由Agent自行选择，登记不等于启动',delegationInput.shape);register('report_delegation','回报本Run子代理的真实会话和成果；型号可不披露，按已提供信息记录，不冒充独立审查',delegationReportInput.shape);register('wait_run_update','等待当前Run有新状态再返回，避免反复读完整上下文；不是后台唤醒。',waitInput.shape);register('complete_run_closeout','执行者提交真实逐项结果，程序合并收尾接单与完成回报，不代用户验收。',finishInput.shape);register('ack_run_context','确认本次已读上下文，可绑定实际原生会话ID。',contextAckInput.shape);register('report_run_activity','简洁回报：程序负责身份、cwd、版本、序号，event_id用于幂等。',activityInput.shape);register('report_runtime_deployment','独立审查后校验本机安装与受审清单匹配。',deploymentInput.shape);register('report_review_handoff','直接调用审查 CLI 失败时记录原因并交当前执行者或规划者处理；不能代写审查结论',reviewHandoffInput.shape);register('report_run_event','上报当前执行的接单、进展、等待、阻塞、失败或交付',eventSchema.shape);register('submit_run_result','提交真实结果与产物；按用户选择进入待独立审查或待执行收尾，不能自行验收',eventSchema.shape);
}
}
if(runner){
register('get_deployment_context','读取当前受审版本的部署目标与回执模板；不连接部署目标',deploymentContextInput.shape);
register('report_deployment_evidence','执行者回报实际部署、健康和回滚证据；仅核对绑定，不冒充工作台主动核验',deploymentReceiptInput.shape);
}
await server.connect(new StdioServerTransport());
