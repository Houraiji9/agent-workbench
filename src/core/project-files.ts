import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {assert,inside,safePath,protectedName,DomainError} from './security.ts';

type Row=Record<string,any>;
export type FileCategory='deliverable'|'source'|'process'|'test'|'backup'|'unknown';
export type FileValidity='current'|'historical'|'invalid'|'unknown';
export type FileRetention='keep'|'cleanup_candidate'|'moved';
export type FileEntry=FileCategory|'invalid'|'cleanup';
export const PROJECT_FILE_ENTRIES=[
  {id:'deliverable',label:'成果'}, {id:'source',label:'源码'}, {id:'process',label:'过程文件'},
  {id:'test',label:'测试'}, {id:'backup',label:'备份'}, {id:'invalid',label:'无效文件'},
  {id:'cleanup',label:'待清理'},
] as const;
export const DEFAULT_PROJECT_FILE_ENTRY='deliverable';
export interface ProjectFilesWorkbench {
  config:{authorizedRoots:string[];dataDir:string};
  all(table:string):Row[];
  get(table:string,id:string):Row;
  put(table:string,row:Row,refs?:Record<string,any>):void;
  roots(project:Row):string[];
  privatePath(file:string):boolean;
}
export interface UserFileAction {actor:'user'}
/** Identity is supplied by the authenticated service caller, never tool input. */
export interface AgentFileAction {actor:'agent';actor_id:string;run_id?:string;task_id?:string;project_ids?:string[]}
export interface FileClassification {
  actor:'user'|'agent'|'rule'|'artifact';actor_id:string|null;run_id:string|null;task_id:string|null;
  purpose:string;reason:string;recorded_at:string;revision:number;
}
export interface FileSource {artifact_id:string;task_id:string;run_id:string;agent_id:string|null;sha256:string|null;current:boolean;label:string|null}
export interface ProjectFile extends Row {
  id:string;project_id:string;path:string;category:FileCategory;validity:FileValidity;retention:FileRetention;
  purpose:string;cleanup_reason:string|null;classification_source:'user'|'agent'|'rule'|'artifact'|'unknown';
  revision?:number;classification?:FileClassification;classification_reason?:string;classification_stale?:boolean;snapshot_warning?:string|null;
  sources:FileSource[];bytes:number|null;mtime:string|null;observed_at:string;
}
export interface ScanLimits {maxEntries?:number;maxFiles?:number;maxDepth?:number;maxMilliseconds?:number;maxIssues?:number}
export interface ScanResult {
  files:ProjectFile[];coverage:{roots:string[];scope:string;partial?:boolean;project_roots?:string[];visitedEntries:number;visitedDirectories:number;observedFiles:number;
    complete:boolean;truncated:boolean;reasons:string[];unknown:number;skipped:number;issues:{path:string;reason:string}[];observed_at:string};
}
export interface ReferenceReport {references:{entity:string;id:string;reason:string}[];boundary:string;global:'unknown';complete:boolean}
export interface MoveOptions {
  /** Service-owned OS exclusive-open check. Never accept this result from a page/MCP request. */
  probeOccupancy?:(file:string)=>'available'|'busy'|'unknown';
  /** Service-owned native, same-volume move that MUST fail if destination exists. */
  moveNoReplace?:(source:string,destination:string)=>void;
}
export interface MoveSelection {id:string;sourceDeclaration:'user_created_temporary';reason:string}
export interface FileMove extends Row {
  id:string;project_id:string;file_id:string;original_path:string;destination_path:string;manifest_path:string;
  sha256:string|null;bytes:number|null;status:'prepared'|'moved'|'failed'|'restored'|'restore_failed'|'uncertain';
  reason:string;created_at:string;error?:string;reference_check:ReferenceReport;
  reconciliation?:{observed_at:string;location:'original_only'|'destination_only'|'both'|'neither'|'unverified';action?:'already_original'|'moved_to_original';message?:string};
}
const categories:FileCategory[]=['deliverable','source','process','test','backup','unknown'];
const validities:FileValidity[]=['current','historical','invalid','unknown'];
const retentions:FileRetention[]=['keep','cleanup_candidate','moved'];
const sourceExtensions=new Set(['.ts','.tsx','.js','.jsx','.mjs','.cjs','.json','.jsonc','.yaml','.yml','.toml','.ini','.cfg','.py','.ps1','.sh','.bat','.cmd','.cs','.cpp','.c','.h','.hpp','.rs','.go','.java','.vue','.svelte','.html','.css','.scss','.sql','.unity','.prefab','.asset','.meta','.sln','.csproj']);
const internalNames=/^(?:data|\.git|\.codex|node_modules|\.ssh|\.aws|\.gnupg|\.kube|run-keys|review-keys|runs?|reviews?|待清理)$/i;
const backupNames=/(?:^|[._ -])(?:backup|backups|bak|备份)(?:$|[._ -])|\.(?:bak|backup|old)$/i;
const sourceNames=/^(?:AGENTS(?:_.*)?\.md|README(?:\..*)?|CHANGELOG(?:\..*)?|LICENSE(?:\..*)?|NOTICE(?:\..*)?|Makefile|Dockerfile(?:\..*)?|CMakeLists\.txt|\.gitignore|\.gitattributes|\.editorconfig|yarn\.lock)$/i;
const stamp=()=>new Date().toISOString();
const key=(value:string)=>process.platform==='win32'?path.resolve(value).toLowerCase():path.resolve(value);
const errorText=(error:unknown)=>error instanceof Error?error.message:'操作失败';
function user(action:UserFileAction){assert(action?.actor==='user','文件管理操作仅允许用户页面调用',403)}
function id(prefix:string){return prefix+'-'+crypto.randomUUID()}
function blocked(file:string){return protectedName(file)||file.split(/[\\/]/).some(part=>internalNames.test(part))||/\.(?:pem|p12|pfx|key|sqlite|sqlite3|db)(?:-|$|\.)/i.test(path.basename(file))}

