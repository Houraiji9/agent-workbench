import fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {supportsCursorPlanMode} from './client-discovery.ts';
import type {ClientRecord} from './client-discovery.ts';
export {discoverAgentClients, readClientCapabilities, resolveAgentClient, publicClientCapabilities, setClientOverride} from './client-discovery.ts';
export type {ClientKind, ClientStatus, ClientRecord, ClientCapability, DiscoveryOptions} from './client-discovery.ts';
export {parseAgentOutput, createAgentOutputParser} from './agent-output.ts';
export type {ParsedAgentOutput, AgentUsage} from './agent-output.ts';

export type AgentInvocationOptions = {role: 'execution' | 'review'; cwd: string; artifactDir: string; model: string; provider?: string; sessionId?: string; promptFile: string};
export type AgentInvocation = {command: string; args: string[]; stdin?: string; env?: Record<string, string>};
function scalar(value: string, name: string) {
  if (!value.trim() || value.length > 1024 || /[\x00-\x1f\x7f]/.test(value)) throw new Error(`${name} 无效`);
  return value;
}
function requireFlags(record: ClientRecord, required: string[]) {
  for (const flag of required) if (!record.supportedFlags?.includes(flag)) throw new Error(`${record.label} 当前版本未确认支持 ${flag}`);
}

/** Builds an argv invocation only. The caller must validate project authorization, use shell:false,
 * pass cwd explicitly, and preserve the returned environment additions. This never calls a model. */
export async function buildAgentInvocation(record: ClientRecord, options: AgentInvocationOptions): Promise<AgentInvocation> {
  if (record.status !== 'verified' || !record.executable || !path.isAbsolute(record.executable) || /\.(?:cmd|bat|ps1)$/i.test(record.executable)) throw new Error('客户端入口尚未验证或需要不安全的 shell 启动');
  for (const [name, value] of Object.entries({cwd: options.cwd, artifactDir: options.artifactDir, promptFile: options.promptFile})) {
    if (!path.isAbsolute(value) || value.includes('\0')) throw new Error(`${name} 必须是绝对路径`);
  }
  const model = scalar(options.model, 'model');
  const sessionId = options.sessionId ? scalar(options.sessionId, 'sessionId') : undefined;
  if (!(await fs.stat(options.cwd)).isDirectory()) throw new Error('工作目录不存在');
  const promptStat = await fs.stat(options.promptFile);
  if (!promptStat.isFile() || promptStat.size > 1024 * 1024) throw new Error('任务提示文件无效或超过 1 MiB');
  const prompt = await fs.readFile(options.promptFile, 'utf8');
  if (!prompt.trim()) throw new Error('任务提示不能为空');
  const result: AgentInvocation = {command: record.executable, args: [...(record.prefixArgs ?? [])], ...(record.env ? {env: {...record.env}} : {})};
  switch (record.kind) {
    case 'dsh': {
      requireFlags(record, ['--profile', '--patch', '--json', ...(sessionId ? ['--session-id'] : [])]);
      const provider = scalar(options.provider ?? (/^glm[-.]/i.test(model) ? 'zai-coding-cn' : 'deepseek-account'), 'provider');
      const patches: unknown[] = [
        {id: 'credentials', name: '@deepseek-ai/dsh-credentials-local', disabled: false},
        {id: 'authorization', name: '@deepseek-ai/dsh-authorization', disabled: false},
        ...(provider === 'deepseek-account' ? [{id: 'deepseek-account', name: '@deepseek-ai/dsh-deepseek-account-platform', disabled: false}] : []),
        {id: 'agent-default-model', name: '@deepseek-ai/dsh-agent-default-model', config: {provider, model}},
      ];
      await fs.mkdir(options.artifactDir, {recursive: true});
      const overlay = path.join(options.artifactDir, `dsh-overlay-${randomUUID()}.yml`);
      // JSON is a YAML subset; serialized values cannot inject overlay directives.
      await fs.writeFile(overlay, JSON.stringify(patches, null, 2), {encoding: 'utf8', flag: 'wx', mode: 0o600});
      result.args.push('--profile', 'headless', '--patch', overlay, '--json');
      if (sessionId) result.args.push('--session-id', sessionId);
      result.stdin = prompt;
      break;
    }
    case 'grok':
      requireFlags(record, ['--prompt-file', '--cwd', '--model', '--output-format', '--permission-mode', ...(sessionId ? ['--resume'] : [])]);
      result.args.push('--prompt-file', options.promptFile, '--cwd', options.cwd, '--model', model, '--output-format', 'streaming-json', '--permission-mode', 'default');
      if (sessionId) result.args.push('--resume', sessionId);
      break;
    case 'claude':
      requireFlags(record, ['--print', '--output-format', '--verbose', '--model', '--permission-mode', ...(sessionId ? ['--resume'] : [])]);
      result.args.push('--print', '--output-format', 'stream-json', '--verbose', '--model', model, '--permission-mode', 'default');
      if (sessionId) result.args.push('--resume', sessionId);
      result.stdin = prompt;
      break;
    case 'cursor':
      if (options.role === 'execution') throw new Error('Cursor CLI 当前安全调用仅支持审查与建议；自动修改需要额外权限，本程序不会默认启用 --force');
      if (!supportsCursorPlanMode(record.help)) throw new Error('Cursor CLI 当前版本未确认支持只读 plan 模式，拒绝启动审查');
      requireFlags(record, ['--print', '--mode', '--output-format', '--model', '--workspace', ...(sessionId ? ['--resume'] : [])]);
      result.args.push('--print', '--mode', 'plan', '--output-format', 'json', '--model', model, '--workspace', options.cwd);
      if (sessionId) result.args.push('--resume', sessionId);
      result.args.push(`请读取任务文件 ${JSON.stringify(options.promptFile)} 的完整内容并完成其中的审查。只读分析并在本次回复中返回完整报告。`);
      break;
    default: throw new Error('不支持的 Agent 客户端');
  }
  return result;
}
