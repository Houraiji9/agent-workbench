import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {inside,protectedName,safePath} from './security.ts';

export interface SourceObservationLimits {maxDurationMs?:number;maxReadBytes?:number;maxDirectories?:number}
export interface SourceScope extends SourceObservationLimits {sourceRoot:string;allowedRoots:string[];excludedRoots?:string[];maxFiles?:number}
export interface SourceFile {path:string;sha256:string|null;size_bytes:number|null;tracked:boolean;preexisting_dirty:boolean;error?:string}
export interface SourceBaseline {
  schema_version:1;source_root:string;captured_at:string;status:'observed'|'partial'|'unknown';head:string|null;
  files:SourceFile[];dirty_paths:string[];excluded:{path:string;reason:string}[];warnings:string[];
  observation?:{limits:{duration_ms:number;read_bytes:number;directories:number};elapsed_ms:number;read_bytes:number;directories:number;exhausted:string[]};
}
const DEFAULT_MAX_FILES=20000;
export const SOURCE_OBSERVATION_LIMITS=Object.freeze({duration_ms:5000,read_bytes:128*1024*1024,directories:128});
const GIT_MAX_OUTPUT=32*1024*1024;
class ObservationExhausted extends Error {constructor(public dimension:string){super('observation_budget_exhausted:'+dimension);}}
class ObservationBudget {
  readonly started=performance.now();
  readonly state:NonNullable<SourceBaseline['observation']>;
  constructor(scope:SourceObservationLimits){this.state={limits:{duration_ms:scope.maxDurationMs??SOURCE_OBSERVATION_LIMITS.duration_ms,read_bytes:scope.maxReadBytes??SOURCE_OBSERVATION_LIMITS.read_bytes,directories:scope.maxDirectories??SOURCE_OBSERVATION_LIMITS.directories},elapsed_ms:0,read_bytes:0,directories:0,exhausted:[]};}
  exhausted(dimension:string):never{if(!this.state.exhausted.includes(dimension))this.state.exhausted.push(dimension);throw new ObservationExhausted(dimension);}
  remainingMs(){this.state.elapsed_ms=performance.now()-this.started;const left=this.state.limits.duration_ms-this.state.elapsed_ms;if(left<=0)this.exhausted('duration_ms');return Math.max(1,Math.ceil(left));}
  visitDirectory(){this.remainingMs();if(this.state.directories>=this.state.limits.directories)this.exhausted('directories');this.state.directories++;}
  beforeRead(size:number){this.remainingMs();if(size>this.state.limits.read_bytes-this.state.read_bytes)this.exhausted('read_bytes');}
  finish(){this.state.elapsed_ms=performance.now()-this.started;}
}
function relative(file:string){return file.split(path.sep).join('/');}
function git(root:string,args:string[],budget:ObservationBudget,input?:string,allowedStatuses=[0]){
  const result=spawnSync('git',['-c','core.fsmonitor=false','-c','core.untrackedCache=false','-c','status.relativePaths=true','-C',root,...args],{...(input!==undefined?{input}:{}),encoding:'utf8',windowsHide:true,maxBuffer:GIT_MAX_OUTPUT,timeout:budget.remainingMs(),env:{...process.env,GIT_OPTIONAL_LOCKS:'0',GIT_TERMINAL_PROMPT:'0'}});
  if((result.error as NodeJS.ErrnoException)?.code==='ETIMEDOUT')budget.exhausted('duration_ms');
  budget.remainingMs();
  if(result.error||!allowedStatuses.includes(result.status??-1))throw Error(result.error?(result.error as NodeJS.ErrnoException).code||'git_failed':'git_failed');
  return result.stdout;
}
function excludedName(file:string){return protectedName(file)||file.split(/[\\/]/).some(part=>/^(?:\.npmrc|\.pypirc|\.netrc|config\.local\.json|local\.json|.*\.(?:db|sqlite|sqlite3)(?:-(?:wal|shm|journal))?)$/i.test(part));}
function linkedAncestor(root:string,file:string):string|null {
  let current=root;
  for(const part of path.relative(root,file).split(path.sep)){
    current=path.join(current,part);
    try{if(fs.lstatSync(current).isSymbolicLink())return relative(path.relative(root,current));}catch{return null;}
  }
  return null;
}
/** Enumerate only authorized, nonignored directory entries. Git for Windows may follow
 * directory junctions with ls-files --others; inspect each boundary before descending. */