class FileLinkError extends DomainError {constructor(){super('禁止访问链接或目录重定向',403)}}
function parentContainsEntry(parent:string,name:string){
  let directory:fs.Dir;
  try{directory=fs.opendirSync(parent)}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return false;throw error}
  try{
    for(let count=0;count<4096;count++){
      const entry=directory.readSync();if(!entry)return false;
      if((process.platform==='win32'?entry.name.toLowerCase():entry.name)===(process.platform==='win32'?name.toLowerCase():name))return true;
    }
    assert(false,'目录项超过链接核验上限，保留原地',409);
  }finally{directory.closeSync()}
}
/** lstat/Dirent can miss a Windows junction. Compare each resolved ancestor with
 * the canonical parent plus its literal entry, before using any resolved path.
 */
function noLinks(file:string,allowNew=false){
  assert(path.isAbsolute(file),'需要本机绝对路径');
  let cursor=path.parse(path.resolve(file)).root;
  let canonicalParent=fs.realpathSync.native(cursor);
  if(key(canonicalParent)!==key(cursor))throw new FileLinkError();
  for(const segment of path.relative(cursor,path.resolve(file)).split(path.sep).filter(Boolean)){
    const parent=cursor,expected=path.join(canonicalParent,segment);cursor=path.join(cursor,segment);
    let stat:fs.Stats;
    try{stat=fs.lstatSync(cursor)}catch(error){
      if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;
      // Some Windows APIs report ENOENT for the target of a dangling junction.
      // A still-present directory entry must never be treated as a new path.
      if(parentContainsEntry(parent,segment))throw new FileLinkError();
      assert(allowNew,'路径不存在',404);canonicalParent=expected;continue;
    }
    if(stat.isSymbolicLink())throw new FileLinkError();
    let resolved:string;
    try{resolved=fs.realpathSync.native(cursor)}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')throw new FileLinkError();throw error}
    if(key(resolved)!==key(expected))throw new FileLinkError();
    canonicalParent=resolved;
  }
}
function projectRoots(wb:ProjectFilesWorkbench,pid:string){
  const project=wb.get('projects',pid);
  const roots=(project.paths||[]).map((root:string)=>{noLinks(root);const real=safePath(root,wb.config.authorizedRoots);assert(!wb.privatePath(real)&&!blocked(real),'项目根属于内部或受保护目录',403);assert(fs.statSync(real).isDirectory(),'项目根目录不可用',404);return real});
  assert(roots.length>0,'项目没有授权目录');return {project,roots:[...new Set<string>(roots)]};
}
function authorized(wb:ProjectFilesWorkbench,pid:string,file:string,allowNew=false,allowCleanup=false){
  const {roots}=projectRoots(wb,pid);noLinks(file,allowNew);
  const real=safePath(file,roots,allowNew);safePath(real,wb.config.authorizedRoots,allowNew);
  // 待清理 is permitted only for this module's own recorded destinations.
  const guarded=allowCleanup?real.split(path.sep).filter(v=>v!=='待清理').join(path.sep):real;
  assert(!wb.privatePath(real)&&!blocked(guarded),'路径包含业务数据、执行历史或受保护文件',403);
  return real;
}
function regular(wb:ProjectFilesWorkbench,pid:string,file:string,allowCleanup=false){
  const real=authorized(wb,pid,file,false,allowCleanup),stat=fs.lstatSync(real);
  assert(stat.isFile()&&stat.nlink===1,'需要无硬链接的普通文件',403);return {real,stat};
}
function sources(wb:ProjectFilesWorkbench,pid:string){
  const tasks=new Map(wb.all('tasks').filter(t=>t.project_id===pid).map(t=>[t.id,t]));
  const runs=new Map(wb.all('runs').filter(r=>tasks.has(r.task_id)).map(r=>[r.id,r]));
  const byPath=new Map<string,FileSource[]>();
  for(const artifact of wb.all('artifacts')){
    const run=runs.get(artifact.run_id);if(!run||typeof artifact.original_path!=='string')continue;
    const source:FileSource={artifact_id:artifact.id,task_id:run.task_id,run_id:run.id,agent_id:run.agent_id||null,sha256:artifact.sha256||null,current:artifact.current===true,label:artifact.label||null};
    const k=key(artifact.original_path);byPath.set(k,[...(byPath.get(k)||[]),source]);
  }return byPath;
}
function limit(value:number|undefined,fallback:number,max:number){assert(value===undefined||Number.isInteger(value)&&value>0,'扫描上限需要正整数');return Math.min(value??fallback,max)}

