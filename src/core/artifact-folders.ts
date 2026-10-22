import fs from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import type {Workbench} from './workbench.ts';
import {assert,inside,protectedName,safePath} from './security.ts';

export type ArtifactPlace='original'|'archive';
export function artifactFile(wb:Workbench,id:string,target:ArtifactPlace){
  const a=wb.get('artifacts',id);
  if(target==='archive'){
    const file=safePath(a.archive_path,[path.join(wb.config.dataDir,'artifacts')]);
    assert(fs.statSync(file).isFile(),'归档文件已不可用，请重新交付',404);
    return file;
  }
  assert(typeof a.original_path==='string'&&a.original_path,'这份成果只有归档副本，请打开归档文件夹',404);
  const r=wb.get('runs',a.run_id),t=wb.get('tasks',r.task_id);
  assert(!protectedName(a.original_path),'原文件位置已不可用，请打开归档文件夹',403);
  assert(fs.existsSync(a.original_path),'原文件已移动或删除，请打开归档文件夹',404);
  const file=safePath(a.original_path,wb.config.authorizedRoots);
  safePath(file,[...t.allowed_paths,r.directory]);
  assert(!protectedName(file)&&!inside(fs.realpathSync.native(wb.config.dataDir),file),'原文件位置已不可用，请打开归档文件夹',403);
  assert(fs.statSync(file).isFile(),'原文件已不可用，请打开归档文件夹',404);
  return file;
}

// 只定位文件，不打开或执行文件内容。调用方先从成果ID解析并验证路径。
export async function revealFile(file:string){
  assert(process.platform==='win32','请复制文件夹路径，在文件管理器中打开');
  assert(!/["\x00-\x1f]/.test(file),'文件路径格式无效');
  await new Promise<void>((resolve,reject)=>{
    // 用Windows文件定位API，避免Explorer命令行对空格、逗号的特殊解析。
    const exe=path.join(process.env.SystemRoot||'C:\\Windows','System32/WindowsPowerShell/v1.0/powershell.exe');
    const helper=fileURLToPath(new URL('../../scripts/reveal-artifact.ps1',import.meta.url));
    const child=spawn(exe,['-NoProfile','-NonInteractive','-STA','-ExecutionPolicy','Bypass','-File',helper,'-FilePath',file],{shell:false,windowsHide:true,stdio:'ignore'});
    const timeout=setTimeout(()=>{child.kill();reject(new Error('打开文件夹超时，请重试或复制路径'))},15000);
    child.once('error',()=>reject(new Error('文件夹未能打开，请复制路径后打开')));
    child.once('close',code=>{clearTimeout(timeout);if(code===0)resolve();else reject(new Error('文件夹未能打开，请复制路径后打开'))});
  });
}

export async function openArtifactFolder(wb:Workbench,id:string,target:ArtifactPlace,reveal=revealFile){
  const file=artifactFile(wb,id,target);
  await reveal(file);
  return {opened:true,target,file,folder:path.dirname(file)};
}
