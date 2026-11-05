import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {createRequire} from 'node:module';
import {lookup} from 'node:dns/promises';
import https from 'node:https';
import {isIP} from 'node:net';
import type {Workbench} from './workbench.ts';
import {assert,safePath,hash,now,atomicWrite,protectedName,readBounded} from './security.ts';
import {externalPresets} from './external-provider-catalog.ts';
import {buildExternalApiRequest,parseExternalApiResponse} from './external-api-adapters.ts';
import {externalConnectionInput,externalInvokeInput,type ExternalConnection,type ExternalCaller} from './external-service-schema.ts';
import {windowsExternalVault,type ExternalVault} from './external-vault.ts';
import {validateExternalUrl,validateExternalArgs,externalExec,externalEnvironment,withExternalMcp} from './external-transports.ts';
import {harnessImagePatch} from './harness-image-tools.ts';
type Row=Record<string,any>;
const operationsAlias:Record<string,string>={generate_image:'image.generate',edit_image:'image.edit'};
const capMatch=(list:string[],value:string)=>list.includes('*')||list.includes(value);
function redact(value:string,secrets:Record<string,string>={}){for(const v of Object.values(secrets))if(v.length>3)value=value.split(v).join('[已脱敏]');return value.replace(/(?:Bearer\s+|sk-)[A-Za-z0-9_.\-]{10,}/gi,'[已脱敏]').replace(/([?&][^=\s&]*(?:token|signature|key|secret|credential|password)[^=\s&]*=)[^&\s"<>]+/gi,'$1[已脱敏]');}
function configView(c:ExternalConnection){return {...c};}
function imageMime(bytes:Buffer){if(bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))return 'image/png';if(bytes[0]===255&&bytes[1]===216&&bytes[2]===255)return 'image/jpeg';if(/^GIF8[79]a$/.test(bytes.subarray(0,6).toString('ascii')))return 'image/gif';if(bytes.subarray(0,4).toString('ascii')==='RIFF'&&bytes.subarray(8,12).toString('ascii')==='WEBP')return 'image/webp';return '';}
function publicAddress(ip:string){if(isIP(ip)===6)return /^[23][0-9a-f]{3}:/i.test(ip)&&!/^2001:db8:/i.test(ip);if(isIP(ip)!==4)return false;const [a,b]=ip.split('.').map(Number);return a>0&&a<224&&![10,127].includes(a)&&!(a===100&&b>=64&&b<=127)&&!(a===169&&b===254)&&!(a===172&&b>=16&&b<=31)&&!(a===192&&[0,168].includes(b))&&!(a===198&&[18,19].includes(b));}
export class ExternalServices{
  private pending=new Map<string,Promise<void>>();
  private shutdown=new AbortController();
  constructor(readonly wb:Workbench,readonly vault:ExternalVault=windowsExternalVault,readonly fetcher:typeof fetch=fetch){
    // A crash never causes a second charge. Preserve remote task ids for explicit polling.
    for(const r of this.rows('external_invocations'))if(r.status==='running'&&!r.provider_task_id){r.status='unknown';r.message='工作台在调用中重启；请核实供应商任务，不能自动重发';this.putInvocation(r);}
  }
  private rows(table:'external_connections'|'external_invocations'|'external_grants'):Row[]{return (this.wb.db.prepare(`SELECT data FROM ${table}`).all() as any[]).map(r=>JSON.parse(r.data));}
  connection(id:string):ExternalConnection{const r=this.wb.db.prepare('SELECT data FROM external_connections WHERE id=?').get(id) as any;assert(r,'连接不存在',404);return JSON.parse(r.data);}
  private async secrets(id:string){const r=this.wb.db.prepare('SELECT secret_cipher FROM external_connections WHERE id=?').get(id) as any;return r?.secret_cipher?this.vault.decrypt(r.secret_cipher):{};}
  private putConnection(c:ExternalConnection,cipher?:string|null){if(cipher!==undefined)this.wb.db.prepare('INSERT INTO external_connections(id,data,secret_cipher)VALUES(?,?,?) ON CONFLICT(id)DO UPDATE SET data=excluded.data,secret_cipher=excluded.secret_cipher').run(c.id,JSON.stringify(c),cipher);else this.wb.db.prepare('UPDATE external_connections SET data=? WHERE id=?').run(JSON.stringify(c),c.id);}
  private putInvocation(r:Row){this.wb.db.prepare('INSERT INTO external_invocations(id,request_key,data)VALUES(?,?,?) ON CONFLICT(id)DO UPDATE SET data=excluded.data').run(r.id,r.request_key,JSON.stringify(r));this.wb.emit('change');}
  snapshot(){return {presets:externalPresets,connections:this.rows('external_connections').filter(c=>!c.deleted_at),invocations:this.rows('external_invocations').slice(-100).reverse().map(({request_key,fingerprint,...r})=>r),vault:{available:this.vault.available,reason:this.vault.reason}};}
  async save(input:unknown){
    const raw=input as Row,previous=typeof raw?.id==='string'?this.connection(raw.id):undefined;
    if(previous)assert(raw.version===previous.version,'连接已变化或缺少版本，请刷新后重试',409);
    const savedFields=previous?Object.fromEntries(Object.keys(externalConnectionInput.shape).filter(k=>k in previous).map(k=>[k,(previous as any)[k]])):{};
    const v=externalConnectionInput.parse({...savedFields,...raw}),preset=externalPresets.find(p=>p.id===v.preset_id);assert(preset,'预设不存在');
    const old=v.id?this.connection(v.id):undefined;assert(!old||old.version===v.version,'连接已变化，请刷新后重试',409);
    if(v.base_url)validateExternalUrl(v.base_url);if(v.mcp_url)validateExternalUrl(v.mcp_url,true);validateExternalArgs(v.args);
    if(v.executable)assert(path.isAbsolute(v.executable)&&!v.executable.startsWith('\\\\'),'CLI必须是本机绝对路径');
    if(v.cwd)assert(path.isAbsolute(v.cwd),'工作目录须是绝对路径');
    for(const p of v.allowed_project_ids)if(p!=='*')this.wb.roots(this.wb.get('projects',p));
    for(const a of v.allowed_agent_ids)if(a!=='*'&&a!=='manager')this.wb.get('agents',a);
    if(v.enabled)assert(v.allowed_project_ids.length&&v.allowed_agent_ids.length,'启用前请选择可以使用此连接的项目和Agent');
    const {secrets:newSecrets,wipe_secrets,...fields}=v;let cipher:string|null|undefined,secretFields=old?.credential_fields||[];
    if(wipe_secrets){cipher=null;secretFields=[];}
    if(newSecrets&&Object.values(newSecrets).some(Boolean)){
      assert(this.vault.available,'当前凭据保险库不可用，不能明文保存',503);
      const base=old&&!wipe_secrets?await this.secrets(old.id):{};
      const merged={...base,...Object.fromEntries(Object.entries(newSecrets).filter(([,v])=>v!==''))};
      assert(JSON.stringify(merged).length<=128*1024,'凭据过大');cipher=await this.vault.encrypt(merged);secretFields=Object.keys(merged);
    }
    const c={...fields,id:old?.id||'XC-'+crypto.randomUUID(),version:(old?.version||0)+1,created_at:old?.created_at||now(),updated_at:now(),status:'configured',credential_fields:secretFields,credential_configured:secretFields.length>0} as ExternalConnection;
    // Async encryption completed: perform a second version check before the atomic update.
    this.wb.transaction(()=>{if(old)assert(this.connection(old.id).version===old.version,'连接已变化，请刷新',409);this.putConnection(c,cipher===undefined&&!old?null:cipher);this.wb.audit('user','external_connection_saved',c.id,{preset_id:c.preset_id,version:c.version,credential_changed:cipher!==undefined});});return configView(c);
  }
  remove(id:string,version:number){const c=this.connection(id);assert(c.version===version,'连接已变化',409);assert(!this.rows('external_invocations').some(r=>r.service_id===id&&['running','submitted'].includes(r.status)),'仍有进行中的调用，请先核实终态',409);this.wb.transaction(()=>{this.wb.db.prepare('DELETE FROM external_connections WHERE id=?').run(id);this.wb.audit('user','external_connection_removed',id);});return {removed:true};}
  async probe(id:string){
    const c=this.connection(id),p=externalPresets.find(p=>p.id===c.preset_id)!;let probeSecrets:Record<string,string>={},result:Row={at:now(),status:'configuration_checked',message:'配置格式已核对；未调用模型，未验证账号/生成权限'};
    try{
      probeSecrets=await this.secrets(id);
      if(p.kind==='agent_mcp'){
        const tools=await withExternalMcp(c,await this.secrets(id),client=>client.listTools());result={at:now(),status:'local_probe_passed',message:'MCP握手与工具枚举通过；尚未调用工具',tools:tools.tools.map(t=>({name:t.name,description:t.description?.slice(0,1000),inputSchema:t.inputSchema})).slice(0,100)};
      }else if(p.kind==='cli'||p.kind==='agent_cli'){
        const args=c.preset_id.includes('dreamina')?['schema']:['--help'];
        const text=await externalExec(c.executable,[...c.args,...args],c.cwd||this.wb.config.root,externalEnvironment(await this.secrets(id)),Math.min(c.timeout_ms,15000));
        result={at:now(),status:'local_probe_passed',message:'CLI帮助/协议读取成功；登录与生成尚未验证',contract:redact(text,await this.secrets(id)).slice(0,24000)};
      }else {const base=c.base_url||p.baseUrl;assert(base,'缺少API地址');validateExternalUrl(base);await this.secrets(id);}
    }catch{result={at:now(),status:'probe_failed',message:'检测失败：请核对程序/连接、认证状态和当前电脑凭据绑定；没有执行生成'};}
    result=JSON.parse(redact(JSON.stringify(result),probeSecrets));const current=this.connection(id);assert(current.version===c.version,'检测期间配置发生变化，请重新检测',409);current.last_probe=result;current.status=result.status;current.version++;current.updated_at=now();this.putConnection(current);this.wb.emit('change');return result;
  }
  private authorized(c:ExternalConnection,caller:ExternalCaller,projectId?:string){
    const pid=caller.project_id||projectId;assert(pid,'请指定已授权项目');if(caller.project_id&&projectId)assert(caller.project_id===projectId,'禁止跨项目调用',403);
    const project=this.wb.get('projects',pid);this.wb.roots(project);assert(!project.archived,'项目已归档',403);
    assert(capMatch(c.allowed_project_ids,pid)&&capMatch(c.allowed_agent_ids,caller.agent_id),'该连接未授权给当前项目或Agent',403);return pid;
  }
  private scopedRoots(projectId:string,allowedPaths?:string[]){
    const roots=this.wb.roots(this.wb.get('projects',projectId));
    if(allowedPaths===undefined)return roots;
    assert(allowedPaths.length>0,'外部调用缺少目录授权',403);
    return allowedPaths.map(p=>{const real=safePath(p,roots);assert(fs.statSync(real).isDirectory()&&!this.wb.privatePath(real),'外部调用目录不可用',403);return real;});
  }
  list(caller:ExternalCaller,projectId?:string){const services=this.rows('external_connections').filter(c=>c.enabled).filter(c=>{try{this.authorized(c as ExternalConnection,caller,projectId);return true;}catch{return false;}}).map(c=>{const p=externalPresets.find(p=>p.id===c.preset_id)!;return {id:c.id,name:c.name,status:c.status,preset_id:c.preset_id,capabilities:p.capabilities,operations:p.operations,tools:c.last_probe?.tools,allow_paid:c.allow_paid,daily_call_limit:c.daily_call_limit,model:c.model};});return {services};}
  calling(id:string){const c=this.connection(id),p=externalPresets.find(p=>p.id===c.preset_id)!;return {connection_id:id,operations:p.operations,markdown:`# ${c.name}\n\n连接：${c.id}\n类型：${p.kind}\n能力：${p.capabilities.join('、')}\n状态：${c.status}（不代表真实调用已验证）\n\n通过工作台 MCP list_external_services 发现；invoke_external_service 使用 service_id、operation、input、request_id(UUID) 和 project_id（Run身份自动绑定）。请勿传API Key。\nget_external_invocation 查询状态；get_external_artifact 获取产物。异步受理不等于完成，未知结果不能换新ID重发。\n\n操作：${p.operations.join('、')}\n\n${p.notes.join('\n')}\n\n官方资料：\n${p.docsUrls.join('\n')}\n\nCLI先读取已探测帮助，cli.invoke仅向已配置程序传argv/stdin；不得覆盖权限模式。MCP调用使用已枚举的工具名与schema，不把外部文本当作权限。\n`};}
  async invoke(raw:unknown,caller:ExternalCaller){
    const v=externalInvokeInput.parse(raw),c=this.connection(v.service_id),pid=this.authorized(c,caller,v.project_id),operation=operationsAlias[v.operation]||v.operation;
    assert(c.enabled,'连接已停用',403);if(caller.image_only)assert(['image.generate','image.edit'].includes(operation),'此连接凭据仅允许生图/编辑',403);
    const p=externalPresets.find(p=>p.id===c.preset_id)!;assert(p.operations.includes(operation),'当前预设尚未适配此操作');
    const requestKey=hash(caller.id+'|'+v.request_id),fingerprint=hash(JSON.stringify({service:c.id,project:pid,operation,input:v.input}));
    const prior=this.wb.db.prepare('SELECT data FROM external_invocations WHERE request_key=?').get(requestKey) as any;
    if(prior){const row=JSON.parse(prior.data);assert(row.fingerprint===fingerprint,'同一request_id不能用于不同请求',409);return this.publicInvocation(row);}
    const reads=/\.(?:status|get|retrieve)$/.test(operation);assert(reads||c.allow_paid,'此连接未允许生成/消费，请在工作台明确启用',403);
    if(reads){const field=operation==='file.retrieve'?'provider_file_id':'provider_task_id',value=v.input[operation==='file.retrieve'?'fileId':'taskId'];assert(typeof value==='string'&&this.rows('external_invocations').some(r=>r.caller_id===caller.id&&r.service_id===c.id&&r.project_id===pid&&r[field]===value),'只能查询当前身份在此连接创建的任务或文件；请用调用记录查询进度',403);}
    const today=now().slice(0,10);assert(reads||this.rows('external_invocations').filter(r=>r.service_id===c.id&&r.created_at.startsWith(today)&&!r.read_only).length<c.daily_call_limit,'已达到此连接今日调用次数上限',429);
    assert([...this.pending.keys()].length<8,'并发调用已满，请稍后重试',429);
    const scoped=caller.allowed_paths?this.scopedRoots(pid,caller.allowed_paths):undefined;
    const row:Row={id:'XI-'+crypto.randomUUID(),invocation_id:'',service_id:c.id,project_id:pid,caller_id:caller.id,agent_id:caller.agent_id,run_id:caller.run_id,...(scoped?{allowed_paths:scoped}:{}),operation,request_key:requestKey,fingerprint,status:'running',created_at:now(),updated_at:now(),connection_version:c.version,connection_origin:hash(JSON.stringify([c.preset_id,c.base_url,c.region,c.model])),read_only:reads,artifacts:[]};row.invocation_id=row.id;
    // These ids have already been checked against this caller's recorded ownership.
    // Keep them even if the first read-only network request fails before a response.
    if(reads)row[operation==='file.retrieve'?'provider_file_id':'provider_task_id']=v.input[operation==='file.retrieve'?'fileId':'taskId'];
    this.putInvocation(row);this.wb.audit(caller.id,'external_invocation_started',row.id,{service_id:c.id,project_id:pid,operation});
    const promise=this.execute(c,operation,v.input,row).finally(()=>this.pending.delete(row.id));this.pending.set(row.id,promise);return this.publicInvocation(row);
  }
  private publicInvocation(row:Row){const {request_key,fingerprint,...value}=row;return value;}
  private invocation(id:string,caller?:ExternalCaller){const r=this.wb.db.prepare('SELECT data FROM external_invocations WHERE id=?').get(id) as any;assert(r,'调用记录不存在',404);const row=JSON.parse(r.data);if(caller)assert(row.caller_id===caller.id,'仅可读取当前身份创建的调用',403);return row;}
  get(id:string,caller?:ExternalCaller){return this.publicInvocation(this.invocation(id,caller));}
  async poll(id:string,caller?:ExternalCaller){
    const row=this.invocation(id,caller);if(this.pending.has(id)||['succeeded','failed'].includes(row.status)||(!row.provider_task_id&&!row.provider_file_id))return this.publicInvocation(row);
    if(row.last_poll_at&&Date.now()-Date.parse(row.last_poll_at)<3000)return this.publicInvocation(row);
    const c=this.connection(row.service_id);assert(c.enabled,'连接已停用，暂不查询远端任务',403);if(caller)this.authorized(c,caller,row.project_id);assert(row.connection_origin===hash(JSON.stringify([c.preset_id,c.base_url,c.region,c.model])),'服务地址/模型已变化，原任务需在供应商处查询',409);
    const p=externalPresets.find(p=>p.id===c.preset_id)!,operation=row.provider_file_id&&p.operations.includes('file.retrieve')?'file.retrieve':'video.status';if(!p.operations.includes(operation)||operation==='video.status'&&!row.provider_task_id)return this.publicInvocation(row);
    row.last_poll_at=now();this.putInvocation(row);
    const input=operation==='file.retrieve'?{fileId:row.provider_file_id}:{taskId:row.provider_task_id,traceId:crypto.randomUUID()};
    const promise=this.execute(c,operation,input,row).finally(()=>this.pending.delete(id));this.pending.set(id,promise);await promise;return this.get(id,caller);
  }
  async close(){this.shutdown.abort();await Promise.allSettled(this.pending.values());}
  async wait(id:string){await this.pending.get(id);return this.get(id);}
  private async bytes(url:string,init:RequestInit={},limit=32*1024*1024,allowHttpError=false){
    const res=await this.fetcher(url,{...init,redirect:'error',signal:AbortSignal.any([this.shutdown.signal,init.signal||AbortSignal.timeout(90000)])});assert(allowHttpError||res.ok,`服务请求失败（HTTP ${res.status}），请检查权限或限流`,res.status===429?429:502);
    const reader=res.body?.getReader();if(!reader&&allowHttpError&&!res.ok)return {data:Buffer.alloc(0),type:'',status:res.status};assert(reader,'服务没有返回内容',502);const chunks:Uint8Array[]=[];let length=0;
    for(;;){const {done,value}=await reader.read();if(done)break;length+=value.length;if(length>limit){await reader.cancel();throw new Error('服务返回文件过大');}chunks.push(value);}return {data:Buffer.concat(chunks),type:res.headers.get('content-type')||'',status:res.status};
  }
  private async archive(artifact:Row,row:Row,index:number){
    let bytes:Buffer,mime=String(artifact.mimeType||'');
    if(artifact.base64){assert(artifact.base64.length<=44*1024*1024,'产物过大');bytes=Buffer.from(artifact.base64,'base64');}
    else if(artifact.url){const u=validateExternalUrl(artifact.url,false,true);assert(u.hostname!=='localhost'&&(!isIP(u.hostname)||publicAddress(u.hostname))&&!u.hostname.startsWith('['),'产物地址必须是公网地址');const result=await this.downloadArtifact(u);bytes=result.data;mime||=result.type.split(';')[0];}
    else return;
    assert(bytes.length>0,'产物内容为空');
    const detected=imageMime(bytes);if(artifact.type==='image'||mime.startsWith('image/'))assert(detected,'返回图片的文件标记无效，未记为生成完成');if(detected)mime=detected;
    const ext:Record<string,string>={'image/png':'.png','image/jpeg':'.jpg','image/webp':'.webp','image/gif':'.gif','video/mp4':'.mp4','audio/mpeg':'.mp3','audio/wav':'.wav'};
    const project=this.wb.get('projects',row.project_id),roots=this.scopedRoots(row.project_id,row.allowed_paths),base=safePath(row.allowed_paths?roots[0]:project.source_root||roots[0],roots);
    const target=safePath(path.join(base,'.agent-workbench-output','external-services',row.id,`output-${index}${ext[mime]||'.bin'}`),roots,true);assert(!this.wb.privatePath(target),'不允许写入工作台内部数据',403);atomicWrite(target,bytes);
    return {id:'XA-'+crypto.randomUUID(),path:target,mime_type:mime||'application/octet-stream',bytes:bytes.length,sha256:hash(bytes)};
  }
  private async downloadArtifact(url:URL):Promise<{data:Buffer;type:string}>{
    if(this.fetcher!==fetch)return this.bytes(url.href,{},64*1024*1024);
    const addresses=await lookup(url.hostname,{all:true});assert(addresses.length>0&&addresses.every(x=>publicAddress(x.address)),'产物地址解析到非公网地址');
    // Pin the validated DNS answer for this connection; no second resolution or redirects.
    return new Promise((resolve,reject)=>{const chosen=addresses[0],request=https.get(url,{lookup:((_host:any,options:any,callback:any)=>options.all?callback(null,[chosen]):callback(null,chosen.address,chosen.family)) as any,signal:AbortSignal.any([this.shutdown.signal,AbortSignal.timeout(90000)])},response=>{
      if(response.statusCode!==200){response.resume();reject(Error('产物下载失败或返回跳转；原任务未重发'));return;}
      const chunks:Buffer[]=[];let size=0;response.on('data',(b:Buffer)=>{size+=b.length;if(size>64*1024*1024){request.destroy(Error('产物超过64MiB限制'));return;}chunks.push(b);});response.once('error',()=>reject(Error('产物下载中断')));response.once('end',()=>resolve({data:Buffer.concat(chunks),type:String(response.headers['content-type']||'')}));
    });request.once('error',()=>reject(Error('产物下载失败；原任务未重发')));});
  }
  private async execute(c:ExternalConnection,operation:string,input:Row,row:Row){
    let secrets:Record<string,string>={},sent=false;try{
      secrets=await this.secrets(c.id);const p=externalPresets.find(p=>p.id===c.preset_id)!;let result:Row;
      const current=this.connection(c.id);assert(!this.shutdown.signal.aborted&&current.enabled,'连接已停用或工作台正在退出',403);
      assert(current.version===c.version,'调用发送前配置已变化，请核对后重新发起',409);
      assert(/\.(?:status|get|retrieve)$/.test(operation)||current.allow_paid,'此连接已关闭生成/消费',403);
      if(p.kind==='agent_mcp'){
        assert(operation==='mcp.call','MCP操作无效');const tools=(c.last_probe as any)?.tools||[];assert(tools.some((t:any)=>t.name===input.tool),'请先检测MCP并选择已枚举的工具');
        const project=this.wb.get('projects',row.project_id),roots=this.scopedRoots(row.project_id,row.allowed_paths),cwd=safePath(c.cwd||(row.allowed_paths?roots[0]:project.source_root||roots[0]),roots);
        sent=true;const reply=await withExternalMcp({...c,cwd},secrets,client=>client.callTool({name:String(input.tool),arguments:input.arguments||{}}),this.shutdown.signal);
        result={status:reply.isError?'failed':'tool_completed',evidence:reply.isError?'tool_failed':'tool_completed',message:reply.isError?'MCP工具返回错误':'MCP工具已返回；远端任务是否完成请按工具结果核实',text:redact(JSON.stringify({...reply,content:(reply.content as any[])?.filter(b=>b.type!=='image')}),secrets).slice(0,128000),artifacts:[]};
        for(const block of (reply.content as any[])||[])if(block.type==='image'&&typeof block.data==='string')result.artifacts.push({type:'image',base64:block.data,mimeType:block.mimeType});
        if(!reply.isError&&result.artifacts.length){result.status='succeeded';result.evidence='local_artifacts_verified';result.message='MCP返回图片已归档；内容质量待核对';}
      }else if(p.kind==='cli'||p.kind==='agent_cli'){
        assert(operation==='cli.invoke','CLI操作无效');const supplied=input.args;assert(Array.isArray(supplied)&&supplied.length<=80&&supplied.every(x=>typeof x==='string'&&x.length<24000),'CLI参数必须为argv数组');const args:string[]=[...supplied];
        assert(!args.some(x=>/^(?:--?(?:yolo|dangerously|bypass|skip-permissions|permission|approval)|--cwd|--directory)/i.test(x)),'调用不得覆盖CLI权限或工作目录');
        assert(!args.some(x=>/^(?:login|logout|uninstall|upgrade|self-update)$/i.test(x)),'账号与安装维护请在客户端由用户操作');
        const roots=this.scopedRoots(row.project_id,row.allowed_paths),cwd=safePath(c.cwd||(row.allowed_paths?roots[0]:this.wb.get('projects',row.project_id).source_root||roots[0]),roots);
        let defaults:string[]=[];
        if(c.preset_id==='dreamina-canvas'){assert(c.region==='cn','当前已核实的Dreamina CLI区域为cn，请先核验其他区域');assert(!args.some(x=>/^--(?:profile|region|format|yes)(?:=|$)/.test(x)),'调用不得覆盖连接的Dreamina配置或跳过积分确认');defaults=['--non-interactive','--format','json','--profile',c.profile,'--region',c.region];}
        let ownedCliOutput:string|undefined;
        if(c.preset_id==='minimax-mmx'){
          defaults=['--non-interactive','--quiet','--output','json'];assert(!args.some(x=>/^--(?:out|out-dir|out-prefix|download|output)(?:=|$)/.test(x)),'mmx输出由工作台固定到本次调用目录');
          if(args[0]==='image'&&args[1]==='generate'){ownedCliOutput=safePath(path.join(cwd,'.agent-workbench-output','external-cli',row.id),roots,true);fs.mkdirSync(ownedCliOutput,{recursive:true});args.push('--out-dir',ownedCliOutput);}
          if(args[0]==='video'&&args[1]==='generate'&&!args.includes('--async'))args.push('--async');
        }
        sent=true;const out=await externalExec(c.executable,[...c.args,...defaults,...args],cwd,externalEnvironment(secrets),c.timeout_ms,typeof input.stdin==='string'?input.stdin:undefined,this.shutdown.signal);
        result={status:'command_completed',text:redact(out,secrets).slice(0,128000),evidence:'command_completed',message:'CLI进程已正常退出；任务结果待按返回JSON和原CLI查询命令核实'};
        try{const data=JSON.parse(out),body=data.data||data,states=[body.status,body.state,body.operation?.status,...(Array.isArray(body.items)?body.items.map((x:any)=>x.state):[])].filter(Boolean).map(v=>String(v).toLowerCase());if(states.some(s=>['pending','queued','submitted','running','processing','accepted'].includes(s))||body.awaitingConfirmation)result.status='submitted';if(data.ok===false||states.some(s=>['failed','error','cancelled','canceled','timeout','timed_out','limit_exceeded'].includes(s))){result.status='failed';result.evidence='command_failed';result.message='CLI明确报告未完成或失败；请检查返回状态，不自动重发';}if(result.status==='submitted'){result.message=body.awaitingConfirmation?'CLI需要积分确认；请先读取报价并按本机schema确认预算':'CLI已受理异步任务；请按本机schema查询原任务，不要重发创建命令';result.evidence='command_accepted';}}catch{}
        if(c.preset_id==='minimax-mmx'){
          let data:any;try{data=JSON.parse(out);}catch{}
          if(data?.taskId&&!data.status){result.status='submitted';result.evidence='command_accepted';result.message='mmx已受理视频任务；使用video task get查询原taskId，不要重复generate';}
          if(ownedCliOutput&&Array.isArray(data?.saved)){result.artifacts=[];for(const file of data.saved){assert(typeof file==='string','mmx产物路径无效');const local=safePath(path.resolve(cwd,file),[ownedCliOutput]);assert(/\.(?:png|jpg|jpeg|webp)$/i.test(local),'mmx产物不是支持的图片');result.artifacts.push({type:'image',base64:readBounded(local,32*1024*1024).toString('base64')});}if(result.artifacts.length){result.status='succeeded';result.evidence='local_artifacts_verified';result.message='mmx产物已读取并归档；生成质量待用户核对';}if(data.failed_count>0){result.status='failed';result.message='mmx部分图片失败；已保存成功产物，勿自动重发整批';}}
        }
      }else{
        const normalized={...input};if(Array.isArray(normalized.images))normalized.images=normalized.images.map((image:any)=>{
          if(image&&typeof image.file_id==='string')return {file_id:image.file_id};
          const value=typeof image==='string'?image:image.image_url;if(typeof value==='string'&&path.isAbsolute(value)){
            const file=safePath(value,this.scopedRoots(row.project_id,row.allowed_paths));assert(!this.wb.privatePath(file)&&!protectedName(file),'不能发送受保护文件',403);
            const mime:Record<string,string>={'.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.webp':'image/webp'};assert(mime[path.extname(file).toLowerCase()],'只接受支持的图片文件');return {image_url:`data:${mime[path.extname(file).toLowerCase()]};base64,${readBounded(file,20*1024*1024).toString('base64')}`};
          }assert(typeof value==='string'&&(value.startsWith('https://')||value.startsWith('data:image/')),'图片引用无效');return typeof image==='string'?{image_url:value}:image;
        });
        if(operation==='image.edit'&&p.protocol==='ark'&&Array.isArray(normalized.images))normalized.image=normalized.images.map((v:any)=>v.image_url);
        const conn={presetId:c.preset_id,baseUrl:c.base_url||p.baseUrl,model:c.model||undefined,region:c.region},request=buildExternalApiRequest(conn,operation,normalized,secrets);
        validateExternalUrl(request.url);assert(new URL(request.url).origin===new URL(conn.baseUrl!).origin,'适配器不能把凭据发送到其他站点');
        sent=true;const response=await this.bytes(request.url,{method:request.method,headers:request.headers,body:request.body===undefined?undefined:JSON.stringify(request.body),signal:AbortSignal.timeout(c.timeout_ms)},32*1024*1024,true);
        let body:any={};try{body=JSON.parse(response.data.toString('utf8'));}catch{assert(response.status>=400,'服务返回的JSON无效');}
        const possibleTask=body?.task_id||body?.data?.task_id||body?.output?.task_id;
        if(response.status>=400){const knownRejection=[400,401,403,404,405,409,410,413,415,422].includes(response.status)&&!possibleTask&&!row.provider_task_id&&!row.provider_file_id;result={status:knownRejection?'failed':'unknown',errorCode:'http_'+response.status,evidence:knownRejection?'provider_rejected':'invocation_not_verified',message:knownRejection?`服务明确拒绝请求（HTTP ${response.status}）；修复配置或参数后请用新的request_id，旧记录保留`:operation==='file.retrieve'?`原文件查询返回HTTP ${response.status}；编号已保留，可继续查询原文件，不要重新生成`:`服务返回HTTP ${response.status}，远端结果仍需核实；不自动重发`,...(typeof possibleTask==='string'&&possibleTask.length<=160?{taskId:possibleTask}:{})};}
        else result=parseExternalApiResponse(conn,operation,body,response.status);
        // A completed provider task may still need a file lookup and download. Commit
        // its identity before either network hop, without claiming local completion.
        if(result.taskId||result.fileId){row.provider_task_id=result.taskId||row.provider_task_id;row.provider_file_id=result.fileId||row.provider_file_id;row.status=result.status==='succeeded'?'running':result.status;row.evidence=result.evidence||'provider_accepted';row.updated_at=now();this.putInvocation(row);}
        if(operation!=='file.retrieve'&&result.status==='succeeded'&&result.fileId&&p.operations.includes('file.retrieve')){
          const fileRequest=buildExternalApiRequest(conn,'file.retrieve',{fileId:result.fileId},secrets);
          assert(new URL(fileRequest.url).origin===new URL(conn.baseUrl!).origin,'文件查询地址不匹配');
          const fileResponse=await this.bytes(fileRequest.url,{method:fileRequest.method,headers:fileRequest.headers,signal:AbortSignal.timeout(c.timeout_ms)},32*1024*1024,true);
          if(fileResponse.status>=400)result={...result,status:'unknown',errorCode:'http_'+fileResponse.status,evidence:'invocation_not_verified',message:`供应商已返回任务和文件编号，但文件查询返回HTTP ${fileResponse.status}；可继续查询原文件，不要重新生成`};
          else result={...result,...parseExternalApiResponse(conn,'file.retrieve',JSON.parse(fileResponse.data.toString('utf8')),fileResponse.status)};
        }
      }
      row.status=result.artifacts?.length?'running':result.status;row.provider_task_id=result.taskId||row.provider_task_id;row.provider_file_id=result.fileId||row.provider_file_id;row.text=result.text?redact(String(result.text),secrets):undefined;row.tool_calls=result.toolCalls?JSON.parse(redact(JSON.stringify(result.toolCalls),secrets)):undefined;row.usage=result.usage;row.error_code=result.errorCode;
      // Persist accepted provider identity before downloads; an artifact failure must not repeat creation.
      row.updated_at=now();this.putInvocation(row);
      for(const [i,a]of (result.artifacts||[]).entries()){const saved=await this.archive(a,row,i);if(saved)row.artifacts.push(saved);}
      row.status=result.status;row.message=result.message||(result.status==='succeeded'?'调用完成；以实际产物和服务结果为准':result.status==='submitted'?'任务已受理，查询会继续检查原任务进度':'请查看当前状态');row.evidence=result.evidence||(result.status==='succeeded'?'invocation_verified':result.status==='failed'?'invocation_failed':'provider_accepted');
    }catch(error){row.status=sent?'unknown':'failed';row.error_code=undefined;row.message=redact(error instanceof Error?error.message:'调用未完成',secrets).slice(0,400);if(sent&&row.provider_file_id)row.message='已知的任务/文件编号已保留，文件获取未完成；可继续查询原文件，不要重新生成。'+row.message;row.evidence=sent?'invocation_not_verified':'not_sent';}
    row.updated_at=now();this.putInvocation(row);
  }
  artifact(invocationId:string,artifactId:string,caller?:ExternalCaller){const row=this.invocation(invocationId,caller),artifact=row.artifacts.find((a:any)=>a.id===artifactId);assert(artifact,'产物不存在',404);const file=safePath(artifact.path,this.scopedRoots(row.project_id,row.allowed_paths));if(caller?.allowed_paths)safePath(file,this.scopedRoots(row.project_id,caller.allowed_paths));assert(!this.wb.privatePath(file),'产物不可访问',403);const bytes=readBounded(file,64*1024*1024);assert(bytes.length===artifact.bytes&&hash(bytes)===artifact.sha256,'产物已被修改，不能返回原验证结果',409);const mime=imageMime(bytes),preview=mime&&mime===artifact.mime_type&&bytes.length<=8*1024*1024?{inline_image:{mime_type:mime,data:bytes.toString('base64')}}:{};return {...artifact,path:file,...preview};}
  authenticate(token:string):ExternalCaller|undefined{if(!token)return;const r=this.wb.db.prepare('SELECT data FROM external_grants WHERE token_hash=?').get(hash(token)) as any;if(!r)return;const grant=JSON.parse(r.data);if(grant.revoked)return;
    if(grant.run_id){const run=this.wb.maybe('runs',grant.run_id),task=run&&this.wb.maybe('tasks',run.task_id);if(!run||!task||task.current_run_id!==run.id||['cancelled','accepted','rework_linked'].includes(task.status))return;}
    if(grant.review_id){const assignment=this.wb.maybe('review_assignments',grant.review_id);if(!assignment||assignment.run_id!==grant.run_id||assignment.reviewer_id!==grant.agent_id||['cancelled','superseded'].includes(assignment.status))return;}
    return {id:grant.id,agent_id:grant.agent_id,project_id:grant.project_id,run_id:grant.run_id,kind:'bridge',image_only:true};}
  async createImageGrant(projectId:string,agentId:string,file:string){
    this.wb.roots(this.wb.get('projects',projectId));this.wb.get('agents',agentId);
    const expected=path.join(this.wb.config.dataDir,'external-tools','harness-image-bridge.json');
    assert(path.resolve(file).toLowerCase()===path.resolve(expected).toLowerCase(),'桥接凭据只能保存到专用文件',403);
    return this.issueImageGrant(projectId,agentId,expected);
  }
  private async issueImageGrant(projectId:string,agentId:string,file:string,runId?:string,reviewId?:string){
    const token=crypto.randomBytes(32).toString('hex'),id='XG-'+crypto.randomUUID();
    const protected_token=await this.vault.encrypt({token});const target=safePath(file,[this.wb.config.dataDir],true);
    assert(!fs.existsSync(target)||(!fs.lstatSync(target).isSymbolicLink()&&fs.statSync(target).isFile()),'凭据目标不是普通文件',403);
    atomicWrite(target,JSON.stringify({schema:1,base_url:`http://127.0.0.1:${this.wb.config.port}`,protected_token}));
    this.wb.transaction(()=>{for(const old of this.rows('external_grants'))if(old.file===target){old.revoked=true;this.wb.db.prepare('UPDATE external_grants SET data=? WHERE id=?').run(JSON.stringify(old),old.id);}this.wb.db.prepare('INSERT INTO external_grants(id,token_hash,data)VALUES(?,?,?)').run(id,hash(token),JSON.stringify({id,project_id:projectId,agent_id:agentId,run_id:runId,review_id:reviewId,file:target,created_at:now()}));});return {id,path:target};
  }
  async headlessPatch(runId:string,reviewId?:string){
    const run=this.wb.get('runs',runId),task=this.wb.get('tasks',run.task_id),review=reviewId?this.wb.get('review_assignments',reviewId):undefined;
    assert(!review||review.run_id===runId,'审查不属于此Run',403);const agentId=review?.reviewer_id||run.agent_id;
    const caller:ExternalCaller={id:reviewId?'reviewer:'+reviewId:'runner:'+runId,agent_id:agentId,project_id:task.project_id,run_id:runId,kind:review?'reviewer':'runner'};
    if(!this.vault.available||!this.list(caller).services.some(s=>s.operations.includes('image.generate')))return [];
    const root=this.wb.config.root,scriptPath=path.join(root,'scripts','external-image-mcp.ts');if(!fs.existsSync(scriptPath))return [];
    const file=safePath(path.join(this.wb.config.dataDir,'external-tools',(reviewId||runId)+'.json'),[this.wb.config.dataDir],true);
    const existing=this.rows('external_grants').find(g=>g.run_id===runId&&g.review_id===reviewId&&g.agent_id===agentId&&g.file===file&&!g.revoked);
    if(!existing||!fs.existsSync(file))await this.issueImageGrant(task.project_id,agentId,file,runId,reviewId);
    return harnessImagePatch({nodePath:process.execPath,scriptPath,loaderPath:createRequire(path.join(root,'package.json')).resolve('tsx'),credentialFile:file,cwd:root});
  }
}