export function projectFileRevision(row:ProjectFile):number{return Number.isInteger(row.revision)&&row.revision!>0?row.revision!:1;}
export function assertFileAgent(wb:ProjectFilesWorkbench,pid:string,actor:AgentFileAction){
  assert(actor?.actor==='agent'&&typeof actor.actor_id==='string'&&actor.actor_id.trim().length>0,'需要当前会话的真实 Agent 身份',403);
  wb.get('projects',pid);
  const run=actor.run_id?wb.get('runs',actor.run_id):null,taskId=actor.task_id||run?.task_id;
  if(run&&actor.task_id)assert(run.task_id===actor.task_id,'分类会话的 Task/Run 不匹配',403);
  if(taskId)assert(wb.get('tasks',taskId).project_id===pid||actor.project_ids?.includes(pid),'分类会话不属于当前项目',403);
}
export function projectFileMetadataRows(wb:ProjectFilesWorkbench,pid:string):ProjectFile[]{
  const {roots}=projectRoots(wb,pid);
  return wb.all('project_files').filter(row=>row.project_id===pid&&typeof row.path==='string'&&path.isAbsolute(row.path)&&roots.some(root=>inside(root,row.path))&&!blocked(row.path)&&!wb.privatePath(row.path)) as ProjectFile[];
}
/** Path-only suggestions explain their evidence, without inventing validity or authorship. */
export function suggestProjectFileCategory(relativePath:string):{category:FileCategory;reason:string}{
  const normalized=relativePath.replace(/\\/g,'/'),parts=normalized.split('/'),name=parts.at(-1)||'';
  if(parts.some(part=>backupNames.test(part)))return {category:'backup',reason:'路径名称或扩展名含 backup、备份或 bak 标记；仅建议备份类别，不推断可清理'};
  if(parts.some(part=>/^(?:tests?|__tests__|specs?|测试)$/i.test(part))||/\.(?:test|spec)\.[^.]+$/i.test(name))return {category:'test',reason:'位于测试目录或使用 test/spec 文件名；仅按路径建议测试类别'};
  if(/(?:^|\/)docs\/(?:handoff|reports?|evidence)(?:\/|$)/i.test(normalized)||parts.some(part=>/^(?:handoff|reports?|evidence|过程|交接)$/i.test(part)))return {category:'process',reason:'位于交接、报告或证据目录；按路径建议过程文件'};
  if(sourceExtensions.has(path.extname(name).toLowerCase())||sourceNames.test(name))return {category:'source',reason:'常见工程扩展名或工程说明文件名；不代表已验证内容或当前有效'};
  return {category:'unknown',reason:'没有匹配成果登记或已知路径规则；用途与来源待当前 Agent 或用户说明'};
}
function classificationHistory(old:ProjectFile){
  return [...(old.classification_history||[]),{revision:projectFileRevision(old),category:old.category,validity:old.validity,retention:old.retention,purpose:old.purpose,cleanup_reason:old.cleanup_reason,classification:old.classification||null,classification_source:old.classification_source,recorded_at:stamp()}];
}