function untrackedInventory(root:string,tracked:string[],excludedRoots:string[],maxFiles:number,result:SourceBaseline,budget:ObservationBudget){
  const trackedSet=new Set(tracked.map(relative)),queue=[root],files:string[]=[];let visited=0;
  while(queue.length){
    if(++visited>maxFiles||files.length>maxFiles){result.status='partial';result.warnings.push('untracked_inventory_observation_budget');break;}
    try{budget.visitDirectory();}catch(error){if(!(error instanceof ObservationExhausted))throw error;result.status='partial';result.warnings.push(error.message);break;}
    const directory=queue.shift()!;
    const entries=fs.readdirSync(directory,{withFileTypes:true}).filter(entry=>{
      budget.remainingMs();
      const candidate=path.join(directory,entry.name),rel=relative(path.relative(root,candidate));
      if(excludedName(rel)||excludedRoots.some(excluded=>inside(excluded,candidate))){result.excluded.push({path:rel,reason:'protected_or_excluded_scope'});return false;}
      if(entry.isSymbolicLink()){result.excluded.push({path:rel,reason:'symbolic_link'});return false;}
      return true;
    });
    if(!entries.length)continue;
    const names=entries.map(entry=>relative(path.relative(root,path.join(directory,entry.name)))+(entry.isDirectory()?'/':''));
    const ignored=new Set(git(root,['check-ignore','-z','--stdin'],budget,names.join('\0')+'\0',[0,1]).split('\0').filter(Boolean));
    for(let i=0;i<entries.length;i++){
      budget.remainingMs();
      if(ignored.has(names[i]))continue;
      const candidate=path.join(directory,entries[i].name),rel=relative(path.relative(root,candidate));
      const real=safePath(candidate,[root]);
      if(excludedName(real)||excludedRoots.some(excluded=>inside(excluded,real))){result.excluded.push({path:rel,reason:'protected_or_excluded_target'});continue;}
      if(entries[i].isDirectory())queue.push(real);else if(!trackedSet.has(rel))files.push(rel);
    }
  }
  return files;
}
function fileHash(file:string,budget:ObservationBudget){
  budget.remainingMs();
  const fd=fs.openSync(file,'r');
  try{
    const before=fs.fstatSync(fd);if(!before.isFile())throw Error('not_regular_file');
    budget.beforeRead(before.size);
    const digest=crypto.createHash('sha256'),buffer=Buffer.allocUnsafe(64*1024);let total=0,read:number;
    while(total<before.size){budget.beforeRead(Math.min(buffer.length,before.size-total));read=fs.readSync(fd,buffer,0,Math.min(buffer.length,before.size-total),null);if(!read)break;total+=read;budget.state.read_bytes+=read;budget.remainingMs();digest.update(buffer.subarray(0,read));}
    const after=fs.fstatSync(fd);
    if(before.size!==after.size||before.mtimeMs!==after.mtimeMs||before.ctimeMs!==after.ctimeMs||total!==after.size)throw Error('changed_during_read');
    return {sha256:digest.digest('hex'),size_bytes:total};
  }finally{fs.closeSync(fd);}
}
/** Read-only snapshot of the authorized source directory. Non-Git roots remain explicitly unknown. */
export function captureSourceBaseline(scope:SourceScope):SourceBaseline {
  const budget=new ObservationBudget(scope);
  const result:SourceBaseline={schema_version:1,source_root:path.resolve(scope.sourceRoot),captured_at:new Date().toISOString(),status:'unknown',head:null,files:[],dirty_paths:[],excluded:[],warnings:[],observation:budget.state};
  const finish=()=>{budget.finish();return result;};
  if(Object.values(budget.state.limits).some(limit=>!Number.isSafeInteger(limit)||limit<0)){result.warnings.push('invalid_observation_budget');return finish();}
  let root:string;
  try{budget.remainingMs();root=safePath(scope.sourceRoot,scope.allowedRoots);if(protectedName(root)||!fs.statSync(root).isDirectory())throw Error('source_root_unavailable');result.source_root=root;}
  catch(error){result.warnings.push(error instanceof ObservationExhausted?error.message:'source_root_unauthorized_or_unavailable');return finish();}
  let tracked:string[],others:string[],dirty:string[];
  const excludedRoots=(scope.excludedRoots||[]).map(value=>{try{return fs.realpathSync.native(value);}catch{return path.resolve(value);}});
  const maxFiles=scope.maxFiles??DEFAULT_MAX_FILES;
  if(!Number.isSafeInteger(maxFiles)||maxFiles<1){result.warnings.push('invalid_observation_file_budget');return finish();}
  try{
    git(root,['rev-parse','--show-toplevel'],budget);
    tracked=git(root,['ls-files','-z','--cached','--','.'],budget).split('\0').filter(Boolean);
    result.status='observed';
    others=untrackedInventory(root,tracked,excludedRoots,maxFiles,result,budget);
    // Tracked status does not recursively discover untracked directories or junction targets.
    const records=git(root,['status','--porcelain=v1','-z','--untracked-files=no','--ignore-submodules=all','--','.'],budget).split('\0').filter(Boolean);
    dirty=[...others];
    for(let i=0;i<records.length;i++){const record=records[i];dirty.push(record.slice(3));if(/[RC]/.test(record.slice(0,2))&&records[i+1])dirty.push(records[++i]);}
    try{result.head=git(root,['rev-parse','--verify','HEAD'],budget).trim();}catch(error){if(error instanceof ObservationExhausted)throw error;/* An unborn repository still has an observable index and worktree. */}
  }catch(error){result.status=error instanceof ObservationExhausted&&result.status!=='unknown'?'partial':'unknown';result.warnings.push(error instanceof ObservationExhausted?error.message:`git_inventory_unavailable:${(error as Error).message}`);return finish();}
  const trackedSet=new Set(tracked),dirtySet=new Set(dirty.map(relative));
  const inventory=[...new Set([...tracked,...others])].sort();
  if(inventory.length>maxFiles){result.status='partial';result.warnings.push(`inventory_truncated:${inventory.length}:${maxFiles}`);}
  for(const name of inventory.slice(0,maxFiles)){
    try{budget.remainingMs();}catch(error){result.status='partial';result.warnings.push((error as Error).message);break;}
    const rel=relative(name),candidate=path.resolve(root,name);
    if(!inside(root,candidate)){result.status='partial';result.warnings.push('inventory_path_outside_source_root');continue;}
    if(excludedName(rel)){result.excluded.push({path:rel,reason:'protected_or_database'});continue;}
    if(excludedRoots.some(excluded=>inside(excluded,candidate))){result.excluded.push({path:rel,reason:'excluded_scope'});continue;}
    const item:SourceFile={path:rel,sha256:null,size_bytes:null,tracked:trackedSet.has(name),preexisting_dirty:dirtySet.has(rel)};
    try{
      // Never follow a listed link to another project or credential file.
      if(linkedAncestor(root,candidate)){result.excluded.push({path:rel,reason:'symbolic_link'});continue;}
      const real=safePath(candidate,[root],true);
      if(excludedName(real)||excludedRoots.some(excluded=>inside(excluded,real))){result.excluded.push({path:rel,reason:'protected_or_excluded_target'});continue;}
      Object.assign(item,fileHash(real,budget));
    }catch(error){item.error=(error as NodeJS.ErrnoException).code||(error as Error).message;if(item.error!=='ENOENT')result.status='partial';if(error instanceof ObservationExhausted){result.warnings.push(error.message);result.files.push(item);break;}}
    result.files.push(item);
  }
  // Includes deletions already present at start, including paths that cannot be hashed.
  result.dirty_paths=[...dirtySet].filter(file=>!excludedName(file)&&inside(root,path.resolve(root,file))&&!excludedRoots.some(excluded=>inside(excluded,path.resolve(root,file)))).sort();
  return finish();
}

