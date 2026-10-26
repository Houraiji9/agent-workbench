import type {ClientKind} from './client-discovery.ts';

export type AgentUsage = {
  scope: 'step' | 'reported_total' | 'message';
  inputTokens?: number; outputTokens?: number; cacheReadTokens?: number; cacheWriteTokens?: number; totalTokens?: number; totalCostUsd?: number;
};
export type ParsedAgentOutput = {
  recognized: boolean; terminal: boolean; eventType?: string; success?: boolean;
  sessionId?: string; model?: string; modelFormat?: 'identifier' | 'display_name'; usage?: AgentUsage; finalText?: string;
  /** ACP/Anthropic fragments are not a final response. Use createAgentOutputParser for accumulation. */
  textDelta?: string; messageId?: string; resetText?: boolean; stopReason?: string;
};
type ObjectValue = Record<string, unknown>;
const ignored = (): ParsedAgentOutput => ({recognized: false, terminal: false});
const object = (value: unknown): ObjectValue | undefined => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as ObjectValue : undefined;
const session = (value: unknown): string | undefined => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,511}$/.test(value) ? value : undefined;
const model = (value: unknown): string | undefined => typeof value === 'string' && value.trim().length > 0 && value.length <= 256 && !/[\x00-\x1f\x7f]/.test(value) ? value : undefined;
const text = (value: unknown): string | undefined => typeof value === 'string' && value.length <= 2 * 1024 * 1024 ? value : undefined;
const count = (value: unknown): number | undefined => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;

function usage(value: unknown, scope: AgentUsage['scope'], camel = false, cost?: unknown): AgentUsage | undefined {
  const source = object(value);
  const result: AgentUsage = {scope};
  const fields = camel
    ? {inputTokens: 'inputTokens', outputTokens: 'outputTokens', cacheReadTokens: 'cacheReadTokens', cacheWriteTokens: 'cacheWriteTokens', totalTokens: 'totalTokens'}
    : {inputTokens: 'input_tokens', outputTokens: 'output_tokens', cacheReadTokens: 'cache_read_input_tokens', cacheWriteTokens: 'cache_creation_input_tokens', totalTokens: 'total_tokens'};
  for (const [target, key] of Object.entries(fields)) {
    const value = count(source?.[key]);
    if (value !== undefined) (result as Record<string, unknown>)[target] = value;
  }
  if (typeof cost === 'number' && Number.isFinite(cost) && cost >= 0) result.totalCostUsd = cost;
  return Object.keys(result).length > 1 ? result : undefined;
}
function withMetadata(event: ParsedAgentOutput, fields: {sessionId?: string; model?: string; modelFormat?: ParsedAgentOutput['modelFormat']; usage?: AgentUsage}) {
  for (const [key, value] of Object.entries(fields)) if (value !== undefined) (event as Record<string, unknown>)[key] = value;
  return event;
}

/** Only parse the launched client's stdout, one complete line at a time. Never pass stderr,
 * prompt text or extracted tool stdout here. JSON strings nested in content are never reparsed.
 * recognized means a known wire event, not task acceptance, reviewer PASS or process success.
 * Evidence: DSH 0.2.1-rc.3 recorded native JSONL (session/status/final); official Claude Code
 * headless docs; https://cursor.com/docs/cli/reference/output-format; ACP v1 prompt-turn.
 */
