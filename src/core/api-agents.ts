import fs from 'node:fs';
import path from 'node:path';
import type {Workbench} from './workbench.ts';
import type {Row} from './schema.ts';
import {ROOT} from './config.ts';
import {assert,DomainError,hash,id,now} from './security.ts';
import {windowsExternalVault,type ExternalVault} from './external-vault.ts';
import {API_AGENT_STATE_MAX_BYTES,apiAgentSaveInput,apiAgentSavePatchInput,apiAgentTurnInput,apiAgentPrivateStateInput,normalizeApiAgentEndpoint,type ApiAgentConfiguration,type ApiAgentPrivateState,type ApiAgentTurnInput,type ApiAgentStatus} from './api-agent-schema.ts';

type StoredConfiguration=Omit<ApiAgentConfiguration,'status'|'has_key'>;
type ConfigRow={agent_id:string;data:string;secret_cipher:string|null};
type SessionRow={id:string;agent_id:string;room_id:string;member_id:string;config_version:number;revision:number;data:string;state_cipher:string|null};
type LeaseIdentity={agentId:string;roomId:string;memberId:string;jobId:string;sessionId:string;version:number};
export type ApiAgentRuntimeConfiguration=ApiAgentConfiguration&{apiKey:string;endpoint:string};
export type ApiAgentTurn={config:ApiAgentRuntimeConfiguration;session:{id:string;revision:number;state:ApiAgentPrivateState|undefined};save:(state:ApiAgentPrivateState)=>Promise<void>;release:()=>void};
function privateStateJson(value:ApiAgentPrivateState,apiKey:string){
  let serialized:string;try{serialized=JSON.stringify(value);}catch{throw new DomainError('API 会话状态不能序列化',400);}
  assert(typeof serialized==='string'&&Buffer.byteLength(serialized)<=API_AGENT_STATE_MAX_BYTES,'API 会话达到本机保存上限，请开始新会话',413);
  let count=0;const clean=(part:unknown,depth=0):unknown=>{
    assert(++count<=50000&&depth<=40,'API 会话结构超过本机保存上限',413);
    if(typeof part==='string')return part.split(apiKey).join('[API Key 已隐藏]');
    if(Array.isArray(part))return part.map(item=>clean(item,depth+1));
    if(part&&typeof part==='object')return Object.fromEntries(Object.entries(part).map(([key,item])=>[key.split(apiKey).join('[API Key 已隐藏]'),clean(item,depth+1)]));
    return part;
  };
  serialized=JSON.stringify(clean(JSON.parse(serialized)));assert(Buffer.byteLength(serialized)<=API_AGENT_STATE_MAX_BYTES,'API 会话达到本机保存上限，请开始新会话',413);return serialized;
}