/** On-demand metadata only: never reads file contents or assigns an author to unknown files. */
export function scanProjectFiles(wb:ProjectFilesWorkbench,pid:string,action:UserFileAction,limits:ScanLimits={}):ScanResult {
  user(action);return scanMetadata(wb,pid,limits);
}
export function scanProjectFilesForAgent(wb:ProjectFilesWorkbench,pid:string,actor:AgentFileAction,limits:ScanLimits={},scanPaths?:string[]):ScanResult {
  assertFileAgent(wb,pid,actor);return scanMetadata(wb,pid,limits,scanPaths);
}
function scanMetadata(wb:ProjectFilesWorkbench,pid:string,limits:ScanLimits,scanPaths?:string[]):ScanResult {
  const {roots:projectRootList}=projectRoots(wb,pid),started=Date.now(),observed=stamp();
  const partial=scanPaths!==undefined;
  assert(!partial||Array.isArray(scanPaths)&&scanPaths.length>0&&scanPaths.length<=10,'局部扫描需要1至10个项目内目录');
  // Validate the entire selection before observing or persisting any file rows.
  const roots=partial?[...new Set(scanPaths!.map(directory=>{
    assert(typeof directory==='string'&&directory.length<=2000,'局部扫描目录无效');
    const real=authorized(wb,pid,directory);assert(fs.lstatSync(real).isDirectory(),'局部扫描仅接受普通目录',403);return real;
  }))]:projectRootList;
  const maxEntries=limit(limits.maxEntries,5000,20000),maxFiles=limit(limits.maxFiles,1500,5000),maxDepth=limit(limits.maxDepth,8,20),maxMs=limit(limits.maxMilliseconds,1000,5000),maxIssues=limit(limits.maxIssues,50,200);
  const coverage:ScanResult['coverage']={roots,...(partial?{partial:true,project_roots:projectRootList}:{}),scope:(partial?'仅所选项目内目录的局部扫描，不代表全项目；':'仅所列授权项目根；')+'跳过内部数据、执行历史、凭据、链接与待清理目录；未读取内容或验证全局引用',visitedEntries:0,visitedDirectories:0,observedFiles:0,complete:true,truncated:false,reasons:[],unknown:0,skipped:0,issues:[],observed_at:observed};
  const previous=new Map(wb.all('project_files').filter(f=>f.project_id===pid&&f.retention!=='moved').map(f=>[key(f.path),f as ProjectFile]));
  const byPath=sources(wb,pid),files:ProjectFile[]=[],seen=new Set<string>(),dirs=[...roots].reverse().map(file=>({file,depth:0}));
  const issue=(file:string,reason:string,unknown=false)=>{if(unknown){coverage.unknown++;coverage.complete=false}else coverage.skipped++;if(coverage.issues.length<maxIssues)coverage.issues.push({path:file,reason})};
  const truncate=(reason:string)=>{coverage.truncated=true;coverage.complete=false;if(!coverage.reasons.includes(reason))coverage.reasons.push(reason)};
  outer:while(dirs.length){
    if(Date.now()-started>=maxMs){truncate('time_limit');break}
    const current=dirs.pop()!;let directory:fs.Dir|undefined;
    try{
      authorized(wb,pid,current.file);directory=fs.opendirSync(current.file);coverage.visitedDirectories++;
      let entry:fs.Dirent|null;
      while((entry=directory.readSync())){
        if(coverage.visitedEntries>=maxEntries||files.length>=maxFiles||Date.now()-started>=maxMs){truncate(coverage.visitedEntries>=maxEntries?'entry_limit':files.length>=maxFiles?'file_limit':'time_limit');break outer}
        coverage.visitedEntries++;const file=path.join(current.file,entry.name);
        if(entry.isSymbolicLink()){issue(file,'link_skipped');continue}
        try{
          noLinks(file);
          if(blocked(file)){issue(file,'protected_or_internal');continue}
          const real=authorized(wb,pid,file),stat=fs.lstatSync(real);
          if(stat.isDirectory()){if(current.depth>=maxDepth){issue(real,'depth_limit',true);truncate('depth_limit')}else dirs.push({file:real,depth:current.depth+1});continue}
          if(!stat.isFile()||stat.nlink!==1){issue(real,'special_or_hardlink_skipped');continue}
          const k=key(real);if(seen.has(k))continue;seen.add(k);
          const old=previous.get(k),provenance=byPath.get(k)||[];
          const manual=old&&['user','agent'].includes(old.classification_source),root=projectRootList.find(r=>inside(r,real))!,suggestion=suggestProjectFileCategory(path.relative(root,real));
          const category=manual?old.category:provenance.length?'deliverable':suggestion.category;
          const validity=manual?old.validity:provenance.length?(provenance.some(p=>p.current)?'current':'historical'):'unknown';
          const classificationSource=manual?old.classification_source:provenance.length?'artifact':suggestion.category==='unknown'?'unknown':'rule';
          const changed=!!old&&(old.bytes!==stat.size||old.mtime!==stat.mtime.toISOString());
          const metadataChanged=!!old&&(changed||old.category!==category||old.validity!==validity||old.classification_source!==classificationSource||JSON.stringify(old.sources)!==JSON.stringify(provenance));
          const revision=old?projectFileRevision(old)+(metadataChanged?1:0):1;
          const reason=provenance.length?'工作台成果登记中存在本路径；当前/历史效力仅来自成果记录':suggestion.reason;
          const classification:FileClassification|undefined=manual?old.classification:{actor:provenance.length?'artifact':'rule',actor_id:null,run_id:provenance[0]?.run_id||null,task_id:provenance[0]?.task_id||null,purpose:old?.purpose||'',reason,recorded_at:observed,revision};
          const row:ProjectFile={...old,id:old?.id||id('PF'),project_id:pid,path:real,category,validity,retention:old?.retention||'keep',purpose:old?.purpose||'',cleanup_reason:old?.cleanup_reason||null,classification_source:classificationSource,classification,classification_reason:manual?old.classification_reason||old.classification?.reason||'保留既有人工分类':reason,revision,
            classification_stale:manual?!!old.classification_stale||changed:false,snapshot_warning:manual&&(old.classification_stale||changed)?'文件大小或修改时间已变化，原分类保留，需重新核对':null,sources:provenance,bytes:stat.size,mtime:stat.mtime.toISOString(),observed_at:observed};
          wb.put('project_files',row,{project_id:pid});files.push(row);coverage.observedFiles++;
        }catch(e){if(e instanceof FileLinkError)issue(file,'link_skipped');else issue(file,errorText(e),true)}
      }
    }catch(e){if(e instanceof FileLinkError)issue(current.file,'link_skipped');else issue(current.file,errorText(e),true)}finally{directory?.closeSync()}
  }
  // Existing rows are never marked missing/invalid merely because this scan was partial.
  return {files,coverage};
}