export function parseAgentOutput(kind: ClientKind, line: string): ParsedAgentOutput {
  if (line.length > 2 * 1024 * 1024) return ignored();
  let value: ObjectValue | undefined;
  try {value = object(JSON.parse(line.replace(/^\uFEFF/, '')));} catch {return ignored();}
  if (!value) return ignored();
  if (kind === 'dsh') {
    if (value.type === 'session') {
      const id = session(value.sessionId);
      return id ? {recognized: true, terminal: false, eventType: 'session', sessionId: id} : ignored();
    }
    if (value.type === 'status' && value.phase === 'step_end') {
      const stepUsage = usage(value.usage, 'step', true);
      return stepUsage ? {recognized: true, terminal: false, eventType: 'status/step_end', usage: stepUsage} : ignored();
    }
    if (value.type === 'final') {
      const finalText = text(value.text);
      // DSH's observed final event has no success/model fields. Process exit remains a separate gate.
      return finalText !== undefined ? {recognized: true, terminal: true, eventType: 'final', finalText} : ignored();
    }
    // Confirmed in the installed 0.2.1-rc.3 dsh-headless startup/direct-driver source.
    if (value.type === 'error' && typeof value.message === 'string') return {recognized: true, terminal: true, eventType: 'error', success: false};
    return ignored();
  }
  if (kind === 'claude' || kind === 'cursor') {
    if (value.type === 'system' && value.subtype === 'init') {
      const id = session(value.session_id);
      if (!id) return ignored();
      const reportedModel = model(value.model);
      return withMetadata({recognized: true, terminal: false, eventType: 'system/init', sessionId: id}, {model: reportedModel, ...(reportedModel ? {modelFormat: kind === 'cursor' ? 'display_name' : 'identifier'} : {})});
    }
    if (value.type === 'result' && typeof value.subtype === 'string' && typeof value.is_error === 'boolean') {
      const id = session(value.session_id);
      if (!id) return ignored();
      const finalText = text(value.result);
      const success = value.subtype === 'success' && value.is_error === false && finalText !== undefined;
      return withMetadata({recognized: true, terminal: true, eventType: 'result', success, ...(success ? {finalText} : {})}, {
        sessionId: id,
        ...(kind === 'claude' ? {usage: usage(value.usage, 'reported_total', false, value.total_cost_usd)} : {usage: usage(value.usage, 'reported_total', true)}),
      });
    }
    // Assistant/tool/user events may contain example JSON and intermediate text. Only terminal
    // result is accepted as final; neither their nested strings nor arbitrary model keys are read.
    return ignored();
  }
  if (kind === 'grok') return parseGrokEvent(value);
  return ignored();
}

/** Grok --help identifies streaming-json as ACP updates and streaming-messages-json as Anthropic
 * Messages wire format. These branches implement those public standards, not a claimed native
 * model-run verification. Unknown Grok wrappers/terminal events deliberately remain unsupported. */
