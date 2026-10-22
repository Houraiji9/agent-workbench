import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
export class DomainError extends Error {constructor(message:string, public status=400){super(message)}}
export function assert(ok:unknown,message:string,status=400):asserts ok {if(!ok)throw new DomainError(message,status)}
export const now=()=>new Date().toISOString();
export const id=(prefix:string)=>`${prefix}-${crypto.randomUUID()}`;
export const hash=(v:string|Buffer)=>crypto.createHash('sha256').update(v).digest('hex');
export const secret=()=>crypto.randomBytes(32).toString('hex');
export function same(a:string,b:string){const aa=Buffer.from(a),bb=Buffer.from(b);return aa.length===bb.length&&crypto.timingSafeEqual(aa,bb)}
export function inside(root:string,target:string){const r=path.relative(root,target);return r===''||(!r.startsWith('..'+path.sep)&&r!=='..'&&!path.isAbsolute(r))}
export function safePath(input:string,roots:string[],allowNew=false):string {
  assert(path.isAbsolute(input)&&!input.startsWith('\\\\')&&!input.startsWith('//'),'只允许授权的本机绝对路径');
  assert(!/[\x00-\x1f]/.test(input)&&!input.slice(2).includes(':'),'路径包含非法字符');
  const target=path.resolve(input);let ancestor=target;const tail:string[]=[];
  while(!fs.existsSync(ancestor)){assert(allowNew,'路径不存在'); const parent=path.dirname(ancestor);assert(parent!==ancestor,'路径不存在');tail.unshift(path.basename(ancestor));ancestor=parent;}
  const real=path.resolve(fs.realpathSync.native(ancestor),...tail);
  assert(roots.some(r=>fs.existsSync(r)&&inside(fs.realpathSync.native(r),real)),'路径超出授权根目录',403);
  return real;
}
export function atomicWrite(file:string,content:string|Buffer){fs.mkdirSync(path.dirname(file),{recursive:true});const tmp=file+'.'+crypto.randomUUID()+'.tmp';try{fs.writeFileSync(tmp,content);fs.renameSync(tmp,file)}catch(e){try{fs.unlinkSync(tmp)}catch{}throw e}}
export function readBounded(file:string,max=2*1024*1024){assert(fs.statSync(file).isFile(),'需要普通文件');assert(fs.statSync(file).size<=max,'文件过大，请从目录入口查看');return fs.readFileSync(file)}
export function protectedName(file:string){return file.split(/[\\/]/).some(part=>/^(?:\.env(?:\..*)?|credentials?(?:[._-].*)?|secrets?(?:[._-].*)?|auth\.json|config\.toml|keys\.json|run-keys|id_rsa(?:\..*)?|id_ed25519(?:\..*)?|node_modules|\.git|\.codex|\.ssh|\.aws|\.gnupg|\.kube)$/i.test(part))}
export function signReceipt(event:unknown,key:string){return crypto.createHmac('sha256',key).update(JSON.stringify(event)).digest('hex')}
