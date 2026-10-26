import {parseAgentOutput} from './agent-output.ts';

/** The caller must supply only the launched client's successful terminal response.
 * Some clients concatenate pre-tool narration with the final JSON. Retain one exact
 * trailing object; never guess between reports, repair JSON, or inspect tool output. */
export function nativeReviewResult(text:string):unknown{
 const input=text.trim();if(input.length>2*1024*1024)throw Error('原生审查结果超过大小限制');
 try{return JSON.parse(input)}catch{}
 const start=input.indexOf('{');if(start<0||/[\[\]}]/.test(input.slice(0,start)))throw Error('原生审查结果没有唯一完整报告');
 let depth=0,quoted=false,escaped=false,end=-1;
 for(let i=start;i<input.length;i++){
  const c=input[i];if(quoted){if(escaped)escaped=false;else if(c==='\\')escaped=true;else if(c==='"')quoted=false;continue;}
  if(c==='"')quoted=true;else if(c==='{')depth++;else if(c==='}'&&--depth===0){end=i+1;break;}
 }
 if(end<0||!/^\s*(?:```\s*)?$/.test(input.slice(end)))throw Error('原生审查结果不完整或包含多个候选报告');
 return JSON.parse(input.slice(start,end));
}

/** A file submitted by the authenticated reviewer remains a reviewer-authored report.
 * Reading a client envelope here does not certify native provenance or its identity. */
export function reviewReportFile(text:string):unknown{
 const input=text.replace(/^\uFEFF/,'').trim();
 const value=nativeReviewResult(input);
 if(value&&typeof value==='object'&&!Array.isArray(value)&&'type' in value){
  const event=parseAgentOutput('cursor',input);
  if(!event.terminal||event.success!==true||event.finalText===undefined)throw Error('文件不是成功终态的审查报告');
  return nativeReviewResult(event.finalText);
 }
 return value;
}