export interface SourceComparisonInput extends SourceObservationLimits {reviewFiles:(string|{path:string})[];allowedRoots:string[];excludedRoots?:string[];maxFiles?:number}
/** Advisory only. The caller persists this data; coverage gaps never reject submission. */
export function compareSourceCoverage(baseline:SourceBaseline,input:SourceComparisonInput) {
  const current=captureSourceBaseline({sourceRoot:baseline.source_root,allowedRoots:input.allowedRoots,excludedRoots:input.excludedRoots,maxFiles:input.maxFiles,maxDurationMs:input.maxDurationMs,maxReadBytes:input.maxReadBytes,maxDirectories:input.maxDirectories});
  const reviewed=new Set(input.reviewFiles.map(file=>path.resolve(typeof file==='string'?file:file.path)));
  const oldFiles=new Map(baseline.files.map(file=>[file.path,file]));
  const newFiles=new Map(current.files.map(file=>[file.path,file]));
  const baselineDirty=new Set(baseline.dirty_paths);
  const changes:{path:string;change:'added'|'modified'|'deleted'|'unknown';before_sha256:string|null;after_sha256:string|null;preexisting_dirty:boolean;covered:boolean}[]=[];
  const warnings=[...baseline.warnings.map(warning=>'baseline:'+warning),...current.warnings.map(warning=>'current:'+warning)];
  const inventoryKnown=baseline.status!=='unknown'&&current.status!=='unknown';
  if(inventoryKnown)for(const file of [...new Set([...oldFiles.keys(),...newFiles.keys()])].sort()){
    const before=oldFiles.get(file),after=newFiles.get(file);
    let change:'added'|'modified'|'deleted'|'unknown'|null=null;
    if(before?.error==='ENOENT'&&after?.error==='ENOENT')change=null;
    else if(before?.sha256&&after?.error==='ENOENT')change='deleted';
    else if(before?.error==='ENOENT'&&after?.sha256)change='added';
    else if(!before)change=baseline.status==='observed'&&after?.sha256?'added':'unknown';
    else if(!after)change=current.status==='observed'?'deleted':'unknown';
    else if(!before.sha256||!after.sha256)change='unknown';
    else if(before.sha256!==after.sha256)change='modified';
    if(change)changes.push({path:file,change,before_sha256:before?.sha256||null,after_sha256:after?.sha256||null,preexisting_dirty:before?.preexisting_dirty||baselineDirty.has(file),covered:reviewed.has(path.resolve(baseline.source_root,file))});
  }
  const changedPaths=new Set(changes.map(change=>change.path));
  const preexisting=baseline.dirty_paths.map(file=>({path:file,covered:reviewed.has(path.resolve(baseline.source_root,file)),changed_during_run:changedPaths.has(file)}));
  const uncovered=changes.filter(change=>!change.covered);
  if(!inventoryKnown)warnings.push('source_inventory_unknown_no_complete_diff_claim');
  if(baseline.status==='partial'||current.status==='partial')warnings.push('source_inventory_partial_no_complete_coverage_claim');
  if(uncovered.length)warnings.push('changed_source_missing_from_review_files');
  if(preexisting.some(file=>!file.covered))warnings.push('preexisting_dirty_source_not_covered');
  return {schema_version:1 as const,advisory:true as const,status:!inventoryKnown?'unknown' as const:baseline.status==='partial'||current.status==='partial'?'partial' as const:'observed' as const,source_root:baseline.source_root,baseline_captured_at:baseline.captured_at,compared_at:current.captured_at,changes,uncovered,preexisting_dirty:preexisting,warnings,current_snapshot:current,note:'仅比较已观测的授权源码；review_files 的路径覆盖不等于独立审查结论，既有脏文件不归责于本 Run。'};
}