export function filterProjectFiles(files:ProjectFile[],entry:FileEntry=DEFAULT_PROJECT_FILE_ENTRY){
  if(entry==='invalid')return files.filter(f=>f.validity==='invalid');
  if(entry==='cleanup')return files.filter(f=>f.retention==='cleanup_candidate'||f.retention==='moved');
  return files.filter(f=>f.category===entry&&f.retention!=='moved');
}
export function saveProjectFile(wb:ProjectFilesWorkbench,pid:string,fileId:string,action:UserFileAction,changes:{category:FileCategory;validity:FileValidity;retention:Exclude<FileRetention,'moved'>;purpose:string;cleanup_reason?:string}){
  user(action);assert(changes&&Object.keys(changes).every(k=>['category','validity','retention','purpose','cleanup_reason'].includes(k)),'分类仅接受用途、效力、保留策略及说明');
  assert(categories.includes(changes.category)&&validities.includes(changes.validity)&&retentions.includes(changes.retention)&&(changes.retention as string)!=='moved','分类字段无效');
  assert(typeof changes.purpose==='string'&&changes.purpose.length<=2000,'用途说明过长');
  const old=wb.get('project_files',fileId) as ProjectFile;assert(old.project_id===pid&&old.retention!=='moved','文件不属于此项目或已移动',403);const {stat}=regular(wb,pid,old.path);
  const reason=changes.cleanup_reason?.trim()||null;assert(changes.retention!=='cleanup_candidate'||!!reason&&reason.length<=2000,'待清理文件需要明确理由');
  const revision=projectFileRevision(old)+1,at=stamp();
  const classification:FileClassification={actor:'user',actor_id:'user',run_id:null,task_id:null,purpose:changes.purpose,reason:reason||'用户在项目文件页面明确保存分类',recorded_at:at,revision};
  const row={...old,...changes,bytes:stat.size,mtime:stat.mtime.toISOString(),observed_at:at,cleanup_reason:reason,classification_source:'user' as const,classified_at:at,revision,classification,classification_reason:classification.reason,classification_stale:false,snapshot_warning:null,classification_history:classificationHistory(old)};wb.put('project_files',row,{project_id:pid});return row;
}
export interface AgentFileClassification {expected_revision?:number;category:FileCategory;validity:FileValidity;retention:Exclude<FileRetention,'moved'>;purpose:string;reason:string}
/** Metadata write only. User labels and all move/open/restore guards remain independent. */
export function classifyProjectFileForAgent(wb:ProjectFilesWorkbench,pid:string,fileId:string,actor:AgentFileAction,changes:AgentFileClassification){
  assertFileAgent(wb,pid,actor);
  const old=wb.get('project_files',fileId) as ProjectFile;
  assert(old.project_id===pid,'文件不属于当前项目',403);assert(old.retention!=='moved','文件已移动，只能从移动记录核对',409);
  if(old.classification_source==='user')return {status:'skipped_user' as const,file_id:fileId,revision:projectFileRevision(old),reason:'保留用户人工分类；Agent 不能覆盖'};
  assert(categories.includes(changes.category)&&validities.includes(changes.validity)&&['keep','cleanup_candidate'].includes(changes.retention),'分类字段无效');
  assert(typeof changes.purpose==='string'&&changes.purpose.trim().length>0&&changes.purpose.length<=2000&&typeof changes.reason==='string'&&changes.reason.trim().length>0&&changes.reason.length<=2000,'Agent 分类需要用途与依据');
  if(changes.expected_revision!==undefined)assert(changes.expected_revision===projectFileRevision(old),'文件登记版本已变化，请重新查询后分类',409);
  assert(!old.classification_stale||changes.expected_revision===projectFileRevision(old),'文件快照已变化，需查询当前 revision 并重新核对',409);
  const {stat}=regular(wb,pid,old.path);
  assert(old.bytes===stat.size&&old.mtime===stat.mtime.toISOString(),'文件快照已变化，请刷新元信息后重新分类',409);
  const revision=projectFileRevision(old)+1,at=stamp();
  const classification:FileClassification={actor:'agent',actor_id:actor.actor_id,run_id:actor.run_id||null,task_id:actor.task_id||(actor.run_id?wb.get('runs',actor.run_id).task_id:null),purpose:changes.purpose.trim(),reason:changes.reason.trim(),recorded_at:at,revision};
  const row:ProjectFile={...old,category:changes.category,validity:changes.validity,retention:changes.retention,purpose:classification.purpose,cleanup_reason:changes.retention==='cleanup_candidate'?classification.reason:null,classification_source:'agent',classification,classification_reason:classification.reason,classified_at:at,revision,classification_stale:false,snapshot_warning:null,classification_history:classificationHistory(old)};
  wb.put('project_files',row,{project_id:pid});return {status:'applied' as const,file_id:fileId,revision,classification};
}
/** Revalidates every request. Caller serves text as text, HTML in isolation, or reveals the folder. */
export function projectFilePath(wb:ProjectFilesWorkbench,pid:string,fileId:string,action:UserFileAction){
  user(action);const file=wb.get('project_files',fileId) as ProjectFile;assert(file.project_id===pid,'文件不属于此项目',403);assert(file.retention!=='moved','文件已移入待清理，请使用移动记录查看',409);
  return regular(wb,pid,file.path).real;
}

