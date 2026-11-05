import fs from 'node:fs';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';

export type ApiAgentFileScope={cwd:string;allowedRoots:string[];protectedPaths?:string[];isPrivatePath?:(absolutePath:string)=>boolean};
export type ApiAgentFileToolDefinition={name:string;description:string;inputSchema:Record<string,unknown>};
export class ApiAgentFileError extends Error {constructor(public code:string){super(code);}}
function fail(code:string):never{throw new ApiAgentFileError(code);}
const SHA=/^[a-f0-9]{64}$/;
const MAX_READ=128*1024,MAX_WRITE=256*1024,MAX_ENTRIES=200;
const PROTECTED=/^(?:\.env(?:\..*)?|\.?credentials?(?:[._-].*)?|secrets?(?:[._-].*)?|auth\.json|config\.toml|keys\.json|api[-_]keys?(?:\..*)?|vault(?:\..*)?|run-keys|review-keys|id_rsa(?:\..*)?|id_ed25519(?:\..*)?|\.git|node_modules|\.codex|\.claude|\.dsh|\.ssh|\.aws|\.gnupg|\.kube|\.cursor|\.gemini|\.agent-workbench|\.workbench.*|\.npmrc|\.pypirc|settings\.local\.json|data|待清理)$/i;
const PRIVATE_EXTENSION=/\.(?:pem|p12|pfx|key|sqlite|sqlite3|db)(?:[-.]|$)/i;
const key=(value:string)=>process.platform==='win32'?value.toLowerCase():value;
const inside=(root:string,file:string)=>{const relative=path.relative(root,file);return !relative||(relative!=='..'&&!relative.startsWith('..'+path.sep)&&!path.isAbsolute(relative));};
const hash=(bytes:Buffer|string)=>createHash('sha256').update(bytes).digest('hex');
export function isApiAgentProtectedPath(file:string){return file.split(/[\\/]/).some(part=>PROTECTED.test(part))||PRIVATE_EXTENSION.test(path.basename(file))||/(?:^|[\\/])config[\\/]local\.json$/i.test(file);}
function absolute(value:string){
  if(typeof value!=='string'||!path.isAbsolute(value)||/^[/\\]{2}/.test(value)||/[\x00-\x1f\x7f]/.test(value)||value.slice(2).includes(':'))fail('api_file_invalid_path');
  const full=path.resolve(value);
  for(const part of path.relative(path.parse(full).root,full).split(path.sep))if(/[<>:"|?*]|[. ]$/.test(part)||/^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(part))fail('api_file_invalid_path');
  return full;
}
/** Compare every existing component's actual target; lstat alone misses some Windows junctions. */
function noLinks(value:string,allowMissing=false){
  const full=absolute(value);let current=path.parse(full).root;
  for(const part of path.relative(current,full).split(path.sep).filter(Boolean)){
    const parent=current;current=path.join(current,part);
    let stat:fs.Stats;
    try{stat=fs.lstatSync(current);}catch(error){
      if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;
      if(fs.existsSync(parent)){const entries=fs.readdirSync(parent);if(entries.length>4096)fail('api_file_directory_limit');if(entries.some(name=>key(name)===key(part)))fail('api_file_linked_path');}
      if(!allowMissing)fail('api_file_missing');return full;
    }
    if(stat.isSymbolicLink())fail('api_file_linked_path');
    let real:string;try{real=fs.realpathSync.native(current);}catch{fail('api_file_linked_path');}
    if(key(real!)!==key(current))fail('api_file_linked_path');
  }
  return full;
}
const schema=(properties:Record<string,unknown>,required:string[])=>({type:'object',properties,required,additionalProperties:false});
export const API_AGENT_FILE_TOOLS:ApiAgentFileToolDefinition[]=[
  {name:'list_project_files',description:'列出已授权项目目录的一层文件，省略凭据、工作台私有数据和链接；不递归。',inputSchema:schema({path:{type:'string'},limit:{type:'integer',minimum:1,maximum:MAX_ENTRIES}},['path'])},
  {name:'read_project_file',description:'读取授权范围内的 UTF-8 文本及其原始字节 SHA-256。写入已有文件时必须使用此哈希。',inputSchema:schema({path:{type:'string'}},['path'])},
  {name:'write_project_file',description:'写入授权范围内的 UTF-8 文本。expected_sha256 必填：新建用 null；修改用最近读取的哈希，内容变化时拒绝覆盖。不提供 shell。',inputSchema:schema({path:{type:'string'},content:{type:'string',maxLength:MAX_WRITE},expected_sha256:{type:['string','null'],pattern:'^[a-f0-9]{64}$'}},['path','content','expected_sha256'])},
];

export function createApiAgentFileTools(scope:ApiAgentFileScope){
  if(!Array.isArray(scope.allowedRoots)||!scope.allowedRoots.length||scope.allowedRoots.length>32)fail('api_file_invalid_scope');
  const roots=[...new Set(scope.allowedRoots.map(root=>noLinks(root)))];
  for(const root of roots)if(isApiAgentProtectedPath(root)||scope.isPrivatePath?.(root)||!fs.statSync(root).isDirectory())fail('api_file_protected_path');
  const protectedPaths=(scope.protectedPaths||[]).map(absolute);
  const cwd=noLinks(scope.cwd);if(!roots.some(root=>inside(root,cwd))||!fs.statSync(cwd).isDirectory())fail('api_file_outside_scope');
  function checked(raw:unknown,allowMissing=false){
    if(typeof raw!=='string'||!raw||raw.length>2000||/^[/\\]{2}/.test(raw)||/^[A-Za-z]:[^\\/]/.test(raw))fail('api_file_invalid_path');
    const file=absolute(path.isAbsolute(raw)?raw:path.resolve(cwd,raw));
    if(!roots.some(root=>inside(root,file)))fail('api_file_outside_scope');
    if(isApiAgentProtectedPath(raw)||isApiAgentProtectedPath(file)||protectedPaths.some(p=>inside(p,file))||scope.isPrivatePath?.(file))fail('api_file_protected_path');
    noLinks(file,allowMissing);if(fs.existsSync(file)&&scope.isPrivatePath?.(fs.realpathSync.native(file)))fail('api_file_protected_path');return file;
  }
  function snapshot(file:string,max:number){
    checked(file);const fd=fs.openSync(file,fs.constants.O_RDONLY|(fs.constants.O_NOFOLLOW||0));
    try{
      const before=fs.fstatSync(fd);if(!before.isFile()||before.nlink!==1)fail('api_file_not_regular');if(before.size>max)fail('api_file_too_large');
      const bytes=Buffer.alloc(before.size);let offset=0;while(offset<bytes.length){const n=fs.readSync(fd,bytes,offset,bytes.length-offset,null);if(!n)break;offset+=n;}
      checked(file);const after=fs.fstatSync(fd),named=fs.statSync(file);
      if(offset!==bytes.length||before.dev!==named.dev||before.ino!==named.ino||named.nlink!==1||before.size!==after.size||before.mtimeMs!==after.mtimeMs||before.ctimeMs!==after.ctimeMs||after.mtimeMs!==named.mtimeMs||after.size!==named.size)fail('api_file_changed');
      return {bytes,stat:after,sha256:hash(bytes)};
    }finally{fs.closeSync(fd);}
  }
  function argumentsFor(input:unknown,keys:string[]){if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(k=>!keys.includes(k)))fail('api_file_invalid_arguments');return input as Record<string,unknown>;}
  async function callTool(name:string,input:unknown,context?:{signal?:AbortSignal}){
    if(context?.signal?.aborted)fail('api_cancelled');
    if(name==='list_project_files'){
      const args=argumentsFor(input,['path','limit']),dir=checked(args.path),limit=args.limit===undefined?MAX_ENTRIES:args.limit;
      if(!Number.isInteger(limit)||Number(limit)<1||Number(limit)>MAX_ENTRIES)fail('api_file_invalid_arguments');if(!fs.statSync(dir).isDirectory())fail('api_file_not_directory');
      const iterator=fs.opendirSync(dir),entries:Array<{name:string;type:'directory'|'file'}>=[];let inspected=0,hasMore=false;
      try{for(;;){const entry=iterator.readSync();if(!entry)break;if(++inspected>4096){hasMore=true;break;}const candidate=path.join(dir,entry.name);try{checked(candidate);const stat=fs.lstatSync(candidate);if(stat.isFile()&&stat.nlink!==1)continue;if(!stat.isFile()&&!stat.isDirectory())continue;if(entries.length>=Number(limit)){hasMore=true;break;}entries.push({name:entry.name,type:stat.isDirectory()?'directory':'file'});}catch(error){if(!(error instanceof ApiAgentFileError))throw error;}}}finally{iterator.closeSync();}
      return {path:dir,entries,has_more:hasMore};
    }
    if(name==='read_project_file'){
      const args=argumentsFor(input,['path']),file=checked(args.path),read=snapshot(file,MAX_READ);let content:string;
      try{content=new TextDecoder('utf-8',{fatal:true}).decode(read.bytes);}catch{fail('api_file_not_utf8');}
      if(content!.includes('\0'))fail('api_file_not_utf8');return {path:file,content:content!,sha256:read.sha256,bytes:read.bytes.length,utf8_bom:read.bytes.subarray(0,3).equals(Buffer.from([239,187,191]))};
    }
    if(name==='write_project_file'){
      const args=argumentsFor(input,['path','content','expected_sha256']);if(typeof args.content!=='string'||!Object.hasOwn(args,'expected_sha256')||args.expected_sha256!==null&&(typeof args.expected_sha256!=='string'||!SHA.test(args.expected_sha256)))fail('api_file_invalid_arguments');
      const file=checked(args.path,true),content=Buffer.from(args.content,'utf8');if(content.length>MAX_WRITE)fail('api_file_too_large');
      // Synchronous bounded compare/write prevents another API turn from interleaving. The hash is
      // checked again immediately before atomic replacement; this is optimistic file concurrency,
      // not an OS sandbox or a lock against arbitrary programs running as the same user.
      const exists=fs.existsSync(file);if(exists?(args.expected_sha256===null||snapshot(file,MAX_WRITE).sha256!==args.expected_sha256):args.expected_sha256!==null)fail('api_file_conflict');
      const parent=path.dirname(file);noLinks(parent,true);fs.mkdirSync(parent,{recursive:true});checked(parent);
      if(!exists){checked(file,true);fs.writeFileSync(file,content,{flag:'wx',mode:0o600});}
      else{
        const stage=path.join(parent,'.workbench-api-stage-'+randomUUID()+'.tmp');noLinks(stage,true);fs.writeFileSync(stage,content,{flag:'wx',mode:0o600});
        if(context?.signal?.aborted)fail('api_cancelled');checked(file);if(snapshot(file,MAX_WRITE).sha256!==args.expected_sha256)fail('api_file_conflict');
        fs.renameSync(stage,file);
      }
      const written=snapshot(file,MAX_WRITE);if(written.sha256!==hash(content))fail('api_file_changed');return {path:file,sha256:written.sha256,bytes:content.length,created:!exists};
    }
    fail('api_tool_unavailable');
  }
  return {tools:API_AGENT_FILE_TOOLS,callTool};
}