function parseGrokEvent(value: ObjectValue): ParsedAgentOutput {
  const params = value.jsonrpc === '2.0' && value.method === 'session/update' ? object(value.params)
    : value.jsonrpc === undefined && value.type === undefined ? value : undefined;
  const update = object(params?.update);
  const id = session(params?.sessionId);
  if (update && id) {
    if (update.sessionUpdate === 'agent_message_chunk') {
      const content = object(update.content); const delta = content?.type === 'text' ? text(content.text) : undefined;
      return delta !== undefined ? {recognized: true, terminal: false, eventType: 'acp/agent_message_chunk', sessionId: id, textDelta: delta, ...(session(update.messageId) ? {messageId: session(update.messageId)} : {})} : ignored();
    }
    if (update.sessionUpdate === 'tool_call') return {recognized: true, terminal: false, eventType: 'acp/tool_call', resetText: true};
    return ignored();
  }
  const result = value.jsonrpc === '2.0' && (typeof value.id === 'number' || typeof value.id === 'string') ? object(value.result) : undefined;
  if (result && ['end_turn', 'max_tokens', 'max_turn_requests', 'refusal', 'cancelled'].includes(String(result.stopReason))) {
    return {recognized: true, terminal: true, eventType: 'acp/prompt_result', success: result.stopReason === 'end_turn', stopReason: String(result.stopReason)};
  }
  // Full Anthropic Messages objects and streaming events, as documented by the named wire format.
  const message = value.type === 'message_start' ? object(value.message) : value.type === 'message' ? value : undefined;
  if (message?.type === 'message' && message.role === 'assistant' && session(message.id)) {
    const stopReason = typeof message.stop_reason === 'string' ? message.stop_reason : undefined;
    const blocks = Array.isArray(message.content) ? message.content : [];
    const body = blocks.map(object).filter(b => b?.type === 'text').map(b => text(b?.text) ?? '').join('');
    const complete = value.type === 'message' && stopReason === 'end_turn';
    const reportedModel = model(message.model);
    return withMetadata({recognized: true, terminal: complete, eventType: String(value.type), messageId: String(message.id), resetText: true, ...(complete ? {success: true, finalText: body} : {}), ...(stopReason ? {stopReason} : {})}, {model: reportedModel, ...(reportedModel ? {modelFormat: 'identifier'} : {}), usage: usage(message.usage, 'message')});
  }
  if (value.type === 'content_block_start' && count(value.index) !== undefined) {
    const block = object(value.content_block);
    return block?.type === 'text' && text(block.text) !== undefined ? {recognized: true, terminal: false, eventType: 'content_block_start', textDelta: String(block.text)} : ignored();
  }
  if (value.type === 'content_block_delta' && count(value.index) !== undefined) {
    const delta = object(value.delta);
    return delta?.type === 'text_delta' && text(delta.text) !== undefined ? {recognized: true, terminal: false, eventType: 'content_block_delta', textDelta: String(delta.text)} : ignored();
  }
  if (value.type === 'message_delta') {
    const delta = object(value.delta);
    if (!delta) return ignored();
    const stopReason = typeof delta.stop_reason === 'string' ? delta.stop_reason : undefined;
    return withMetadata({recognized: true, terminal: false, eventType: 'message_delta', ...(stopReason ? {stopReason} : {})}, {usage: usage(value.usage, 'message')});
  }
  if (value.type === 'message_stop') return {recognized: true, terminal: false, eventType: 'message_stop'};
  if (value.type === 'error' && object(value.error)) return {recognized: true, terminal: true, eventType: 'error', success: false};
  return ignored();
}

/** Stateful helper for documented ACP/Anthropic streams. A process exit or arbitrary assistant
 * chunk never promotes a partial answer to final. Feed one invocation per parser instance. */
export function createAgentOutputParser(kind: ClientKind) {
  let currentSession: string | undefined; let messageId: string | undefined; let body = ''; let stopReason: string | undefined;
  let anthropicMessage = false; let failed = false;
  return {
    push(line: string): ParsedAgentOutput {
      const event = parseAgentOutput(kind, line);
      if (!event.recognized) return event;
      if (event.sessionId) {
        if (currentSession && currentSession !== event.sessionId) {failed = true; return {recognized: true, terminal: true, eventType: 'session_conflict', success: false};}
        currentSession = event.sessionId;
      }
      if (event.resetText || (event.messageId && messageId && event.messageId !== messageId)) {body = ''; stopReason = undefined;}
      if (event.messageId) messageId = event.messageId;
      if (event.eventType === 'message_start') anthropicMessage = true;
      if (event.textDelta !== undefined) {
        if (body.length + event.textDelta.length > 2 * 1024 * 1024) failed = true;
        else body += event.textDelta;
      }
      if (event.stopReason) stopReason = event.stopReason;
      if (event.success === false) failed = true;
      if (event.eventType === 'message_stop') {
        const complete = anthropicMessage && stopReason === 'end_turn' && !failed;
        anthropicMessage = false;
        return complete ? {...event, terminal: true, success: true, finalText: body} : {...event, ...(failed ? {success: false} : {})};
      }
      if (event.eventType === 'acp/prompt_result' && event.success && currentSession && !failed) return {...event, sessionId: currentSession, finalText: body};
      if (failed && event.finalText !== undefined) {const {finalText: _ignored, ...rest} = event; return {...rest, success: false};}
      return event;
    },
  };
}
