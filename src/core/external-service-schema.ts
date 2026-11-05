import {z} from 'zod';
const bounded=z.string().max(2048);
export const externalConnectionInput=z.object({
  id:z.string().optional(),version:z.number().int().positive().optional(),preset_id:z.string().max(100),name:z.string().trim().min(1).max(120),enabled:z.boolean().default(false),
  base_url:bounded.default(''),model:z.string().max(150).default(''),region:z.string().max(40).default('cn'),
  executable:bounded.default(''),args:z.array(z.string().max(4096)).max(60).default([]),cwd:bounded.default(''),profile:z.string().max(100).default('default'),
  mcp_transport:z.enum(['stdio','streamable-http']).default('stdio'),mcp_url:bounded.default(''),timeout_ms:z.number().int().min(1000).max(300000).default(90000),
  allowed_project_ids:z.array(z.string().max(100)).max(100).default([]),allowed_agent_ids:z.array(z.string().max(100)).max(100).default([]),
  allow_paid:z.boolean().default(false),daily_call_limit:z.number().int().min(1).max(10000).default(20),
  secrets:z.record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_.-]{0,100}$/),z.string().max(32768)).optional(),wipe_secrets:z.boolean().optional(),
}).strict();
export type ExternalConnection=z.infer<typeof externalConnectionInput>&{id:string;version:number;status:string;credential_fields:string[];credential_configured:boolean;created_at:string;updated_at:string;last_probe?:unknown};
export type ExternalCaller={id:string;agent_id:string;project_id?:string;run_id?:string;kind:'runner'|'reviewer'|'manager'|'bridge'|'page'|'workgroup';image_only?:boolean;allowed_paths?:string[]};
export const externalInvokeInput=z.object({service_id:z.string(),operation:z.string().max(100),input:z.record(z.string(),z.unknown()).default({}),request_id:z.string().uuid(),project_id:z.string().optional(),run_id:z.string().optional(),review_id:z.string().optional()}).strict();
export const externalQueryInput=z.object({invocation_id:z.string(),run_id:z.string().optional(),review_id:z.string().optional()}).strict();
export const externalArtifactInput=externalQueryInput.extend({artifact_id:z.string()});
export const externalTools=new Set(['list_external_services','get_external_calling','invoke_external_service','get_external_invocation','get_external_artifact']);