/** Uses actual ledger data, never a user-supplied complete/no-reference boolean. */
export function checkProjectFileReferences(wb:ProjectFilesWorkbench,pid:string,file:string):ReferenceReport {
  const report:ReferenceReport={references:[],boundary:'已检查工作台可见任务、Run、成果、Review 与审查单中的路径；未扫描源码内容、外部工具或其他进程。全局引用未知。',global:'unknown',complete:true};
  const target=key(file);let visited=0;
  const match=(value:string,subtree=false)=>{if(!path.isAbsolute(value))return false;const candidate=key(value);return candidate===target||subtree&&inside(candidate,target)};
  for(const table of ['tasks','runs','artifacts','reviews','review_assignments']){
    let rows:Row[];try{rows=wb.all(table)}catch{report.complete=false;continue}
    for(const row of rows){
      const walk=(value:unknown,field:string,depth=0)=>{
        if(++visited>20000||depth>15){report.complete=false;return}
        if(typeof value==='string'&&/(?:path|paths|file|files|directory|cwd|root)$/i.test(field)&&match(value,field==='directory'))report.references.push({entity:table,id:String(row.id),reason:field});
        else if(Array.isArray(value))for(const item of value)walk(item,field,depth+1);
        else if(value&&typeof value==='object')for(const [k,v] of Object.entries(value))walk(v,k,depth+1);
      };walk(row,'');if(visited>20000)break;
    }
  }
  const project=wb.get('projects',pid);
  // source_root defines the scan/authorization boundary, not a reference to every
  // descendant. Actual source files remain protected independently in moveGuard.
  // runtime_root is the configured installation tree and stays immutable here.
  if(typeof project.runtime_root==='string'&&match(project.runtime_root,true))report.references.push({entity:'projects',id:pid,reason:'runtime_root'});
  return report;
}
function moveGuard(wb:ProjectFilesWorkbench,pid:string,row:ProjectFile,selection:MoveSelection,options:MoveOptions){
  assert(row.project_id===pid&&row.retention==='cleanup_candidate'&&row.classification_source==='user'&&!!row.cleanup_reason,'仅可移动用户明确标记并说明理由的待清理文件',403);
  assert(selection.sourceDeclaration==='user_created_temporary'&&typeof selection.reason==='string'&&selection.reason.trim().length>0&&selection.reason.length<=2000,'需要用户说明临时文件来源及无其他用途/引用');
  const {real,stat}=regular(wb,pid,row.path);
  assert(typeof options.moveNoReplace==='function','移动需要服务端原生防覆盖移动能力；文件保留原地',409);
  assert(!['source','backup','deliverable'].includes(row.category)&&!sourceExtensions.has(path.extname(real).toLowerCase())&&!sourceNames.test(path.basename(real))&&!real.split(/[\\/]/).some(part=>backupNames.test(part)),'源码、成果与可回滚备份不得移入待清理',403);
  assert(row.sources.length===0,'已登记成果必须保留',403);
  const check=checkProjectFileReferences(wb,pid,real);assert(check.complete&&check.references.length===0,'工作台引用检查不完整或文件仍被任务/Run/成果/审查引用，保留原地',409);
  assert(options.probeOccupancy?.(real)==='available','无法证实文件未被占用，保留原地',409);return {real,stat,check};
}
function digest(wb:ProjectFilesWorkbench,pid:string,file:string,allowCleanup=false){
  const {real,stat}=regular(wb,pid,file,allowCleanup);assert(stat.size<=64*1024*1024,'文件超过移动校验上限，保留原地');
  const handle=fs.openSync(real,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);try{
    const opened=fs.fstatSync(handle);assert(opened.isFile()&&opened.nlink===1&&opened.dev===stat.dev&&opened.ino===stat.ino,'校验期间文件发生变化',409);
    const sha=crypto.createHash('sha256'),buffer=Buffer.allocUnsafe(64*1024);let read:number;
    while((read=fs.readSync(handle,buffer,0,buffer.length,null)))sha.update(buffer.subarray(0,read));
    const after=fs.fstatSync(handle);assert(after.size===stat.size&&after.mtimeMs===stat.mtimeMs,'校验期间文件发生变化',409);return {sha256:sha.digest('hex'),bytes:stat.size,dev:stat.dev,ino:stat.ino,mtimeMs:stat.mtimeMs};
  }finally{fs.closeSync(handle)}
}
function persistMove(wb:ProjectFilesWorkbench,move:FileMove){wb.put('file_moves',move,{project_id:move.project_id,file_id:move.file_id})}
function manifest(wb:ProjectFilesWorkbench,move:FileMove){
  authorized(wb,move.project_id,move.manifest_path,true,true);const fd=fs.openSync(move.manifest_path,'wx');try{fs.writeFileSync(fd,JSON.stringify(move,null,2));fs.fsyncSync(fd)}finally{fs.closeSync(fd)}
}
/** Each destination is in a freshly-created private directory. rename never targets a user file. */
export function moveProjectFiles(wb:ProjectFilesWorkbench,pid:string,action:UserFileAction,selections:MoveSelection[],options:MoveOptions={}){
  user(action);assert(Array.isArray(selections)&&selections.length>0&&selections.length<=50,'每次请选择1至50个文件');
  assert(new Set(selections.map(s=>s.id)).size===selections.length,'文件选择重复');const results:FileMove[]=[];
  for(const selection of selections){
    let move:FileMove|undefined,renamed=false;
    try{
      const row=wb.get('project_files',selection.id) as ProjectFile,{real,check}=moveGuard(wb,pid,row,selection,options),{roots}=projectRoots(wb,pid);
      const root=[...roots].filter(r=>inside(r,real)).sort((a,b)=>b.length-a.length)[0];
      const hashed=digest(wb,pid,real),mid=id('FM'),base=path.join(root,'待清理');
      authorized(wb,pid,base,true,true);if(!fs.existsSync(base))fs.mkdirSync(base);authorized(wb,pid,base,false,true);
      const folder=path.join(base,mid);authorized(wb,pid,folder,true,true);fs.mkdirSync(folder);
      const destination=path.join(folder,path.basename(real));authorized(wb,pid,destination,true,true);
      assert(fs.statSync(folder).dev===hashed.dev,'跨盘移动不受支持，保留原地',409);
      move={id:mid,project_id:pid,file_id:row.id,original_path:real,destination_path:destination,manifest_path:path.join(folder,'manifest.prepared.json'),sha256:hashed.sha256,bytes:hashed.bytes,status:'prepared',reason:selection.reason.trim(),cleanup_reason:row.cleanup_reason,source_declaration:selection.sourceDeclaration,created_at:stamp(),reference_check:check};
      manifest(wb,move);persistMove(wb,move);
      // Recheck source, parents, occupancy and ledger immediately before the native move.
      const again=moveGuard(wb,pid,row,selection,options),latest=digest(wb,pid,again.real);
      assert(latest.sha256===hashed.sha256&&latest.dev===hashed.dev&&latest.ino===hashed.ino,'文件已变化，保留原地',409);
      authorized(wb,pid,destination,true,true);assert(!fs.existsSync(destination),'目标已存在，保留原地',409);
      options.moveNoReplace!(real,destination);renamed=true;
      assert(digest(wb,pid,destination,true).sha256===hashed.sha256,'移动后校验不一致，请保留现场',409);
      move.status='moved';move.completed_at=stamp();move.manifest_path=path.join(folder,'manifest.moved.json');manifest(wb,move);persistMove(wb,move);
      wb.put('project_files',{...row,retention:'moved',move_id:move.id,moved_to:destination},{project_id:pid});results.push(move);
    }catch(e){
      move??={id:id('FM'),project_id:pid,file_id:selection.id,original_path:'',destination_path:'',manifest_path:'',sha256:null,bytes:null,status:'failed',reason:selection.reason||'',created_at:stamp(),reference_check:{references:[],boundary:'未完成移动前检查',global:'unknown',complete:false}};
      move.status=renamed||!!move.original_path&&!fs.existsSync(move.original_path)&&!!move.destination_path&&fs.existsSync(move.destination_path)?'uncertain':'failed';move.error=errorText(e);try{persistMove(wb,move)}catch{move.persistence_error='移动记录保存失败；请保留原文件和manifest现场'}results.push(move);
    }
  }return {results,moved:results.filter(m=>m.status==='moved').length,failed:results.filter(m=>m.status!=='moved').length};
}

