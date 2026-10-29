import fs from 'node:fs';
import path from 'node:path';
import {inside,protectedName,safePath,DomainError} from './security.ts';

/** Existing submitted-event limits; total size has no historical cap. */
export const EVIDENCE_LIMITS = Object.freeze({file_bytes:20*1024*1024,artifact_count:30,review_file_count:500,total_bytes:null});
export type EvidenceKind = 'artifact' | 'review_file';
export interface EvidenceFile {path:string;kind:EvidenceKind;label?:string;allowedRoots?:string[]}
export interface EvidencePreflightInput {
  files:EvidenceFile[];allowedRoots:string[];protectedRoots?:string[];protectedExceptions?:string[];
}
export interface EvidenceIssue {index:number|null;path:string|null;code:string;message:string;remedy:string}

/** Metadata only: does not read, copy, archive, mutate a Run, or replace readBounded at use time. */
export function preflightEvidence(input:EvidencePreflightInput) {
  const issues:EvidenceIssue[]=[];
  const artifactCount=input.files.filter(item=>item.kind==='artifact').length;
  const reviewCount=input.files.filter(item=>item.kind==='review_file').length;
  for(const [kind,count,limit] of [['artifact',artifactCount,EVIDENCE_LIMITS.artifact_count],['review_file',reviewCount,EVIDENCE_LIMITS.review_file_count]] as const){
    if(count>limit)issues.push({index:null,path:null,code:'count_exceeded',message:`${kind} 共 ${count} 项，现行限额 ${limit} 项`,remedy:'在同一次交付中修订附件清单，合并重复项；保留原件和明确的覆盖说明。'});
  }
  const files=input.files.map((item,index)=>{
    const result:{index:number;path:string;kind:EvidenceKind;label?:string;resolved_path:string|null;size_bytes:number|null;readable:boolean|null;ok:boolean}={index,path:item.path,kind:item.kind,...(item.label?{label:item.label}:{}),resolved_path:null,size_bytes:null,readable:null,ok:true};
    const issue=(code:string,message:string,remedy:string)=>{result.ok=false;issues.push({index,path:item.path,code,message,remedy});};
    try {
      // allowNew resolves a missing leaf against its existing ancestor, so missing and unauthorized
      // members can all be reported before any payload is read or written.
      const real=safePath(item.path,item.allowedRoots||input.allowedRoots,true);
      result.resolved_path=real;
      const protectedByRoot=(input.protectedRoots||[]).some(root=>inside(realRoot(root),real));
      const exception=(input.protectedExceptions||[]).some(root=>inside(realRoot(root),real));
      if(protectedName(item.path)||protectedName(real)||(protectedByRoot&&!exception)){
        issue('protected_path','证据路径包含受保护内容或内部存储','移除凭据、内部账本或保护目录；提供授权且脱敏的实际证据文件。');return result;
      }
      const stat=fs.statSync(real);
      if(!stat.isFile()){issue('not_file','证据需要普通文件，不能用目录路径代替','提交具体文件或可验证的清单/分块，并说明覆盖范围。');return result;}
      result.size_bytes=stat.size;
      if(stat.size>EVIDENCE_LIMITS.file_bytes)issue('file_too_large',`文件 ${stat.size} bytes，单文件限额 ${EVIDENCE_LIMITS.file_bytes} bytes`,'保留原件；提交可验证分块、引用或代表性材料，并注明 hash 与覆盖范围。');
      try{fs.accessSync(real,fs.constants.R_OK);result.readable=true;}catch{result.readable=false;issue('unreadable','当前进程没有读取此文件的权限','修复该文件的本地读取权限，或提供授权范围内可读的证据副本。');}
    }catch(error){
      const code=(error as NodeJS.ErrnoException).code;
      if(code==='ENOENT'||code==='ENOTDIR')issue('missing','证据文件不存在','修正文件路径，或先生成真实文件再重提同一次交付。');
      else if(code==='EACCES'||code==='EPERM')issue('unreadable','当前进程不能读取路径元数据','核对该路径的本地权限，不扩大授权范围。');
      else if(error instanceof DomainError)issue(error.status===403?'unauthorized':'invalid_path',error.message,'使用允许目录内的本机绝对路径，不通过目录链接越权。');
      else issue('metadata_unknown',`无法完成文件元数据检查：${code||'unknown'}`,'保留原件，核对文件状态和访问权限后重试。');
    }
    return result;
  });
  return {schema_version:1 as const,ok:issues.length===0,limits:EVIDENCE_LIMITS,counts:{artifact:artifactCount,review_file:reviewCount,total:input.files.length},total:{observed_bytes:files.reduce((sum,item)=>sum+(item.size_bytes||0),0),unknown_files:files.filter(item=>item.size_bytes===null).length,limit_bytes:null,status:'no_configured_limit' as const},files,issues,note:'仅为元数据预检；实际读取时仍须验证授权路径、普通文件、单文件大小与内容 hash，防止预检后的文件变化。'};
}
function realRoot(root:string){try{return fs.realpathSync.native(root);}catch{return path.resolve(root);}}
