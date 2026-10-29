import fs from 'node:fs';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {z} from 'zod';
import type {Workbench} from './workbench.ts';
import {previewCodexMcpSetup,type CodexMcpSetupOptions} from './codex-mcp-setup.ts';
import {currentMachineId,listOnboardingTeam} from './onboarding-models.ts';
import {getOnboardingDiagnostics} from './onboarding-diagnostics.ts';
import {assert} from './security.ts';

export const onboardingConnectionInput=z.object({}).strict();
type ClientConnection={instance?:string;client?:string;version?:string};
function setupOptions(wb:Workbench,overrides:Partial<CodexMcpSetupOptions>={}){
  const bundled=path.join(wb.config.root,'桌面版/工作台/resources/runtime/node.exe');
  return {root:wb.config.root,nodePath:fs.existsSync(bundled)?bundled:process.execPath,...overrides};
}
function preview(wb:Workbench,overrides:Partial<CodexMcpSetupOptions>={}){return previewCodexMcpSetup(setupOptions(wb,overrides));}
function fingerprint(p:ReturnType<typeof preview>){return createHash('sha256').update(JSON.stringify([p.configPath,p.command,p.args,p.env,p.cwd])).digest('hex');}
const receiptPath=(wb:Workbench)=>path.join(wb.config.dataDir,'onboarding-connection.json');
function receipt(wb:Workbench){try{return JSON.parse(fs.readFileSync(receiptPath(wb),'utf8'));}catch{return null;}}

// Records a Codex MCP handshake and tool call. Client identity is reported by MCP,
// not a cryptographic identity assertion and not proof of a desktop UI session.
export function verifyWorkbenchConnection(wb:Workbench,input:unknown,connection:ClientConnection,overrides:Partial<CodexMcpSetupOptions>={}){
  onboardingConnectionInput.parse(input);
  assert(z.string().uuid().safeParse(connection.instance).success,'必须通过新建的工作台 MCP 连接调用');
  assert(typeof connection.client==='string'&&/^codex(?:$|[-_ /])/i.test(connection.client),'必须由目标 Codex 的 MCP 客户端调用；本地管理脚本不能代替新会话验证');
  const p=preview(wb,overrides);assert(p.state==='current','目标 Codex 配置尚未正确写入');
  const result={schema:1,machine_id:currentMachineId(),root:wb.config.root,config_path:p.configPath,configuration:fingerprint(p),client:connection.client.slice(0,200),client_version:connection.version?.slice(0,100)||'unknown',instance:connection.instance,connected_at:new Date().toISOString(),connection_status:'connected',evidence:'MCP initialize + verify_workbench_connection',tools:['get_chat_planning_context','submit_task_plan','get_onboarding_context']};
  const file=receiptPath(wb),tmp=file+'.'+randomUUID()+'.tmp';fs.writeFileSync(tmp,JSON.stringify(result,null,2),{flag:'wx',mode:0o600});fs.renameSync(tmp,file);
  wb.audit('mcp:'+result.client,'verify_workbench_connection',result.instance!,{client:result.client,configuration:result.configuration});
  return result;
}

export function getOnboardingContext(wb:Workbench,overrides:Partial<CodexMcpSetupOptions>={}){
  let mcp:any,command:string;
  try{const p=preview(wb,overrides),r=receipt(wb),connected=p.state==='current'&&r?.machine_id===currentMachineId()&&r?.configuration===fingerprint(p);
    mcp={status:p.state,config_path:p.configPath,connection_status:connected?'connected':'not_verified',...(connected?{connected_at:r.connected_at,client:r.client}:{}),detail:connected?`已由 ${r.client} 完成 MCP 握手和工具调用；连通记录不代表所有模型可调用。`:'写入配置后，需要目标 Codex 新会话实际加载并调用工作台 MCP。'};command=p.installCommand;
  }catch{mcp={status:'repair_needed',connection_status:'not_verified',detail:'接入文件或配置格式需要修复；未修改配置。'};command='先检查本工作台 scripts/setup-codex-mcp.ts 和内置 Node 是否完整；用脚本 --help 查看接入方式，不覆盖其他配置。';}
  const team=listOnboardingTeam(wb),checks=getOnboardingDiagnostics(wb).records;
  const prompt=[
    '请为当前电脑完成 Agent 工作台首次接入与核对，并保存真实结果。',
    `工作台安装目录：${wb.config.root}`,
    '全程跳过 Claude / Claude Code / Anthropic：不发现、不读取其配置或认证、不执行版本/帮助/模型探测、不安装、不调用；保留已有历史。其他客户端也不能选择 Claude/Anthropic 模型或未知默认路由。',
    '1. 将工作台 MCP 持久接入正在使用的 Codex。确认目标 Codex 的 CODEX_HOME/配置位置；下面命令使用当前工作台可见的配置位置，若目标不同，显式指定 --config。脚本只更新 agent_workbench 连接并保留完整备份，不更改供应商、模型或其他 MCP。',
    command,
    '2. 配置写入仅表示已配置。重连 MCP 或启动同一配置下的全新 Codex 会话，实际列出并调用 get_onboarding_context，再调用 verify_workbench_connection。现有会话的终端转接、配置文件存在或进程启动都不能代替这项验证；连通前如需使用 scripts/workbench.ts，只记录为临时引导，未验证项保持未知。不要另建账本。',
    '3. 先读取团队中用户登记的常用型号，规划和任务单优先使用这些精确 ID。通过 refresh_onboarding_models 核对非 Claude 客户端的模型参考目录；列出来不代表当前账号可用，不能自动把整份枚举灌入团队选项。记录精确 ID、provider、版本、本机与时间，不从展示名猜型号。用户新指定型号用 manage_agents 保存团队列表；record_onboarding_models 仅保存有来源的观察资料，不能伪造 invocation_verified。',
    `本机登记标识：${team.machine_id}`,
    '4. 核对当前选定审查 Agent 的调用：先读团队的原生型号记录，明确选定一个非 Claude 模型（Harness 同时选 provider），用 run_onboarding_diagnostic 执行一次固定的短文本诊断，request_id 使用新 UUID。仅对选定路由调用一次，不批量试所有型号，不自动重试、不切换供应商或付费档位；重复读取使用原 request_id。没有选定路由则先汇报候选与未知项。',
    '5. 汇报已配置、实际 MCP 连通、模型来源、诊断成功/失败/未知和 Claude 已跳过。诊断只证明该路由本次调用，不替代独立业务审查和用户验收。'
  ].join('\n\n');
  return {prompt,mcp,machine_id:team.machine_id,team:{checked_at:team.agents.map(a=>a.observed_at).filter(Boolean).sort().at(-1),agents:team.agents.map(a=>({...a,id:a.agent_id,detail:a.reason,models:a.models.map((m:any)=>({...m,name:m.name||m.id}))}))},diagnostics:checks.map(r=>({id:r.request_id,agent_name:team.agents.find(a=>a.agent_id===r.agent_id)?.name||r.agent_id,model:r.model,status:r.status,checked_at:r.finished_at||r.started_at,reason:r.reason,actual_model:r.actual_model})),exclusions:['claude']};
}
