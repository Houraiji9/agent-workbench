import { z } from 'zod';
import fs from 'node:fs';
import path from 'node:path';
import { hash, now, assert, safePath, DomainError } from '../core/security.ts';
import type { Row } from '../core/schema.ts';
import type { Workbench } from '../core/workbench.ts';
import { syncQuotaCache } from '../core/quota-cache.ts';
import { normalizeTokenMonitorDetails } from '../core/token-monitor-usage.ts';
const windowSchema=z.object({kind:z.string(),label:z.string().optional(),usedPercent:z.number().min(0).max(100).nullable().optional(),remainingPercent:z.number().min(0).max(100).nullable().optional(),resetsAt:z.string().nullable().optional(),remaining:z.number().nullable().optional(),limit:z.number().nullable().optional(),currency:z.string().nullable().optional()}).passthrough();
const providerSchema=z.object({provider:z.string(),accountKey:z.string().optional(),status:z.string(),updatedAt:z.string().optional(),windows:z.array(windowSchema),balance:z.object({amount:z.number().nullable(),currency:z.string()}).passthrough().nullable().optional()}).passthrough();
const timestamp=(v:unknown)=>typeof v==='string'&&Number.isFinite(Date.parse(v))?Date.parse(v):0;
const ageStale=(v:unknown)=>!timestamp(v)||Date.now()-timestamp(v)>600000||timestamp(v)>Date.now()+300000;
// Quota observations and session usage have independent clocks. A late quota response must not
// replace newer session usage; a missing usage timestamp cannot supersede a dated snapshot.
export function latestTokenUsage(snapshot:Row,previous?:Row){return previous?.usage_details&&timestamp(previous.usage_details.updated_at)>timestamp(snapshot.usage_details?.updated_at)?{...snapshot,usage:previous.usage,usage_details:previous.usage_details,usage_updated_at:previous.usage_updated_at}:snapshot;}
const usageSchema=z.object({totalTokens:z.number().nonnegative(),costUsd:z.number().nonnegative().optional(),cacheReadTokens:z.number().nonnegative().optional(),outputTokens:z.number().nonnegative().optional(),clients:z.record(z.number().nonnegative()).optional()});
const providerNames:Record<string,string>={codex:'Codex',grok:'Grok',kimi:'Kimi',deepseek:'DeepSeek',zai:'智谱 / Zcode',workbuddy:'WorkBuddy',antigravity:'Antigravity',cursor:'Cursor',claude:'Claude'};
export function normalizeTokenStats(input:unknown){
  const raw=z.object({limits:z.object({updatedAt:z.string().optional(),providers:z.array(providerSchema)}),updatedAt:z.string().optional(),generatedAt:z.string().optional(),today:z.object({totalTokens:z.number(),costUsd:z.number().optional()}).passthrough().optional(),periods:z.record(z.any()).optional()}).passthrough().parse(input);
  const dedup=new Map<string,z.infer<typeof providerSchema>>();for(const p of raw.limits.providers){const key=p.provider+':'+(p.accountKey||'unknown-account');const prev=dedup.get(key);if(!prev||timestamp(p.updatedAt)>timestamp(prev.updatedAt))dedup.set(key,p)}
  const pools:Row[]=[],windows:Row[]=[];for(const [key,p]of dedup){const poolId='TM-'+hash(key).slice(0,24);pools.push({id:poolId,name:providerNames[p.provider]||p.provider,provider:p.provider,account_ref:p.accountKey?hash(p.accountKey).slice(0,24):'unknown',status:p.status,mapping_status:'source_reported',members:[],balance:p.balance?{amount:p.balance.amount,currency:p.balance.currency}:null,source:'token_monitor',source_updated_at:p.updatedAt||raw.limits.updatedAt||null,collected_at:now(),freshness:p.stale===true||ageStale(p.updatedAt||raw.limits.updatedAt)?'stale':'fresh'});for(const [i,w]of p.windows.entries())windows.push({id:poolId+':'+w.kind+':'+i,pool_id:poolId,kind:w.kind,label:w.label||null,used_percent:w.usedPercent??null,remaining_percent:w.remainingPercent??(w.usedPercent!=null?100-w.usedPercent:null),resets_at:w.resetsAt??null,remaining:w.remaining??null,limit:w.limit??null,unit:w.currency||(w.usedPercent!=null||w.remainingPercent!=null?'percent':'unknown'),source:'token_monitor',source_updated_at:p.updatedAt||raw.limits.updatedAt||null,collected_at:now()})}
  const usage=usageSchema.safeParse(raw.today||raw.periods?.today);
  return {pools,windows,usage:usage.success?usage.data:null,usage_details:normalizeTokenMonitorDetails(raw),usage_updated_at:raw.updatedAt||raw.generatedAt||raw.limits.updatedAt||null,source_updated_at:raw.limits.updatedAt||raw.updatedAt||raw.generatedAt||null,cost_semantics:'API 等价估算价，不代表实际订阅扣费'};
}
export function normalizeSessions(input:unknown){const raw=z.object({sessions:z.array(z.object({id:z.string(),agent:z.string(),project:z.string().optional(),display_name:z.string().nullable().optional(),first_message:z.string().nullable().optional(),cwd:z.string().nullable().optional(),started_at:z.string().nullable().optional(),ended_at:z.string().nullable().optional(),web_url:z.string().optional(),message_count:z.number().optional()}).passthrough()),next_cursor:z.string().nullable().optional(),total:z.number().optional()}).parse(input);return {items:raw.sessions.map(s=>({native_id:s.id,source_id:s.id,agent:s.agent,title:s.display_name||(s.first_message||'').slice(0,100)||s.id,source_cwd:s.cwd||null,summary:(s.first_message||'').slice(0,1000),source_project:s.project||null,source:'agentsview',coverage:'summary_only',web_url:s.web_url||null,started_at:s.started_at||null,updated_at:s.ended_at||s.started_at||null,association:'pending_confirmation',message_count:s.message_count??null})),next_cursor:raw.next_cursor||null,total:raw.total??null}}
const transportCodes=new Set(['ECONNREFUSED','ECONNRESET','ETIMEDOUT','ENOTFOUND','EAI_AGAIN','EHOSTUNREACH','ENETUNREACH','UND_ERR_CONNECT_TIMEOUT','UND_ERR_HEADERS_TIMEOUT','UND_ERR_BODY_TIMEOUT','UND_ERR_SOCKET','ABORT_ERR']);
/** Retain diagnostic categories only; network exception text may contain private addresses or queries. */
export function integrationError(error:unknown){
  const e=error as {name?:string;code?:unknown;cause?:{code?:unknown}}|null;
  const raw=e?.cause?.code??e?.code,code=typeof raw==='string'&&transportCodes.has(raw)?raw:null;
  const timeout=e?.name==='TimeoutError'||!!code&&/TIMEOUT|TIMEDOUT/.test(code);
  const contract=error instanceof z.ZodError||error instanceof SyntaxError;
  const http=error instanceof DomainError?error.message.match(/^外部接口返回 HTTP (\d{3})$/)?.[1]:undefined;
  return {error_kind:timeout?'timeout':code==='ECONNREFUSED'?'connection_refused':e?.name==='AbortError'?'aborted':contract?'contract':http?'http':error instanceof DomainError?'validation':'transport',error_code:http?'HTTP_'+http:code,
    error:timeout?'数据源请求超时':code==='ECONNREFUSED'?'数据源端口拒绝连接（ECONNREFUSED）':e?.name==='AbortError'?'数据源请求已取消':contract?'外部响应结构与已核验契约不一致':error instanceof DomainError?error.message:'数据源连接失败'+(code?'（'+code+'）':'')};
}
export class Integrations {
  controllers=new Set<AbortController>();timer?:NodeJS.Timeout;stopped=false;next=new Map<string,number>();failures=new Map<string,number>();inFlight=new Map<string,Promise<Row>>();
  constructor(public wb:Workbench,public idleMs=90000){}
  config(key:string){assert(['tokenMonitor','agentsView'].includes(key),'未知数据源');const c=this.wb.config.integrations[key as 'tokenMonitor'];assert(c?.baseUrl,'数据源未连接：请配置 config/local.json',503);const u=new URL(c.baseUrl);assert(['http:','https:'].includes(u.protocol)&&!u.username&&!u.password&&!u.search&&!u.hash,'数据源 URL 无效');assert(u.protocol==='https:'||['127.0.0.1','localhost','[::1]'].includes(u.hostname),'HTTP 只允许回环地址');return c}
  headers(key:string):Record<string,string>{const c=this.config(key);let token=c.secretEnv?process.env[c.secretEnv]:undefined;if(c.secretFile){let f:string;try{f=safePath(path.resolve(this.wb.config.root,c.secretFile),[this.wb.config.dataDir])}catch{throw new DomainError('请将连接密钥文件放在工作台 data 目录内，并核对 secretFile 路径（例如 data/integrations/private/token-monitor.key）')};assert(fs.statSync(f).size<=4096,'数据源凭据文件过大');token=fs.readFileSync(f,'utf8').trim()}if(c.secretFile||c.secretEnv)assert(token,'缺少数据源连接凭据',503);return token?{Authorization:`Bearer ${token}`}:{}}
  async get(key:string,endpoint:string){
    if(this.stopped)throw new DOMException('数据源已停止','AbortError');
    const controller=new AbortController(),signal=AbortSignal.any([controller.signal,AbortSignal.timeout(8000)]);this.controllers.add(controller);
    let reader:ReadableStreamDefaultReader<Uint8Array>|undefined;
    try{
      const c=this.config(key),response=await fetch(c.baseUrl.replace(/\/$/,'')+endpoint,{headers:this.headers(key),signal,redirect:'error'});
      assert(response.ok,`外部接口返回 HTTP ${response.status}`,502);assert(Number(response.headers.get('content-length')||0)<8*1024*1024,'外部响应超出上限');
      reader=response.body!.getReader();const chunks:Uint8Array[]=[];let size=0;
      while(true){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;assert(size<8*1024*1024,'外部响应超出上限');chunks.push(value)}
      return JSON.parse(Buffer.concat(chunks).toString('utf8'));
    }catch(error){if(signal.aborted)throw signal.reason;throw error}
    finally{await reader?.cancel().catch(()=>{});controller.abort();this.controllers.delete(controller);}
  }
  success(key:string,snapshot:Row){if(this.stopped)return snapshot;const r=this.wb.get('integrations',key);this.wb.transaction(()=>{this.wb.put('integrations',{...r,status:'connected',last_success:now(),last_attempt:now(),snapshot,error:null,error_kind:null,error_code:null,observation:snapshot.coverage==='partial_page'?'live_page_verified':'live_read_verified'});});this.failures.set(key,0);return snapshot}
  failure(key:string,error:unknown){if(this.stopped)return {status:'stopped'};const r=this.wb.get('integrations',key);const configured=!!this.wb.config.integrations[key as 'tokenMonitor']?.baseUrl;this.wb.transaction(()=>{this.wb.put('integrations',{...r,status:r.snapshot?'stale':configured?'offline':'not_connected',last_attempt:now(),...integrationError(error)});for(const p of this.wb.all('quota_pools').filter(p=>key==='tokenMonitor'&&p.source==='token_monitor'))this.wb.put('quota_pools',{...p,freshness:'stale'})});const count=(this.failures.get(key)||0)+1;this.failures.set(key,count);this.next.set(key,Date.now()+Math.min(300000,15000*2**Math.min(count,5)));return this.wb.get('integrations',key)}
  saveToken(raw:unknown){if(this.stopped)return {status:'stopped'};const snapshot=normalizeTokenStats(raw),previous=this.wb.get('integrations','tokenMonitor').snapshot;
    const time=(s:Row)=>Math.max(timestamp(s?.source_updated_at),...(s?.pools||[]).map((p:Row)=>timestamp(p.source_updated_at)),0);
    assert(time(snapshot)>0&&time(snapshot)<=Date.now()+300000&&snapshot.pools.every(p=>timestamp(p.source_updated_at)>0&&timestamp(p.source_updated_at)<=Date.now()+300000),'额度来源时间无效或超前，保留最后有效快照');
    const older=!!previous&&time(snapshot)<time(previous),incomingIds=new Set(snapshot.pools.map(p=>p.id));
    this.wb.transaction(()=>{
      if(!older)for(const p of snapshot.pools){const old=this.wb.maybe('quota_pools',p.id);if(old&&timestamp(p.source_updated_at)<=timestamp(old.source_updated_at)){this.wb.put('quota_pools',{...old,source_presence:'present',source_missing_since:null,freshness:ageStale(old.source_updated_at)||(timestamp(p.source_updated_at)===timestamp(old.source_updated_at)&&p.freshness==='stale')?'stale':'fresh'});continue;}this.wb.put('quota_pools',{...p,source_presence:'present',source_missing_since:null});this.wb.db.prepare('DELETE FROM quota_windows WHERE pool_id=?').run(p.id);for(const w of snapshot.windows.filter(w=>w.pool_id===p.id))this.wb.put('quota_windows',w,{pool_id:w.pool_id})}
      for(const p of this.wb.all('quota_pools').filter(p=>p.source==='token_monitor')){
        const missing=!older&&(!previous||time(snapshot)>time(previous))&&!incomingIds.has(p.id);
        if(missing)this.wb.put('quota_pools',{...p,source_presence:'missing',source_missing_since:p.source_missing_since||now(),freshness:'stale'});
        else if(ageStale(p.source_updated_at)&&p.freshness!=='stale')this.wb.put('quota_pools',{...p,freshness:'stale'});
      }
      if(!older)syncQuotaCache(this.wb,snapshot.pools,snapshot.windows);
    });
    // Successful transport is independent from the quota watermark: late data cannot
    // overwrite newer quotas, but it still proves the source is reachable again.
    const pools=this.wb.all('quota_pools').filter(p=>p.source==='token_monitor'),windows=this.wb.all('quota_windows').filter(w=>w.source==='token_monitor'),present=pools.filter(p=>p.source_presence!=='missing');
    const accepted={...(older?latestTokenUsage(previous,snapshot):latestTokenUsage(snapshot,previous)),pools,windows,data_freshness:present.length?present.every(p=>p.freshness==='fresh')?'fresh':'stale':'unknown',pool_count:pools.length,source_pool_count:present.length,missing_pool_count:pools.length-present.length};this.success('tokenMonitor',accepted);return accepted}
  refresh(key:string,cursor=''):Promise<Row>{
    if(this.stopped)return Promise.resolve({status:'stopped'});
    const existing=this.inFlight.get(key);if(existing)return existing;
    const pending=this.refreshOnce(key,cursor).finally(()=>{
      if(this.inFlight.get(key)===pending)this.inFlight.delete(key);
      if(!this.stopped&&!this.failures.get(key))this.next.set(key,Date.now()+60000);
    });
    this.inFlight.set(key,pending);return pending;
  }
  private async refreshOnce(key:string,cursor=''){try{if(key==='tokenMonitor')return this.saveToken(await this.get(key,'/api/stats'));
    let next=cursor,total:number|null=null,read=0,pages=0;const seen=new Set<string>();
    do {
      seen.add(next);
      const page=normalizeSessions(await this.get(key,'/api/v1/sessions?include_one_shot=true&include_automated=true&include_children=true&limit=50'+(next?'&cursor='+encodeURIComponent(next):'')));
      if(this.stopped)return {status:'stopped'};
      const existingSessions=new Map(this.wb.all('sessions').map(s=>[s.agent+'\0'+s.native_id,s])),projectsInScope=this.wb.all('projects');
      this.wb.transaction(()=>{for(const s of page.items){
        const old=existingSessions.get(s.agent+'\0'+s.native_id);
        if(old&&timestamp(old.agentsview_updated_at)>timestamp(s.updated_at))continue;
        // Exact registered cwd only; a matching project name is not enough.
        const projects=s.source_cwd?projectsInScope.filter(p=>p.paths.some((p:string)=>path.resolve(p)===path.resolve(s.source_cwd!))):[];
        this.wb.upsertSession({...s,...(!old?.project_id&&projects.length===1?{project_id:projects[0].id,association:'exact_registered_cwd'}:{}),agentsview_updated_at:s.updated_at},'source',existingSessions);
      }});
      read+=page.items.length;pages++;total=page.total;next=page.next_cursor||'';
    }while(next&&!seen.has(next)&&pages<10&&!this.stopped);
    if(this.stopped)return {status:'stopped'};
    const imported=this.wb.all('sessions').filter(s=>s.sources?.some((x:Row)=>x.source==='agentsview')).length;
    return this.success(key,{next_cursor:next||null,total,read_count:read,imported_count:imported,coverage:next||total==null?'partial_page':'returned_page',note:`已收录 ${imported} 条真实会话；本次读取 ${read} 条。${next?'还有后续记录，可继续读取。':'当前来源返回的记录已读完。'}仅摘要常驻，正文按需读取。`});
    }catch(e){return this.failure(key,e)}}
  async search(filters:Row){
    assert(typeof filters.query==='string'&&filters.query.trim().length>0&&filters.query.length<=200,'请输入 1—200 字搜索词');
    const params=new URLSearchParams({pattern:filters.query,mode:'substring',limit:'30',include_one_shot:'true',include_automated:'true',include_children:'true',reveal:'false'});
    for(const [from,to]of [['agent','agent'],['source_project','project'],['from','date_from'],['to','date_to']])if(filters[from])params.set(to,String(filters[from]).slice(0,200));
    if(filters.cursor!==undefined)params.set('cursor',String(Math.max(0,Math.floor(Number(filters.cursor)||0))));
    try{const raw=await this.get('agentsView','/api/v1/search/content?'+params);const result=z.object({matches:z.array(z.object({session_id:z.string(),project:z.string().optional(),machine:z.string().optional(),display_name:z.string().nullable().optional(),ordinal:z.number(),ordinal_range:z.array(z.number()).optional(),location:z.string(),snippet:z.string()}).passthrough()),next_cursor:z.number().nullable().optional()}).parse(raw);
      return {source:'agentsview',coverage:'search_snippets',collected_at:now(),items:result.matches.map(m=>({native_id:m.session_id,title:m.display_name||m.session_id,source_project:m.project||null,ordinal:m.ordinal,ordinal_range:m.ordinal_range||[m.ordinal,m.ordinal],location:m.location,snippet:m.snippet,source:'agentsview',association:'pending_confirmation'})),next_cursor:result.next_cursor??null};
    }catch(e){throw e}
  }
  async sessionPage(sid:string,from=0){if(this.stopped)throw new DOMException('数据源已停止','AbortError');const s=this.wb.get('sessions',sid);const source=s.sources.find((x:Row)=>x.source==='agentsview');assert(source,'此记录仅有接单摘要，无法取得完整会话',404);try{const [detail,messages]=await Promise.all([this.get('agentsView','/api/v1/sessions/'+encodeURIComponent(source.source_id)),this.get('agentsView',`/api/v1/sessions/${encodeURIComponent(source.source_id)}/messages?from=${Math.max(0,Math.floor(from))}&limit=30&direction=asc`)]);const result=z.object({messages:z.array(z.object({ordinal:z.number(),role:z.string(),content:z.string(),timestamp:z.string().optional()})),count:z.number().optional()}).parse(messages);return {source:'agentsview',native_id:source.source_id,detail, ...result,coverage:'partial_page',complete_session:false,next_from:result.messages.length>0?result.messages.at(-1)!.ordinal+1:null}}catch(e){throw e}}
  // Start each idle period after local snapshot writes finish, so slow storage does
  // not consume the upstream heartbeat allowance while the event loop is blocked.
  async stream(){let delay=1000;while(!this.stopped){let controller:AbortController|undefined,idle:NodeJS.Timeout|undefined,expectedReconnect=false;
    const resetIdle=()=>{clearTimeout(idle);idle=setTimeout(()=>{expectedReconnect=true;controller?.abort()},this.idleMs);idle.unref()};
    try{const c=this.config('tokenMonitor');controller=new AbortController();this.controllers.add(controller);resetIdle();const response=await fetch(c.baseUrl.replace(/\/$/,'')+'/api/stats/stream',{headers:this.headers('tokenMonitor'),signal:controller.signal,redirect:'error'});assert(response.ok&&response.headers.get('content-type')?.includes('text/event-stream'),'SSE 不可用');const reader=response.body!.getReader(),decoder=new TextDecoder();let buffer='';while(!this.stopped){const {value,done}=await reader.read();if(done)break;assert(value.byteLength<8*1024*1024,'SSE 数据块过大');buffer=(buffer+decoder.decode(value,{stream:true})).replace(/\r\n/g,'\n');assert(buffer.length<8*1024*1024,'SSE 消息过大');let index;while((index=buffer.indexOf('\n\n'))>=0){const block=buffer.slice(0,index);buffer=buffer.slice(index+2);const type=block.match(/^event: ?(.+)$/m)?.[1];if(['snapshot','stats'].includes(type||'')){const data=block.split('\n').filter(x=>x.startsWith('data:')).map(x=>x.slice(5).trimStart()).join('\n');const payload=JSON.parse(data);this.saveToken(payload?.type==='stats'&&payload.stats?payload.stats:payload);delay=1000}}resetIdle();}delay=Math.min(delay*2,60000)}catch(e){if(!this.stopped&&!expectedReconnect)this.failure('tokenMonitor',e);delay=Math.min(delay*2,60000)}finally{clearTimeout(idle);if(controller){controller.abort();this.controllers.delete(controller)}}if(!this.stopped)await new Promise(r=>{const timer=setTimeout(r,delay);timer.unref()})}}
  poll(){
    if(this.stopped)return;
    for(const k of ['tokenMonitor','agentsView'])if(this.wb.config.integrations[k as 'tokenMonitor']?.baseUrl&&!this.inFlight.has(k)&&Date.now()>=(this.next.get(k)||0))void this.refresh(k,k==='agentsView'?this.wb.get('integrations',k).snapshot?.next_cursor||'':'');
  }
  start(){if(this.stopped||this.timer)return;this.poll();if(this.wb.config.integrations.tokenMonitor?.baseUrl)void this.stream();this.timer=setInterval(()=>this.poll(),15000);this.timer.unref()}
  stop(){this.stopped=true;clearInterval(this.timer);this.timer=undefined;for(const c of this.controllers)c.abort()}
}
