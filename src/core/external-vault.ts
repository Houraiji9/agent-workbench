import {spawn} from 'node:child_process';
import path from 'node:path';
import {assert} from './security.ts';

export interface ExternalVault {available:boolean;reason?:string;encrypt(value:Record<string,string>):Promise<string>;decrypt(value:string):Promise<Record<string,string>>}
// Windows CurrentUser DPAPI: plaintext is only passed over an anonymous stdin pipe.
// No user-provided value appears in the script, command line, environment or error.
const script=`$ErrorActionPreference='Stop';try { Add-Type -AssemblyName System.Security; $v=[Console]::In.ReadToEnd()|ConvertFrom-Json; $bytes=[Convert]::FromBase64String($v.data); $scope=[Security.Cryptography.DataProtectionScope]::CurrentUser; if($v.mode -eq 'protect') {$result=[Security.Cryptography.ProtectedData]::Protect($bytes,$null,$scope)} else {$result=[Security.Cryptography.ProtectedData]::Unprotect($bytes,$null,$scope)}; [Console]::Out.Write([Convert]::ToBase64String($result)) } catch { [Console]::Error.Write('credential protection failed'); exit 1 }`;
async function dpapi(mode:'protect'|'unprotect',data:Buffer):Promise<Buffer>{
  assert(process.platform==='win32','当前系统没有可用的凭据保险库，不能明文保存',503);
  const exe=path.join(process.env.SystemRoot||'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe');
  return new Promise((resolve,reject)=>{
    const child=spawn(exe,['-NoLogo','-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')],{windowsHide:true,stdio:['pipe','pipe','pipe'],shell:false});
    let output='',settled=false;const finish=(error?:Error)=>{if(settled)return;settled=true;clearTimeout(timer);error?reject(error):resolve(Buffer.from(output.trim(),'base64'));};
    const timer=setTimeout(()=>{child.kill();finish(new Error('凭据保险库响应超时'));},15000);
    child.stdout.on('data',b=>{output+=b;if(output.length>1024*1024){child.kill();finish(new Error('凭据保护结果异常'));}});
    child.stderr.resume();child.once('error',()=>finish(new Error('凭据保险库不可用')));
    child.once('close',code=>finish(code===0&&output.trim()?undefined:new Error('无法解锁凭据，请在此电脑重新绑定')));
    child.stdin.on('error',()=>{});child.stdin.end(JSON.stringify({mode,data:data.toString('base64')}));
  });
}
export const windowsExternalVault:ExternalVault={
  available:process.platform==='win32',reason:process.platform==='win32'?undefined:'需要 Windows 当前用户凭据保护；不提供明文降级',
  async encrypt(value){return 'dpapi:v1:'+(await dpapi('protect',Buffer.from(JSON.stringify(value)))).toString('base64');},
  async decrypt(value){assert(value.startsWith('dpapi:v1:'),'凭据格式不受支持，请重新绑定',409);return JSON.parse((await dpapi('unprotect',Buffer.from(value.slice(9),'base64'))).toString('utf8'));}
};