function recoveryPaths(wb:ProjectFilesWorkbench,pid:string,move:FileMove){
  assert(/^FM-[a-f0-9-]{36}$/i.test(move.id)&&typeof move.sha256==='string'&&/^[a-f0-9]{64}$/i.test(move.sha256)&&Number.isSafeInteger(move.bytes)&&move.bytes!==null&&move.bytes>=0,'移动凭据不完整，保留现场',409);
  const row=wb.get('project_files',move.file_id) as ProjectFile;
  assert(row.project_id===pid&&key(row.path)===key(move.original_path)&&(!row.move_id||row.move_id===move.id),'文件登记已属于其他移动或位置，保留现场',409);
  const original=authorized(wb,pid,move.original_path,true),{roots}=projectRoots(wb,pid);
  const root=[...roots].filter(r=>inside(r,original)).sort((a,b)=>b.length-a.length)[0];
  const folder=path.join(root,'待清理',move.id),expected=path.join(folder,path.basename(original));
  assert(key(move.destination_path)===key(expected),'待清理位置与原移动凭据不符，保留现场',409);
  const destination=authorized(wb,pid,expected,true,true);
  // The initial manifest is written and synced before rename; later status
  // records can be missing after a crash. Never trust status alone as evidence.
  const proof=regular(wb,pid,path.join(folder,'manifest.prepared.json'),true);
  assert(proof.stat.size<=64*1024,'原始移动凭据过大，保留现场',409);
  const handle=fs.openSync(proof.real,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);
  let prepared:Row;
  try{
    const opened=fs.fstatSync(handle);assert(opened.dev===proof.stat.dev&&opened.ino===proof.stat.ino&&opened.nlink===1,'移动凭据已变化，保留现场',409);
    const bytes=Buffer.alloc(64*1024+1),count=fs.readSync(handle,bytes,0,bytes.length,0);assert(count<=64*1024,'原始移动凭据过大，保留现场',409);prepared=JSON.parse(bytes.subarray(0,count).toString('utf8'));
  }finally{fs.closeSync(handle)}
  assert(prepared.id===move.id&&prepared.project_id===pid&&prepared.file_id===move.file_id&&key(prepared.original_path)===key(original)&&key(prepared.destination_path)===key(destination)&&prepared.sha256===move.sha256&&prepared.bytes===move.bytes&&prepared.source_declaration==='user_created_temporary','原始移动凭据与记录不一致，保留现场',409);
  return {row,original,destination,folder};
}
function recoveryLocation(wb:ProjectFilesWorkbench,pid:string,paths:{original:string;destination:string},move:FileMove,options:MoveOptions){
  // Recheck both paths even when one is absent: a dangling link is not absence.
  authorized(wb,pid,paths.original,true);authorized(wb,pid,paths.destination,true,true);
  const presentOriginal=fs.existsSync(paths.original),presentDestination=fs.existsSync(paths.destination);
  const location:NonNullable<FileMove['reconciliation']>['location']=presentOriginal?(presentDestination?'both':'original_only'):(presentDestination?'destination_only':'neither');
  move.reconciliation={observed_at:stamp(),location};
  for(const [file,cleanup,present] of [[paths.original,false,presentOriginal],[paths.destination,true,presentDestination]] as const){
    if(!present)continue;
    regular(wb,pid,file,cleanup);assert(options.probeOccupancy?.(file)==='available','无法证实原位置或待清理位置未被占用，保留双方现场',409);
  }
  assert(location!=='both','原位置已有文件且待清理副本也存在，禁止覆盖或删除任一文件',409);
  assert(location!=='neither','原位置和待清理位置均不存在，无法自动恢复，保留移动记录',409);
  const actual=presentOriginal?paths.original:paths.destination,hashed=digest(wb,pid,actual,!presentOriginal);
  assert(hashed.sha256===move.sha256&&hashed.bytes===move.bytes,presentOriginal?'原位置内容已变化，禁止用旧移动记录修复登记':'待清理文件内容已变化，禁止自动恢复',409);
  return {location,hashed};
}

