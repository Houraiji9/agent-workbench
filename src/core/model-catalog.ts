import { assert } from './security.ts';
import { isModelRetired } from '../shared/model-policy.ts';

// 产品入口与模型目录分开；日期与官方来源随目录一起交给规划者。
export type ModelChoice = { id:string; name:string; purpose:string; access?:string; retire_at?:string; kind?:'mode' };
export type ModelGroup = { agent_id:string; as_of:string; sources:string[]; models:ModelChoice[] };
const m=(id:string,name:string,purpose:string,access?:string):ModelChoice=>({id,name,purpose,...(access?{access}:{})});
const group=(agent_id:string,sources:string[],models:ModelChoice[]):ModelGroup=>({agent_id,as_of:'2026-10-21',sources,models});
export const modelCatalog:ModelGroup[] = [
  group('codex',['https://help.openai.com/en/articles/20001275-chatgpt-work-and-codex'],[
    m('gpt-6.1-sol','GPT-6.1 Sol','日常开发与工程实现'),m('gpt-6-astra','GPT-6 Astra','复杂架构、推理与疑难排查'),m('gpt-6-sol','GPT-6 Sol','通用工程与维护'),m('gpt-6-luna','GPT-6 Luna','快速小任务'),
    m('gpt-5.6-sol','GPT-5.6 Sol','旧版通用开发','当前客户端仍可选'),m('gpt-5.6-terra','GPT-5.6 Terra','旧版常规任务','当前客户端仍可选'),m('gpt-5.6-luna','GPT-5.6 Luna','旧版快速任务','当前客户端仍可选')]),
  group('zcode',['https://zcode.z.ai/cn/docs/configuration'],[m('GLM-5.3','GLM-5.3','复杂工程、长任务'),m('GLM-5.3-Flash','GLM-5.3-Flash','快速开发与截图理解')]),
  group('claude',['https://platform.claude.com/docs/en/models/overview','https://code.claude.com/docs/en/model-config'],[
    m('claude-fable-5-1','Claude Fable 5.1','高难度推理、长程任务','按账号开放情况选择'),m('claude-opus-5-5','Claude Opus 5.5','复杂开发、设计与深度分析'),m('claude-sonnet-5-5','Claude Sonnet 5.5','日常开发与内容处理'),m('claude-haiku-5-5','Claude Haiku 5.5','快速整理、分类与小任务')]),
  group('antigravity',['https://www.antigravity.google/docs/models/'],[
    m('Gemini 4 Argon','Gemini 4 Argon','复杂工程与多步任务','Pro / Ultra；App、CLI、IDE 扩展'),m('Gemini 3.8 Flash','Gemini 3.8 Flash','快速开发与日常处理'),m('Claude Sonnet 5.5 Thinking','Claude Sonnet 5.5 Thinking','前端设计与细节调整','Pro / Ultra'),m('Claude Opus 5.5 Thinking','Claude Opus 5.5 Thinking','前端方案与复杂设计','Pro / Ultra'),
    {...m('Claude Sonnet 4.6 Thinking','Claude Sonnet 4.6 Thinking','旧版前端设计','11 月 2 日下线'),retire_at:'2026-11-02'}, {...m('Claude Opus 4.6 Thinking','Claude Opus 4.6 Thinking','旧版设计推敲','11 月 2 日下线'),retire_at:'2026-11-02'}, {...m('GPT-OSS 120B','GPT-OSS 120B','常规推理','11 月 2 日下线'),retire_at:'2026-11-02'}]),
  group('deepseek',['https://api-docs.deepseek.com/quick_start/pricing-details-cny/','https://www.deepseek.com/harness/en/'],[
    m('deepseek-flash','DeepSeek V4.1 Flash 1017','快速开发、日常处理'),m('deepseek-v4-pro','DeepSeek V4 Pro','复杂开发与推理')]),
  group('kimi',['https://www.kimi.com/code/docs/en/kimi-code/models','https://www.kimi.com/help/others/model-mode-selection'],[
    m('k3','K3 · 1M','大型代码库与长文档','Code'),m('k3-256k','K3 · 256K','常规工程','Code'),m('kimi-for-coding','K2.8 Preview','编程任务','Code'),m('kimi-for-coding-highspeed','K2.7 Code HighSpeed','快速编程','Code'),m('K2.6','K2.6','快速问答','网页 / Work'),m('K3','K3','复杂任务与文档','网页 / Work'),{...m('K3集群','K3 集群','批量协作','网页 / Work'),kind:'mode'}]),
  group('workbuddy',['https://www.workbuddy.cn/docs/workbuddy/From-Beginner-to-Expert-Guide/Function-Description/Model'],[
    m('Hy4 preview','Hy4 preview','复杂办公与多步任务'),m('Hy3','Hy3','常规办公'),m('GLM-5.3','GLM-5.3','复杂编程'),m('GLM-5.3-Flash','GLM-5.3-Flash','快速开发'),m('GLM-5.2','GLM-5.2','工程实现'),m('GLM-5.1','GLM-5.1','日常开发'),m('GLM-5v-Turbo','GLM-5v-Turbo','看图与视觉任务'),m('MiniMax-M3','MiniMax-M3','复杂任务与内容处理'),m('MiniMax-m2.7','MiniMax-m2.7','日常开发'),m('Kimi-K3','Kimi-K3','长文档与多步任务'),m('Kimi-K2.7-Code','Kimi-K2.7-Code','代码实现'),m('Kimi-K2.6','Kimi-K2.6','问答与内容整理'),m('Deepseek-V4-Flash','Deepseek-V4-Flash','快速处理'),m('Deepseek-V4-Pro','Deepseek-V4-Pro','复杂推理')]),
  group('gemini',['https://support.google.com/gemini/answer/18648722?hl=en'],[
    m('Gemini Flash-Lite','Gemini Flash-Lite','快速轻问答'),m('Gemini Flash','Gemini Flash','日常问答与整理'),m('Gemini Pro','Gemini Pro','复杂推理'),m('Gemini Argon','Gemini Argon','高难度工作'),{...m('Auto','Auto','自动匹配任务'),kind:'mode'}]),
  group('grok-build',['https://docs.x.ai/build/overview','https://x.ai/news/grok-4-7'],[m('grok-4.7-build-fast','Grok 4.7 Fast','独立代码审查','本机已实测')]),
  group('grok-bot',['https://cursor.com/help/grok-bot/models','https://docs.x.ai/grok-bot/overview'],[{...m('auto','自动选择','多步任务与云端协作'),kind:'mode'}]),
  group('grok-search',['https://grok.com/','https://docs.x.ai/grok/faq'],[
    {...m('Fast','Fast','快速问答'),kind:'mode'},{...m('Auto','Auto','自动匹配任务','登录后使用'),kind:'mode'},{...m('Expert','Expert','深度思考','登录后使用'),kind:'mode'},{...m('Heavy','Heavy','复杂问题','登录后使用'),kind:'mode'}]),
];

export function validateModel(agent:string, value:unknown, at=new Date(), timezone='UTC', workKind?:string,catalog:ModelGroup[]=modelCatalog):string|null {
  if(value==null||value==='')return null;
  assert(typeof value==='string'&&value.length<=100,'指定模型格式无效');
  const choice=catalog.find(g=>g.agent_id===agent)?.models.find(m=>m.id===value);
  assert(choice,'请从此成员的模型列表选择');
  assert(!isModelRetired(choice,timezone,at),'此模型已下线，请重新选择');
  assert(!workKind||agent!=='antigravity'||!value.startsWith('Claude ')||workKind==='frontend_light','Antigravity 内的 Claude 用于轻量前端设计，请选择独立 Claude 执行工程任务');
  return value;
}

