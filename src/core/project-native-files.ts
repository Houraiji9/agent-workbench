import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import type {MoveOptions} from './project-files.ts';
const script=fileURLToPath(new URL('../../scripts/project-file-native.ps1',import.meta.url));
function native(operation:'probe'|'move',source:string,destination?:string){
  if(process.platform!=='win32')throw Error('当前系统尚未接通不覆盖的文件移动能力，文件保留原地');
  const powershell=path.join(process.env.SystemRoot||'C:/Windows','System32/WindowsPowerShell/v1.0/powershell.exe');
  // The user explicitly authorized this bundled helper's child process only;
  // no machine/user policy or registry setting is changed.
  const result=spawnSync(powershell,['-NoLogo','-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',script,'-Operation',operation,'-Source',source,...(destination?['-Destination',destination]:[])],{encoding:'utf8',windowsHide:true,timeout:15000,maxBuffer:64*1024});
  if(result.error||result.status!==0)throw Error((result.error?.message||result.stderr||'文件被占用或移动失败').slice(0,1000));return result.stdout.trim();
}
export const nativeFileOperations:MoveOptions={
  probeOccupancy(file){try{const result=native('probe',file);return result==='available'?'available':result==='busy'?'busy':'unknown'}catch{return 'unknown'}},
  moveNoReplace(source,destination){if(native('move',source,destination)!=='moved')throw Error('系统未确认文件移动成功，请保留现场')},
};