/** User-triggered reconciliation also repairs prepared/uncertain crash records.
 * Original-only means the file never left, or a restore already completed;
 * destination-only is restored with the native no-replace operation. Conflicts
 * never select a preferred copy, delete a file, or infer that a missing file is safe.
 */
export function restoreProjectFile(wb:ProjectFilesWorkbench,pid:string,moveId:string,action:UserFileAction,options:MoveOptions={}){
  user(action);const move=wb.get('file_moves',moveId) as FileMove;
  assert(move.project_id===pid&&['prepared','moved','restore_failed','uncertain'].includes(move.status),'移动记录不可恢复',409);
  let renamed=false;
  try{
    const paths=recoveryPaths(wb,pid,move);const before=recoveryLocation(wb,pid,paths,move,options);
    if(before.location==='destination_only'){
      assert(typeof options.moveNoReplace==='function','恢复需要服务端原生防覆盖移动能力；文件保留原地',409);
      noLinks(path.dirname(paths.original));assert(fs.statSync(path.dirname(paths.original)).isDirectory(),'原目录已不存在，保留待清理副本',409);
      const checks=[checkProjectFileReferences(wb,pid,paths.original),checkProjectFileReferences(wb,pid,paths.destination)];
      assert(checks.every(check=>check.complete&&check.references.length===0),'原位置或待清理副本已被工程、安装、成果或审查引用，保留待清理副本',409);
      assert(fs.statSync(path.dirname(paths.original)).dev===before.hashed.dev,'跨盘恢复不受支持，保留待清理副本',409);
      const again=recoveryLocation(wb,pid,paths,move,options);assert(again.location==='destination_only'&&again.hashed.ino===before.hashed.ino&&again.hashed.dev===before.hashed.dev,'恢复检查期间位置已变化，保留现场',409);
      options.moveNoReplace(paths.destination,paths.original);renamed=true;
    }
    const after=recoveryLocation(wb,pid,paths,move,options);assert(after.location==='original_only','恢复后的实际位置不唯一，请保留现场',409);
    move.status='restored';move.restored_at=stamp();delete move.error;delete move.persistence_error;
    move.reconciliation={observed_at:stamp(),location:'original_only',action:renamed?'moved_to_original':'already_original',message:renamed?'已核对并恢复原文件':'原文件已在原位置，已核对并修复登记'};
    move.manifest_path=path.join(paths.folder,'manifest.recovery.'+crypto.randomUUID()+'.json');manifest(wb,move);
    const restored:ProjectFile={...paths.row,retention:'keep',cleanup_reason:null,last_restored_move_id:move.id};delete restored.move_id;delete restored.moved_to;
    wb.put('project_files',restored,{project_id:pid});persistMove(wb,move);return move;
  }catch(e){
    move.status=renamed||move.status==='prepared'||move.status==='uncertain'||move.reconciliation?.location==='original_only'?'uncertain':'restore_failed';move.error=errorText(e);
    move.reconciliation??={observed_at:stamp(),location:'unverified'};
    try{persistMove(wb,move)}catch{move.status='uncertain';move.persistence_error='对账记录保存失败；文件位置可能已恢复，请再次核对，保留全部manifest'}return move;
  }
}
