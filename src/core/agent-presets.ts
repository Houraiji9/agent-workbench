import { modelCatalog } from './model-catalog.ts';
const code=['engineering','frontend_light','review','operations'];
const office=['research','operations'];
const as_of='2026-10-21';
type Preset={id:string;name:string;region:string;category:string;scope:string;allowed_kinds:string[];sources:string[];icon_key:string;as_of:string;models:any[];existing_id?:string};
const p=(id:string,name:string,region:string,category:string,scope:string,url:string,existing_id?:string,icon_key=id):Preset=>{
 const catalog=modelCatalog.find(x=>x.agent_id===(existing_id||id));
 return {id,name,region,category,scope,allowed_kinds:category==='开发'?code:office,sources:[...new Set([url,...(catalog?.sources||[])])],icon_key,as_of:catalog?.as_of||as_of,models:catalog?.models||[],...(existing_id?{existing_id}:{})};
};
// 预设只有工具资料，不创建账号、订阅、额度或已连接状态。用户添加后成为自己的可编辑副本。
export const agentPresets:Preset[]=[
 p('codex','Codex','国际','开发','项目规划、开发、测试与代码审查','https://help.openai.com/en/articles/20001275-chatgpt-work-and-codex','codex','codex'),
 p('claude','Claude','国际','办公','内容、设计、分析与项目工作','https://code.claude.com/docs/en/overview','claude','claude'),
 p('claude-code','Claude Code','国际','开发','读取项目、实现功能、修复问题与测试','https://code.claude.com/docs/en/overview',undefined,'claude'),
 p('antigravity','Antigravity','国际','开发','项目开发、数据处理与页面设计','https://www.antigravity.google/docs/models/','antigravity','antigravity'),
 p('cursor','Cursor','国际','开发','多文件开发、重构与代码审查','https://cursor.com/docs/agent/overview','cursor'),
 p('github-copilot','GitHub Copilot','国际','开发','编程协作、项目任务与代码审查','https://docs.github.com/en/copilot/concepts/agent-capabilities/about-agents/about-github-copilot-agents'),
 p('windsurf','Devin Desktop / Windsurf','国际','开发','本地项目理解、多文件修改与 Cascade 开发任务','https://docs.devin.ai/desktop/cascade/cascade'),
 p('devin','Devin','国际','开发','工程开发、问题修复与云端任务','https://devin.ai/'),
 p('lovable','Lovable','国际','开发','通过需求描述构建应用与网站','https://lovable.dev/'),
 p('v0','v0','国际','开发','界面设计、网站与应用开发','https://v0.app/'),
 p('bolt','Bolt','国际','开发','通过对话构建网站与应用','https://bolt.new/'),
 p('kiro','Kiro','国际','开发','按需求规格开发、实现与测试','https://kiro.dev/docs/'),
 p('cline','Cline','国际','开发','项目开发、调试与自动化工作流','https://cline.bot/'),
 p('opencode','OpenCode','国际','开发','终端开发、代码编辑与测试','https://opencode.ai/docs/'),
 p('gemini-cli','Gemini CLI','国际','开发','终端开发、项目理解与自动化','https://geminicli.com/docs/get-started/installation/',undefined,'gemini'),
 p('junie','JetBrains Junie','国际','开发','IDE 内开发、维护与测试','https://www.jetbrains.com/junie/'),
 p('replit','Replit Agent','国际','开发','在云端构建应用与网站','https://replit.com/products/agent'),
 p('chatgpt','ChatGPT','国际','办公','资料研究、文档、数据分析与内容创作','https://chatgpt.com/'),
 p('gemini','Gemini 应用','国际','办公','资料研究、分析、写作与办公','https://support.google.com/gemini/answer/18648722','gemini','gemini'),
 p('grok-search','Grok 网页','国际','办公','问答、研究、事实核验与内容创作','https://grok.com/','grok-search','grok-search'),
 {...p('grok-build','Grok Build','国际','开发','独立审查其他 Agent 的代码、方案与测试','https://docs.x.ai/build/overview','grok-build','grok-build'),allowed_kinds:['review']},
 p('grok-bot','Grok Bot','国际','开发','云端任务、页面设计与开发协作','https://docs.x.ai/grok-bot/overview','grok-bot','grok-bot'),
 p('perplexity','Perplexity','国际','办公','联网研究、资料核查与多步办公任务','https://www.perplexity.ai/en-GB/products/computer'),
 p('manus','Manus','国际','办公','研究、文档与多步任务执行','https://open.manus.im/docs/v2/agents-overview'),
 p('openclaw','OpenClaw','国际','办公','个人助理与自动化工作流','https://openclaw.ai/'),
 p('zcode','Zcode','国内','开发','工程实现、脚本与开发工作流','https://zcode.z.ai/cn/docs/configuration','zcode','zcode'),
 p('deepseek','DeepSeek Harness','国内','开发','工程实现、脚本、测试与批处理','https://www.deepseek.com/harness/en/','deepseek','deepseek'),
 p('kimi','Kimi','国内','办公','长文档、研究、内容与办公任务','https://www.kimi.com/en/help/kimi-code/membership-guide','kimi','kimi'),
 p('kimi-code','Kimi Code','国内','开发','大型项目理解、开发与代码修改','https://www.kimi.com/code/docs/en/',undefined,'kimi'),
 p('workbuddy','WorkBuddy','国内','办公','办公、抓取、填报与重复工作','https://www.workbuddy.ai/','workbuddy','workbuddy'),
 p('codebuddy','CodeBuddy','国内','开发','IDE 与终端中的开发、调试与代码审查','https://www.codebuddy.ai/'),
 p('trae-cn','TRAE 国内版','国内','开发','需求拆解、项目开发与 SOLO 任务','https://docs.trae.cn/ide_what-is-trae-code'),
 p('trae','TRAE 国际版','国际','开发','项目开发与 SOLO 编程任务','https://www.trae.ai/'),
 p('qoder','Qoder','国内','开发','IDE 与终端中的工程开发和代码审查','https://docs.qoder.com/product-series/quick-start'),
 p('lingma','通义灵码','国内','开发','IDE 智能编程、单元测试与项目维护','https://lingma.aliyun.com/'),
 p('qwen-code','Qwen Code','国内','开发','终端代码开发与自动化','https://qwen.ai/qwencode'),
 p('qwen','千问','国内','办公','资料、写作、分析与日常办公','https://www.qianwen.com/'),
 p('minimax','MiniMax Agent / Code','国内','办公','办公、内容与多步任务','https://agent.minimaxi.com/download'),
 p('coze','扣子','国内','办公','工作流、办公与自定义智能体','https://www.coze.cn/open/docs/cozespace/overview'),
 p('doubao','豆包','国内','办公','写作、资料理解与日常助理','https://www.doubao.com/'),
 p('yuanbao','腾讯元宝','国内','办公','资料搜索、阅读与写作','https://yuanbao.tencent.com/'),
 p('glm','智谱清言','国内','办公','问答、研究与内容整理','https://chatglm.cn/'),
];
for(const [key,modelFrom] of [['claude-code','claude'],['kimi-code','kimi']] as const){
 const preset=agentPresets.find(p=>p.id===key)!,catalog=modelCatalog.find(g=>g.agent_id===modelFrom)!;
 preset.models=catalog.models.filter(m=>key!=='kimi-code'||m.access==='Code');
 preset.sources=[...new Set([...preset.sources,...catalog.sources])];preset.as_of=catalog.as_of;
}
