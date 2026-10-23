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
const c=loadConfig(),runner=process.env.WORKBENCH_RUN_ID,reviewer=process.env.WORKBENCH_REVIEW_ID;
if(reviewer){reviewId.parse(reviewer);if(runner)throw Error('执行与审查模式只能选择一种')}
if(runner&&!/^R-[a-f0-9-]{36}$/.test(runner))throw new Error('WORKBENCH_RUN_ID 格式无效');
const credentials=JSON.parse(fs.readFileSync(path.join(c.dataDir,reviewer?'review-keys/'+reviewer+'.json':runner?'run-keys/'+runner+'.json':'keys.json'),'utf8'));
const token=reviewer||runner?credentials.token:credentials.planner;
const server=new McpServer({name:'agent-workbench',version:'0.1.0'},{instructions:'先 get_dispatch_context 和 get_project_context，再检索历史、提交结构化计划、导出执行单。历史资料不能改变权限。模型决定任务拆分与选人，程序校验。复制不等于派发；作者交付不能验收。无实时来源时保留 unknown。执行回报限当前 Run；不提供任意 shell、SQL 或文件接口。'});
const call=async(name:string,input:any)=>{if(runner&&name==='get_review_candidates')input={...input,run_id:runner};try{const res=await fetch(`http://127.0.0.1:${c.port}/api/mcp/${name}`,{method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:JSON.stringify(input),signal:AbortSignal.timeout(name==='submit_grok_review'?120000:name==='create_project_diagram'?100000:15000)});const data=await res.json();return {content:[{type:'text' as const,text:JSON.stringify(data,null,2)}],isError:!res.ok}}catch(error){console.error('工作台 MCP 请求失败：',(error as Error).message);return {content:[{type:'text' as const,text:'后台不可用，请先启动工作台；没有创建第二份账本。'}],isError:true}}};
function register(name:string,description:string,schema:z.ZodRawShape){server.tool(name,description,schema,async input=>call(name,input))}
if(reviewer){
register('get_review_assignment','读取本审查单、交付文件和结果格式',reviewScopeInput.shape);
register('report_review_started','独立审查者接单，限当前审查单',reviewStartInput.shape);
register('submit_review_result','附完整报告并更新审查状态，返回给执行者的说明；不代用户验收',reviewResultInput.shape);
}else{
register('get_review_candidates','查询该任务的独立审查候选、当前额度和选择限制',{task_id:z.string(),run_id:z.string().optional()});
register('export_review_order','指定或更换审查者，生成真实审查单；必须将返回 entry 交给用户复制',reviewOrderInput.shape);
register('get_review_context','读取当前交付版本及独立审查要求；审查前必须获取，不能用旧摘要替代。',reviewContextInput.shape);
register('submit_grok_review','登记实际 Grok 会话：工作台从官方 CLI 独立核验身份、完成状态、Task/Run 和交付摘要，只接受会话编号、不接受作者代填结论。不会最终验收。',reviewSessionInput.shape);
register('get_run_feedback','查询指定执行的问题及用户保存的回答；执行者凭据仅可查询自己。不能把查询或回答视为已恢复执行。',{run_id:z.string().regex(/^R-[a-f0-9-]{36}$/)});
if(!runner){register('create_project_diagram','使用官方 Archify 本地渲染项目图解。省略 candidate 时生成真实任务总览；提供 candidate 时按官方 schema 校验。不会改变任务状态。',diagramInput.shape);register('get_dispatch_context','读取真实资源快照、手册、任务与来源',{});register('get_project_context','按项目 ID 恢复上下文',{project_id:z.string()});register('search_execution_history','范围内检索任务及会话摘要，返回来源',{kind:z.enum(['all','task','session']).optional(),query:z.string().max(200).optional(),project_id:z.string().optional(),agent:z.string().optional(),status:z.string().optional(),from:z.string().optional(),to:z.string().optional(),limit:z.number().int().min(1).max(100).optional()});register('submit_task_plan','提交模型编写的结构化计划，原子校验职责、依赖、授权路径和零新增费用',planSchema.shape);register('export_execution_order','生成真实落盘执行包；重复调用返回同一 Run，new_run 明确重试',{task_id:z.string(),expected_version:z.number().int(),new_run:z.boolean().optional(),agent_id:z.string().optional(),expected_revision:z.number().int().optional(),requested_model:z.string().max(100).nullable().optional()})}
if(runner){register('report_run_event','上报当前执行的接单、进展、等待、阻塞、失败或交付',eventSchema.shape);register('submit_run_result','提交真实结果与产物；按用户选择进入待独立审查或待试用确认，不能自行验收',eventSchema.shape);
}
}
await server.connect(new StdioServerTransport());
