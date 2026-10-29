import {z} from 'zod';import {zodToJsonSchema} from 'zod-to-json-schema';
import {contextInput,activityInput,runContextReadInput,finishInput,waitInput} from '../src/core/execution-context.ts';
import {closeoutInput} from '../src/core/closeout.ts';import {delegationInput,delegationReportInput} from '../src/core/workflow-policy.ts';
import {agentDispatchInput,agentJobInput} from '../src/core/agent-route-schema.ts';import {deploymentInput} from '../src/core/runtime-delivery.ts';
import {deploymentContextInput,deploymentReceiptInput} from '../src/core/deployment-evidence.ts';
import {managementTools,managementReadTools} from '../src/core/management.ts';
export const CLI_SCHEMA_VERSION=1;
export const CLI_EXAMPLE_RUN='R-00000000-0000-4000-8000-000000000001';
export const cliDefinitions:Record<string,{tool:string;schema:z.ZodTypeAny;example:Record<string,any>}>={
 context:{tool:'get_run_context',schema:contextInput,example:{mode:'brief'}},read:{tool:'read_run_context_file',schema:runContextReadInput,example:{path:'RUN.md',reason:'读取当前执行范围'}},
 report:{tool:'report_run_activity',schema:activityInput,example:{event_id:'progress-example-1',event_type:'progress',data:{message:'已完成相关检查，证据待归档'}}},
 closeout:{tool:'complete_run_closeout',schema:finishInput,example:{event_id:'closeout-example-1',result:'已完成本轮范围内修复与相关验证，未代用户验收。',closeout_results:[{item_id:'C1',outcome:'done',evidence:'填写实际验证证据与限制'}]}},
 'closeout-context':{tool:'get_closeout_context',schema:closeoutInput,example:{detail:'brief'}},
 'register-delegation':{tool:'register_delegation',schema:delegationInput,example:{request_id:'00000000-0000-4000-8000-000000000002',goal:'实现已授权范围内的隔离测试',required_files:[],allowed_paths:['./tests'],output_dir:'./tests',context_bytes:4096}},
 'report-delegation':{tool:'report_delegation',schema:delegationReportInput,example:{delegation_id:'填写登记回执ID',status:'completed',summary:'填写实际结果与限制'}},
 review:{tool:'dispatch_review',schema:agentDispatchInput,example:{request_id:'00000000-0000-4000-8000-000000000002',expected_revision:1}},
 continue:{tool:'continue_run',schema:agentDispatchInput,example:{request_id:'00000000-0000-4000-8000-000000000002',expected_revision:1}},
 job:{tool:'get_agent_job',schema:agentJobInput,example:{job_id:'AJ-00000000-0000-4000-8000-000000000003',timeout_ms:0}},
 wait:{tool:'wait_run_update',schema:waitInput,example:{after_revision:1,timeout_ms:0}},
 deployment:{tool:'report_runtime_deployment',schema:deploymentInput,example:{manifest_sha256:'a'.repeat(64)}},
 'deployment-context':{tool:'get_deployment_context',schema:deploymentContextInput,example:{}},
 'deployment-evidence':{tool:'report_deployment_evidence',schema:deploymentReceiptInput,example:{profile_sha256:'a'.repeat(64),version:'填写受审交付版本',artifact_hashes:['b'.repeat(64)],review_id:null,reported_by:'填写执行者ID',reported_at:'2026-01-01T00:00:00Z',deployment_evidence:'填写实际部署证据',health_evidence:'填写实际健康检查证据',rollback_evidence:'填写实际回滚证据',verification:'executor_reported'}}
};
export function cliDefinition(name:string){const known=cliDefinitions[name]||Object.values(cliDefinitions).find(d=>d.tool===name);if(known)return known;const managed=managementTools[name]||managementReadTools[name as keyof typeof managementReadTools];if(managed)return {tool:name,schema:managed.schema,example:{}};throw Error('未知工具或动作 '+name+'；运行 node --import tsx scripts/agent.ts help 或 schema report');}
export function cliSchema(name:string){const d=cliDefinition(name);return {schema_version:CLI_SCHEMA_VERSION,action:name,tool:d.tool,json_schema:zodToJsonSchema(d.schema,{target:'jsonSchema7'}),scope:'run_id 由命令的凭据Run发送；服务端验证并解析正式同会话续接链'};}
export function validateCliInput(name:string,input:unknown,run=CLI_EXAMPLE_RUN){const d=cliDefinition(name),v=input&&typeof input==='object'&&!Array.isArray(input)?input as Record<string,unknown>:input;const hasRun=!!(d.schema as any).shape?.run_id;const payload=v&&typeof v==='object'?{...v,...(hasRun?{run_id:run}:{}),...((['report','report_run_activity','closeout','complete_run_closeout'].includes(name))&&!('event_id' in v)?{event_id:'validate-only-generated-event'}:{}),...((name==='register-delegation'||name==='register_delegation')&&!('request_id' in v)?{request_id:'00000000-0000-4000-8000-000000000002'}:{})}:v;const parsed=d.schema.safeParse(payload);if(!parsed.success){const errors=parsed.error.issues.map(i=>({path:i.path.join('.')||'$',message:i.message}));return {schema_version:1,valid:false,submitted:false,action:name,tool:d.tool,errors,repair_command:'node --import tsx scripts/agent.ts example '+name,schema_command:'node --import tsx scripts/agent.ts schema '+name};}return {schema_version:1,valid:true,submitted:false,action:name,tool:d.tool};}
export function cliExample(name:string){return {schema_version:1,action:name,input:cliDefinition(name).example,save_as:'input.json',validate_command:'node --import tsx scripts/agent.ts validate-only '+name+' input.json',submit_command:'node --import tsx scripts/agent.ts <Run ID> '+(['read','report','closeout','register-delegation','report-delegation','deployment-evidence'].includes(name)?name:'manage '+cliDefinition(name).tool)+' input.json'};}
export const cliHelp=`用法：agent.ts <Run ID|current> <动作> [参数]
只读本地入口（不读取执行凭据、不发送请求）：
  help | bootstrap | schema <动作或工具名> | example <动作或工具名> | validate-only <动作或工具名> <JSON文件>
Run动作：context [known_hash]；context-section <plan|files|requirements|history>；read <JSON文件>；start；report <JSON文件>；register-delegation <JSON文件>；report-delegation <JSON文件>；review；continue；job <Job ID>；wait <revision>；closeout <JSON文件>；closeout-context [brief|full]；deployment <manifest_sha256>；deployment-context；deployment-evidence <JSON文件>；manage <工具名> <JSON文件>；recover-review <Job ID>；mapping。
current 读取 WORKBENCH_CREDENTIAL_RUN_ID / WORKBENCH_RUN_ID，或当前 CODEX_THREAD_ID/CODEX_SESSION_ID 的成功命令映射。续接后保留 credential_run_id，用服务端正式链解析 current_run_id；映射不授予新权限。
最小回报JSON：{"event_type":"progress","data":{"message":"填写真实进度"}}
先看 example report，再用 validate-only report input.json 校验；校验不提交。`;
