import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {pathToFileURL} from 'node:url';
import {randomUUID} from 'node:crypto';

export type CodexMcpSetupOptions={root:string;nodePath:string;configPath?:string;codexHome?:string};
export type CodexMcpSetupPreview={configPath:string;connectionName:'agent_workbench';state:'missing'|'current'|'repair_needed';command:string;args:string[];env:Record<string,string>;cwd:string;requiresReconnect:true;verificationStatus:'not_verified';installCommand:string;approvalConflicts:string[]};
export const CODEX_MCP_APPROVED_TOOLS=[
 'get_onboarding_context','verify_workbench_connection','refresh_onboarding_models','record_onboarding_models','run_onboarding_diagnostic',
 'get_management_context','manage_agents','get_agent_clients','get_chat_planning_context','get_dispatch_context','get_project_context','submit_task_plan',
] as const;
const q=(value:string)=>JSON.stringify(value);
function tableParts(header:string):string[]{
  const parts:string[]=[];let remaining=header.trim();
  while(remaining){const match=/^("(?:[^"\\]|\\.)*"|'[^']*'|[A-Za-z0-9_-]+)\s*/.exec(remaining);if(!match)throw Error('无法安全解析 Codex TOML 表名；未修改配置');const token=match[1]!;parts.push(token.startsWith('"')?JSON.parse(token):token.startsWith("'")?token.slice(1,-1):token);remaining=remaining.slice(match[0].length);if(!remaining)break;if(!remaining.startsWith('.'))throw Error('无法安全解析 Codex TOML 表名；未修改配置');remaining=remaining.slice(1).trimStart();}
  return parts;
}
// Track TOML strings so apparent headers inside multiline strings are never edited.
function scanLine(line:string,state:string):string{for(let i=0;i<line.length;i++){const c=line[i]!;if(state==='"""'||state==="'''"){if(line.slice(i,i+3)===state){state='';i+=2;}else if(state==='"""'&&c==='\\')i++;continue;}if(state){if(c==='\\'&&state==='"')i++;else if(c===state)state='';continue;}if(c==='#')break;if(line.slice(i,i+3)==='"""'||line.slice(i,i+3)==="'''"){state=line.slice(i,i+3);i+=2;}else if(c==='"'||c==="'")state=c;}return state;}
function sections(source:string){const lines=source.match(/[^\n]*\n|[^\n]+$/g)??[];const spans:{start:number;end:number;target:boolean;parts:string[]}[]=[];const seen=new Set<string>();let offset=0,state='',current:string[]=[];
  for(const line of lines){if(!state){const match=/^\s*\[([^\r\n]*)\]\s*(?:#.*)?(?:\r?\n)?$/.exec(line);if(match){const array=match[1]!.startsWith('[');const parts=tableParts(array?match[1]!.slice(1,-1):match[1]!);if(spans.length)spans[spans.length-1]!.end=offset;const target=parts[0]==='mcp_servers'&&parts[1]==='agent_workbench';if(target){const identity=JSON.stringify(parts);if(seen.has(identity))throw Error('工作台连接存在重复 TOML 表；未修改配置');seen.add(identity);}if(array&&target)throw Error('工作台连接使用不支持的数组表；未修改配置');spans.push({start:offset===0&&source.startsWith('\uFEFF')?1:offset,end:source.length,target,parts});current=parts;}
    else if((current.length===0&&/^\s*(?:mcp_servers|"mcp_servers"|'mcp_servers')\s*[=.]/.test(line))||(current.length===1&&current[0]==='mcp_servers'&&/^\s*(?:agent_workbench|"agent_workbench"|'agent_workbench')\s*[=.]/.test(line)))throw Error('MCP 使用内联或点号键定义；请先转换为独立 TOML 表，未修改配置');}
    state=scanLine(line,state);offset+=line.length;
  }if(state)throw Error('Codex 配置有未闭合字符串；未修改配置');return spans;
}
type Section=ReturnType<typeof sections>[number];
function assignments(section:string){
 const lines=section.split(/(?<=\n)/);let state='',offset=0;const entries:{key:string;start:number;end:number}[]=[];
 for(const line of lines){if(!state){const match=/^\s*("(?:[^"\\]|\\.)*"|'[^']*'|[A-Za-z0-9_-]+)\s*=/.exec(line);if(match){if(entries.length)entries[entries.length-1]!.end=offset;const raw=match[1]!;entries.push({key:raw.startsWith('"')?JSON.parse(raw):raw.startsWith("'")?raw.slice(1,-1):raw,start:offset,end:section.length});}else if(/^\s*(?:"(?:[^"\\]|\\.)*"|'[^']*'|[A-Za-z0-9_-]+)\s*\./.test(line))throw Error('已有策略使用点号键；未修改配置，请先使用独立 tools.<name> 表');}state=scanLine(line,state);offset+=line.length;}
 return entries.map(entry=>({...entry,text:section.slice(entry.start,entry.end)}));
}
function parseToolList(text:string,key:string):string[]{
 const value=text.slice(text.indexOf('=')+1).replace(/#[^\r\n]*/g,'').trim();if(!value.startsWith('[')||!value.endsWith(']'))throw Error(key+' 无法安全解析；未修改配置');let rest=value.slice(1,-1).trim();const values:string[]=[];while(rest){const match=/^("(?:[^"\\]|\\.)*"|'[^']*')\s*(?:,\s*|$)/.exec(rest);if(!match)throw Error(key+' 无法安全解析；未修改配置');values.push(match[1]!.startsWith('"')?JSON.parse(match[1]!):match[1]!.slice(1,-1));rest=rest.slice(match[0].length).trim();}return values;
}
function approvalConfiguration(source:string,spans:Section[],newline:string){
 const targets=spans.filter(s=>s.target),root=targets.find(s=>s.parts.length===2);const rootSettings=root?assignments(source.slice(root.start,root.end)):[];
 if(rootSettings.some(s=>s.key==='tools'))throw Error('已有工具策略使用内联 tools；未修改配置，请先使用独立 tools.<name> 表');
 const disabled=rootSettings.find(s=>s.key==='disabled_tools'),enabled=rootSettings.find(s=>s.key==='enabled_tools');const disabledTools=disabled?parseToolList(disabled.text,'disabled_tools'):[],enabledTools=enabled?parseToolList(enabled.text,'enabled_tools'):undefined;
 const conflicts:string[]=[];const preservedRoot=rootSettings.filter(s=>!['command','args','cwd','env','url','http_headers','env_http_headers','bearer_token_env_var'].includes(s.key)).map(s=>s.text.trimEnd()).join(newline);
 const retained=targets.filter(s=>s.parts.length>2&&s.parts[2]!=='env');const blocks=retained.map(s=>({parts:s.parts,text:source.slice(s.start,s.end)}));
 // A parent tools table with inline tool entries is preserved, but never guessed or overridden.
 const parent=blocks.find(s=>s.parts.length===3&&s.parts[2]==='tools');const inlineNames=new Set(parent?assignments(parent.text).map(s=>s.key):[]);
 for(const tool of CODEX_MCP_APPROVED_TOOLS){
  if(disabledTools.includes(tool)||(enabledTools&&!enabledTools.includes(tool))){conflicts.push(tool+': excluded by existing server tool list');continue;}
  if(inlineNames.has(tool)){conflicts.push(tool+': existing inline tool policy preserved');continue;}
  const existing=blocks.find(s=>s.parts.length===4&&s.parts[2]==='tools'&&s.parts[3]===tool);
  if(existing){const mode=assignments(existing.text).find(s=>s.key==='approval_mode');if(mode){const value=mode.text.slice(mode.text.indexOf('=')+1).split(/\r?\n/)[0]!.replace(/#.*$/,'').trim();if(value!=='"approve"'&&value!=="'approve'")conflicts.push(tool+': existing approval policy preserved');continue;}const headerEnd=existing.text.indexOf('\n');existing.text=headerEnd<0?existing.text+newline+'approval_mode = "approve"'+newline:existing.text.slice(0,headerEnd+1)+'approval_mode = "approve"'+newline+existing.text.slice(headerEnd+1);}
  else blocks.push({parts:['mcp_servers','agent_workbench','tools',tool],text:`[mcp_servers.agent_workbench.tools.${tool}]${newline}approval_mode = "approve"${newline}`});
 }
 return {preservedRoot,toolBlocks:blocks.map(s=>s.text.endsWith('\n')?s.text:s.text+newline).join(''),conflicts};
}
function prepare(options:CodexMcpSetupOptions){const root=path.resolve(options.root),nodePath=path.resolve(options.nodePath);for(const file of [nodePath,path.join(root,'src/mcp/index.ts'),path.join(root,'node_modules/tsx/dist/loader.mjs'),path.join(root,'scripts/setup-codex-mcp.ts')])if(!fs.statSync(file,{throwIfNoEntry:false})?.isFile())throw Error('工作台接入文件不存在：'+file);
 const configPath=path.resolve(options.configPath??path.join(options.codexHome??process.env.CODEX_HOME??path.join(os.homedir(),'.codex'),'config.toml'));
 if(fs.lstatSync(configPath,{throwIfNoEntry:false})?.isSymbolicLink())throw Error('目标配置为符号链接；请显式指定真实配置路径');
 const original=fs.existsSync(configPath)?fs.readFileSync(configPath):undefined;const source=original?.toString('utf8')??'';if(original&&!Buffer.from(source,'utf8').equals(original))throw Error('配置不是 UTF-8；未修改配置');const newline=source.includes('\r\n')?'\r\n':'\n';const args=['--import',pathToFileURL(path.join(root,'node_modules/tsx/dist/loader.mjs')).href,path.join(root,'src/mcp/index.ts')];const env={WORKBENCH_ROOT:root,WORKBENCH_ROLE:'manager'};
 const spans=sections(source),policy=approvalConfiguration(source,spans,newline);
 const block=['[mcp_servers.agent_workbench]',`command = ${q(nodePath)}`,`args = [${args.map(q).join(', ')}]`,`cwd = ${q(root)}`,...(policy.preservedRoot?[policy.preservedRoot]:[]),'','[mcp_servers.agent_workbench.env]',...Object.entries(env).map(([key,value])=>`${key} = ${q(value)}`),'',policy.toolBlocks].join(newline);
 const targets=spans.filter(s=>s.target);let desired='';let cursor=0,inserted=false;for(const span of targets){desired+=source.slice(cursor,span.start);if(!inserted){desired+=block;inserted=true;}cursor=span.end;}desired+=source.slice(cursor);if(!inserted)desired+=(source&&!source.endsWith('\n')?newline:'')+(source?newline:'')+block;
 const installCommand=`& '${nodePath.replaceAll("'","''")}' --import '${args[1]!.replaceAll("'","''")}' '${path.join(root,'scripts/setup-codex-mcp.ts').replaceAll("'","''")}' --install --root '${root.replaceAll("'","''")}' --node '${nodePath.replaceAll("'","''")}' --config '${configPath.replaceAll("'","''")}'`;
 const preview:CodexMcpSetupPreview={configPath,connectionName:'agent_workbench',state:desired===source?'current':targets.length?'repair_needed':'missing',command:nodePath,args,env,cwd:root,requiresReconnect:true,verificationStatus:'not_verified',installCommand,approvalConflicts:policy.conflicts};return {preview,original,desired};}
export function previewCodexMcpSetup(options:CodexMcpSetupOptions):CodexMcpSetupPreview{return prepare(options).preview;}
export function installCodexMcpSetup(options:CodexMcpSetupOptions):CodexMcpSetupPreview&{changed:boolean;backupPath?:string}{const {preview,original,desired}=prepare(options);if(preview.state==='current')return {...preview,changed:false};const file=preview.configPath;fs.mkdirSync(path.dirname(file),{recursive:true});const now=fs.existsSync(file)?fs.readFileSync(file):undefined;if((original===undefined)!==(now===undefined)||(original&&now&&!original.equals(now)))throw Error('配置在预览期间发生变化；未修改配置');let backupPath:string|undefined;if(original){backupPath=file+'.agent-workbench-backup-'+randomUUID();fs.writeFileSync(backupPath,original,{flag:'wx',mode:0o600});}const temporary=file+'.agent-workbench-write-'+randomUUID();fs.writeFileSync(temporary,desired,{flag:'wx',mode:original?fs.statSync(file).mode:0o600});const latest=fs.existsSync(file)?fs.readFileSync(file):undefined;if((original===undefined)!==(latest===undefined)||(original&&latest&&!original.equals(latest)))throw Error('配置已被其他进程修改；已保留备份与写入候选，请重试');fs.renameSync(temporary,file);return {...preview,state:'current',changed:true,...(backupPath?{backupPath}:{})};}