export class ApiAgents{
  readonly vault:ExternalVault;
  private leases=new Map<string,LeaseIdentity>();
  constructor(readonly wb:Workbench,options:{vault?:ExternalVault}={}){
    this.vault=options.vault||windowsExternalVault;
    wb.db.exec(fs.readFileSync(path.join(ROOT,'migrations/017_api_agents.sql'),'utf8'));
    wb.db.prepare('INSERT OR IGNORE INTO migrations VALUES(17,?)').run(now());
  }
  private stored(agentId:string){return this.wb.db.prepare('SELECT agent_id,data,secret_cipher FROM api_agent_configs WHERE agent_id=?').get(agentId) as ConfigRow|undefined;}
  private status(configuration:StoredConfiguration,hasKey:boolean):ApiAgentStatus{
    if(this.wb.get('agents',configuration.agent_id).archived)return 'archived';
    if(!configuration.enabled)return 'disabled';if(!hasKey)return 'missing_key';if(!this.vault.available)return 'vault_unavailable';return 'ready';
  }
  publicConfiguration(agentId:string):ApiAgentConfiguration|undefined{
    const stored=this.stored(agentId);if(!stored)return;const c=JSON.parse(stored.data) as StoredConfiguration;
    return {...c,has_key:!!stored.secret_cipher,status:this.status(c,!!stored.secret_cipher)};
  }
  capability(agentId:string){const config=this.publicConfiguration(agentId),status=config?.status||'missing_configuration';const messages:Record<string,string>={ready:'API 配置已齐全；尚未验证供应商调用。',missing_configuration:'尚未保存 API 配置。',missing_key:'请在本机填写 API Key。',disabled:'此 API Agent 已停用。',vault_unavailable:'本机凭据保险库不可用。',archived:'此 Agent 已归档。'};return {available:status==='ready',client_id:'api-agent' as const,supports_resume:true,status,reason:messages[status]};}
  snapshot(){const ids=this.wb.db.prepare('SELECT agent_id FROM api_agent_configs ORDER BY agent_id').all() as {agent_id:string}[];return {agents:ids.map(r=>this.publicConfiguration(r.agent_id)!).filter(c=>c.status!=='archived'),vault:{available:this.vault.available,...(this.vault.reason?{reason:this.vault.reason}:{})}};}
  check(agentId:string){assert(this.publicConfiguration(agentId),'API Agent 配置不存在',404);const capability=this.capability(agentId);return {status:capability.status,ready:capability.available,message:capability.reason+' 仅核对本机配置，未联网、未调用模型。',checked_at:now()};}
  private assertIdle(agentId:string){
    assert(![...this.leases.values()].some(lease=>lease.agentId===agentId),'此 API Agent 正在执行，请等待调用结束再修改配置',409);
    const busy=this.wb.db.prepare("SELECT 1 FROM workgroup_jobs WHERE json_extract(data,'$.agent_id')=? AND (status IN ('queued','running','launching') OR json_extract(data,'$.process_may_be_running')=1) LIMIT 1").get(agentId);
    assert(!busy,'此 API Agent 仍有排队、进行中或尚未确认结束的群调用',409);
  }
  private assertAgent(agentId:string){const agent=this.wb.get('agents',agentId);assert(agent.preset_id==='api-agent','此成员不是 API Agent',409);assert(!agent.archived,'请先恢复这位 API Agent',409);return agent;}
  private async encrypt(value:Record<string,string>){assert(this.vault.available,'本机凭据保险库不可用，不提供明文降级',503);try{return await this.vault.encrypt(value);}catch{throw new DomainError('无法加密 API Agent 私有资料，请检查本机凭据保险库',503);}}
  private async decrypt(cipher:string){assert(this.vault.available,'本机凭据保险库不可用',503);try{return await this.vault.decrypt(cipher);}catch{throw new DomainError('无法解锁 API Agent 私有资料，请在本机重新配置',503);}}
  async save(input:unknown):Promise<ApiAgentConfiguration>{
    const raw=apiAgentSavePatchInput.parse(input),old=raw.id?this.stored(raw.id):undefined;
    if(raw.id){assert(old,'API Agent 配置不存在',404);this.assertAgent(raw.id);assert(raw.version===JSON.parse(old.data).version,'API 配置已变化或缺少版本，请刷新',409);this.assertIdle(raw.id);}
    const previous=old?JSON.parse(old.data) as StoredConfiguration:undefined;
    const inherited=previous?Object.fromEntries(['name','base_url','protocol','model','system_prompt','enabled'].map(k=>[k,(previous as unknown as Row)[k]])):{};
    const v=apiAgentSaveInput.parse({...inherited,...raw});normalizeApiAgentEndpoint(v.base_url,v.protocol);
    let cipher=old?.secret_cipher||null;const newKey=v.api_key?.trim();if(v.wipe_key)cipher=null;else if(newKey)cipher=await this.encrypt({apiKey:newKey});
    const agentId=previous?.agent_id||id('A'),at=now(),configuration:StoredConfiguration={id:agentId,agent_id:agentId,name:v.name,base_url:v.base_url,protocol:v.protocol,model:v.model,system_prompt:v.system_prompt,enabled:v.enabled,version:(previous?.version||0)+1,created_at:previous?.created_at||at,updated_at:at};
    this.wb.transaction(()=>{
      const current=previous?this.assertAgent(agentId):undefined;
      if(previous){assert(this.publicConfiguration(agentId)?.version===previous.version,'API 配置已变化，请刷新',409);this.assertIdle(agentId);}
      assert(!this.wb.all('agents').some(a=>a.id!==agentId&&!a.archived&&a.name.toLocaleLowerCase()===v.name.toLocaleLowerCase()),'团队中已有这个名称',409);
      const agent={...(current||{}),id:agentId,name:v.name,preset_id:'api-agent',model:v.model,scope:current?.scope||'通过已配置 API 执行工作群任务、讨论和派活',restriction:current?.restriction||'',icon_key:current?.icon_key||'auto',allowed_kinds:current?.allowed_kinds||['engineering','frontend_light','review','research','operations'],account_ids:current?.account_ids||[],pool_ids:current?.pool_ids||[],activity:current?.activity||'unknown',source:current?.source||'user_entered',version:(current?.version||0)+1,updated_at:at,model_group:{agent_id:agentId,as_of:at.slice(0,10),registration_updated_at:at,sources:[],models:[{id:v.model,name:v.model,purpose:'用户配置的 API 模型',status:'configured'}]}};
      this.wb.put('agents',agent);this.wb.db.prepare('INSERT INTO api_agent_configs(agent_id,data,secret_cipher) VALUES(?,?,?) ON CONFLICT(agent_id) DO UPDATE SET data=excluded.data,secret_cipher=excluded.secret_cipher').run(agentId,JSON.stringify(configuration),cipher);
      const resetMembers:string[]=[],updatedMembers:string[]=[];
      if(previous)for(const row of this.wb.db.prepare('SELECT id,data FROM workgroup_members WHERE agent_id=?').all(agentId) as {id:string;data:string}[]){const member=JSON.parse(row.data);assert(member.status!=='running','成员仍在执行，不能重置会话',409);if(member.native_session_id)resetMembers.push(row.id);member.native_session_id=null;member.name=v.name;member.model=v.model;member.updated_at=at;member.revision=(member.revision||0)+1;this.wb.db.prepare('UPDATE workgroup_members SET data=? WHERE id=?').run(JSON.stringify(member),row.id);updatedMembers.push(row.id);}
      this.wb.audit('user',previous?'edit_api_agent':'add_api_agent',agentId,{version:configuration.version,credential_changed:!!newKey||v.wipe_key,enabled:configuration.enabled,protocol:configuration.protocol,reset_member_ids:resetMembers,updated_member_ids:updatedMembers});
    });return this.publicConfiguration(agentId)!;
  }
  private binding(input:ApiAgentTurnInput){
    this.assertAgent(input.agentId);
    const jobRow=this.wb.db.prepare('SELECT status,data FROM workgroup_jobs WHERE id=?').get(input.jobId) as {status:string;data:string}|undefined;
    const memberRow=this.wb.db.prepare('SELECT room_id,agent_id,data FROM workgroup_members WHERE id=?').get(input.memberId) as {room_id:string;agent_id:string;data:string}|undefined;
    assert(jobRow&&memberRow,'API 会话缺少实际工作群调用',403);const job=JSON.parse(jobRow.data),member=JSON.parse(memberRow.data);
    assert(job.room_id===input.roomId&&job.member_id===input.memberId&&job.agent_id===input.agentId&&memberRow.room_id===input.roomId&&memberRow.agent_id===input.agentId&&member.status!=='removed','API 会话与实际群成员调用不一致',403);
    assert(['running','launching'].includes(jobRow.status)&&!job.cancel_requested_at,'API 群调用已经结束或取消',409);
  }
  private sessionRow(sessionId:string){return this.wb.db.prepare('SELECT * FROM api_agent_sessions WHERE id=?').get(sessionId) as SessionRow|undefined;}
  async acquireTurn(input:ApiAgentTurnInput):Promise<ApiAgentTurn>{
    const v=apiAgentTurnInput.parse(input);this.binding(v);const config=this.publicConfiguration(v.agentId)!;assert(config&&config.status==='ready',this.capability(v.agentId).reason,409);
    assert(!this.leases.has(v.jobId)&&![...this.leases.values()].some(lease=>lease.roomId===v.roomId&&lease.memberId===v.memberId),'该成员已有 API 会话正在执行',409);
    const sessionId=v.sessionId&&!v.freshSession?v.sessionId:id('APIS'),identity={...v,sessionId,version:config.version};this.leases.set(v.jobId,identity);
    try{
      const record=await this.decrypt(this.stored(v.agentId)!.secret_cipher!);assert(typeof record.apiKey==='string'&&record.apiKey.length>0&&record.apiKey.length<=32768,'API 密钥记录不可用，请重新配置',409);
      const apiKey=record.apiKey,endpoint=normalizeApiAgentEndpoint(config.base_url,config.protocol),endpointHash=hash(endpoint);
      this.binding(v);assert(this.publicConfiguration(v.agentId)?.version===config.version,'API 配置在准备期间变化，请重新开始',409);
      let stored=this.sessionRow(sessionId),state:ApiAgentPrivateState|undefined;
      if(v.sessionId&&!v.freshSession)assert(stored,'API 历史会话不存在，请开始新会话',409);
      if(stored){assert(stored.agent_id===v.agentId&&stored.room_id===v.roomId&&stored.member_id===v.memberId&&stored.config_version===config.version,'API 历史会话与本次成员或配置版本不一致',409);const metadata=JSON.parse(stored.data);assert(metadata.model===config.model&&metadata.protocol===config.protocol&&metadata.endpointHash===endpointHash,'API 历史会话的模型或地址不一致',409);if(stored.state_cipher){const privateRecord=await this.decrypt(stored.state_cipher);try{assert(privateRecord.encoding==='base64-json-v1'&&typeof privateRecord.state==='string'&&privateRecord.state.length<=Math.ceil(API_AGENT_STATE_MAX_BYTES/3)*4,'API 会话格式或大小无效',409);const bytes=Buffer.from(privateRecord.state,'base64');assert(bytes.length<=API_AGENT_STATE_MAX_BYTES&&bytes.toString('base64')===privateRecord.state,'API 会话编码无效',409);state=apiAgentPrivateStateInput.parse(JSON.parse(bytes.toString('utf8')));}catch{throw new DomainError('API 历史会话状态不可用，请开始新会话',409);}assert(state.sessionId===sessionId&&state.protocol===config.protocol&&state.model===config.model&&state.endpointHash===endpointHash,'API 历史会话状态绑定不一致',409);}}
      this.binding(v);assert(this.publicConfiguration(v.agentId)?.version===config.version,'API 配置已变化，请重新开始',409);
      if(!stored){const metadata={model:config.model,protocol:config.protocol,endpointHash,created_at:now(),updated_at:now()};this.wb.db.prepare('INSERT INTO api_agent_sessions(id,agent_id,room_id,member_id,config_version,revision,data,state_cipher) VALUES(?,?,?,?,?,?,?,NULL)').run(sessionId,v.agentId,v.roomId,v.memberId,config.version,0,JSON.stringify(metadata));stored=this.sessionRow(sessionId)!;}
      const session={id:sessionId,revision:stored.revision,state};let released=false;
      return {config:{...config,apiKey,endpoint},session,release:()=>{if(released)return;released=true;this.leases.delete(v.jobId);},save:async value=>{
        assert(!released&&this.leases.get(v.jobId)===identity,'API 会话租约已结束',409);
        const serialized=privateStateJson(value,apiKey);
        const checked=apiAgentPrivateStateInput.parse(JSON.parse(serialized));assert(checked.sessionId===sessionId&&checked.protocol===config.protocol&&checked.model===config.model&&checked.endpointHash===endpointHash,'API 会话状态与当前配置不一致',409);
        // Base64 bounds the vault's outer JSON escaping, including quote-heavy histories.
        const revision=session.revision,cipher=await this.encrypt({encoding:'base64-json-v1',state:Buffer.from(serialized,'utf8').toString('base64')});
        this.wb.transaction(()=>{assert(!released&&this.leases.get(v.jobId)===identity,'API 会话租约已结束',409);assert(this.publicConfiguration(v.agentId)?.version===config.version,'API 配置已变化，不能覆盖历史会话',409);const current=this.sessionRow(sessionId);assert(current&&current.revision===revision,'API 会话已被另一轮更新',409);const metadata={...JSON.parse(current.data),updated_at:now(),last_job_id:v.jobId};this.wb.db.prepare('UPDATE api_agent_sessions SET state_cipher=?,revision=?,data=? WHERE id=?').run(cipher,revision+1,JSON.stringify(metadata),sessionId);});session.revision=revision+1;session.state=checked;
      }};
    }catch(error){this.leases.delete(v.jobId);throw error;}
  }
}
