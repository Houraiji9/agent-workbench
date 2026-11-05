import {z} from 'zod';
import {assert,DomainError} from './security.ts';

export const apiAgentProtocol=z.enum(['chat_completions','responses']);
export type ApiAgentProtocol=z.infer<typeof apiAgentProtocol>;
export const API_AGENT_STATE_MAX_BYTES=512*1024;
const apiAgentSaveFields=z.object({
  id:z.string().min(1).max(100).optional(),version:z.number().int().positive().optional(),
  name:z.string().trim().min(1).max(100),base_url:z.string().trim().min(1).max(2048),
  protocol:apiAgentProtocol,model:z.string().trim().min(1).max(200),
  system_prompt:z.string().max(20000).default(''),enabled:z.boolean().default(true),
  api_key:z.string().max(32768).optional(),wipe_key:z.boolean().default(false),
}).strict();
export const apiAgentSavePatchInput=apiAgentSaveFields.partial();
export const apiAgentSaveInput=apiAgentSaveFields.refine(v=>!(v.wipe_key&&v.api_key?.trim()),'清除密钥和填写新密钥不能同时进行');

/** A configured base path is preserved; no version path or model is guessed. */
export function normalizeApiAgentEndpoint(baseUrl:string,protocol:ApiAgentProtocol):string{
  assert(typeof baseUrl==='string'&&baseUrl.length<=2048&&!/[\\\x00-\x20?#]/.test(baseUrl),'API 地址不能包含空白、查询参数、片段或反斜杠');
  let url:URL;try{url=new URL(baseUrl);}catch{throw new DomainError('API 地址格式无效');}
  assert(!url.username&&!url.password,'API 地址不能包含用户名或密码');
  const loopback=url.hostname==='localhost'||url.hostname==='[::1]'||/^127\.(?:\d{1,3}\.){2}\d{1,3}$/.test(url.hostname);
  assert(url.protocol==='https:'||url.protocol==='http:'&&loopback,'API 地址需要 HTTPS；只有本机回环地址允许 HTTP');
  const route=protocol==='chat_completions'?'/chat/completions':'/responses';
  const pathname=url.pathname.replace(/\/+$/,'');
  if(/\/(?:chat\/completions|responses)$/.test(pathname))assert(pathname.endsWith(route),'API 完整端点与所选协议不一致');
  url.pathname=/\/(?:chat\/completions|responses)$/.test(pathname)?pathname:pathname+route;
  return url.toString();
}

export type ApiAgentStatus='ready'|'missing_key'|'disabled'|'vault_unavailable'|'archived';
export type ApiAgentConfiguration={id:string;agent_id:string;name:string;base_url:string;protocol:ApiAgentProtocol;model:string;system_prompt:string;enabled:boolean;has_key:boolean;version:number;status:ApiAgentStatus;created_at:string;updated_at:string};
export type ApiAgentPrivateState={schema_version:1;sessionId:string;protocol:ApiAgentProtocol;model:string;endpointHash:string;items:Record<string,unknown>[];pending?:{id:string;name:string;arguments:Record<string,unknown>;phase:'pending'|'started'|'completed';output?:string}[]};
export const apiAgentPrivateStateInput=z.object({schema_version:z.literal(1),sessionId:z.string().min(1).max(100),protocol:apiAgentProtocol,model:z.string().min(1).max(200),endpointHash:z.string().regex(/^[a-f0-9]{64}$/),items:z.array(z.record(z.unknown())),pending:z.array(z.object({id:z.string().min(1).max(500),name:z.string().min(1).max(200),arguments:z.record(z.unknown()),phase:z.enum(['pending','started','completed']),output:z.string().optional()}).strict()).optional()}).strict();
export const apiAgentTurnInput=z.object({agentId:z.string().min(1).max(100),roomId:z.string().min(1).max(100),memberId:z.string().min(1).max(100),jobId:z.string().min(1).max(100),sessionId:z.string().min(1).max(100).optional(),freshSession:z.boolean().optional()}).strict();
export type ApiAgentTurnInput=z.infer<typeof apiAgentTurnInput>;
