import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {installCodexMcpSetup,previewCodexMcpSetup} from '../src/core/codex-mcp-setup.ts';
const help=`工作台 Codex MCP 安装/修复（只维护 agent_workbench 连接）

用法：node --import <tsx-loader-file-url> scripts/setup-codex-mcp.ts <操作> [参数]

操作（必须且只能选择一个）：
  --help          显示帮助；不读取或修改配置
  --status        只读预览目标连接和实际安装命令
  --install       备份后安装/修复目标连接；重复执行不写入

参数：
  --root <目录>         工作台 ROOT，默认脚本所在工程
  --node <路径>         内置 Node，默认当前解释器
  --config <路径>       目标 Codex 实际使用的 config.toml，最高优先级
  --codex-home <目录>   目标 CODEX_HOME；未传时使用进程 CODEX_HOME 或用户 .codex

配置登记后需重连或开启目标新会话，实际调用 MCP 验证工具。
工作台目录与 Codex 配置目录是两个独立路径；不要从工作区位置猜目标 profile。
`;
try{
  const argv=process.argv.slice(2);
  if(argv.includes('--help')){if(argv.length!==1)throw Error('--help 需单独使用');console.log(help);}
  else{
    const allowed=new Set(['--install','--status','--root','--node','--config','--codex-home']);
    for(const arg of argv.filter(a=>a.startsWith('--')))if(!allowed.has(arg))throw Error('未知参数：'+arg);
    if(argv.includes('--install')===argv.includes('--status'))throw Error('请明确选择 --status（只读）或 --install；使用 --help 查看说明');
    const value=(key:string)=>{const i=argv.indexOf(key);if(i<0)return undefined;const result=argv[i+1];if(!result||result.startsWith('--'))throw Error(key+' 缺少值');return result;};
    const options={root:value('--root')??path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..'),nodePath:value('--node')??process.execPath,configPath:value('--config'),codexHome:value('--codex-home')};
    console.log(JSON.stringify(argv.includes('--install')?installCodexMcpSetup(options):previewCodexMcpSetup(options),null,2));
  }
}catch(error){console.error((error as Error).message);process.exitCode=1;}
