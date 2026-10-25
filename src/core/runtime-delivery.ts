import fs from 'node:fs';import path from 'node:path';import crypto from 'node:crypto';import {createRequire} from 'node:module';import {z} from 'zod';import type {Workbench} from './workbench.ts';import type {Row} from './schema.ts';import {assert,safePath,hash,readBounded,now} from './security.ts';import {reviewSkipped} from './acceptance.ts';
import {runTask} from './workflow-policy.ts';
import {resolveDeliveryProfile,validatePlannedDelivery} from './delivery-profile.ts';
import {verifyDeploymentEvidence} from './deployment-evidence.ts';
import {deployedSuccessor,type SuccessorEvidence} from './delivery-successor.ts';
import {latestReview} from './latest-review.ts';
const {relativeFile,plain,MANAGED}=createRequire(import.meta.url)('../../desktop/update-files.cjs');
export const deploymentInput=z.object({run_id:z.string(),manifest_sha256:z.string().regex(/^[a-f0-9]{64}$/)}).strict();
function fileHash(file:string){const h=crypto.createHash('sha256'),fd=fs.openSync(file,'r'),buffer=Buffer.alloc(256*1024);try{let count;while((count=fs.readSync(fd,buffer,0,buffer.length,null)))h.update(buffer.subarray(0,count));return h.digest('hex');}finally{fs.closeSync(fd)}}
export function verifyRuntime(wb:Workbench,t:Row,r:Row,options:{allowSuccessor?:boolean}={}):SuccessorEvidence[]{
  const task=runTask(t,r),profile=resolveDeliveryProfile(task,wb.get('projects',t.project_id)),evidence:SuccessorEvidence[]=[];
  if(profile.deployment.mode!=='none')validatePlannedDelivery(profile);
  if(profile.deployment.verification==='executor_reported')verifyDeploymentEvidence(wb,t,r);
  // An old portable receipt still requires real portable verification, even if mutable settings changed.
  if(profile.deployment.verification!=='portable_manifest'&&!r.deployment)return evidence;
  assert(r.deployment?.verified,'本机目标尚未验证安装，不能交用户试用',409);
  const root=safePath(r.deployment.runtime_root,wb.roots(wb.get('projects',t.project_id)));plain(root);
  if(profile.deployment.verification==='portable_manifest')assert(safePath(profile.deployment.target,wb.roots(wb.get('projects',t.project_id))).toLowerCase()===root.toLowerCase(),'便携安装目录与冻结交付目标不匹配',409);
  const file=path.join(root,'update-manifest.json'),currentManifestHash=hash(readBounded(file,8*1024*1024));
  if(currentManifestHash!==r.deployment.manifest_sha256){
    const successor=options.allowSuccessor?deployedSuccessor(wb,task,r,currentManifestHash):null;
    assert(successor,'本机程序清单已改变，请重新核对',409);evidence.push(successor.evidence);
  }
  const manifest=JSON.parse(fs.readFileSync(file,'utf8'));
  assert(manifest.schema===1&&manifest.product==='Houraiji9/agent-workbench'&&Array.isArray(manifest.files)&&manifest.files.length>0&&manifest.files.length<=60000,'本机程序清单无效；当前支持工作台便携格式');
  assert(/^\d+\.\d+\.\d+$/.test(manifest.version),'本机版本无效');
  const paths=new Set<string>();
  for(const item of manifest.files){relativeFile(item.path);assert(!paths.has(item.path.toLowerCase())&&/^[a-f0-9]{64}$/.test(item.sha256),'本机清单重复或哈希无效');paths.add(item.path.toLowerCase());const target=path.join(root,item.path);plain(target);assert(fs.existsSync(target)&&fs.statSync(target).isFile()&&fs.statSync(target).size===item.bytes&&fileHash(target)===item.sha256,'本机程序文件不匹配：'+item.path,409);}
  function complete(file:string){plain(file);assert(fs.existsSync(file),'运行目录缺少程序文件',409);if(fs.statSync(file).isDirectory())for(const name of fs.readdirSync(file))complete(path.join(file,name));else{const rel=path.relative(root,file).split(path.sep).join('/');assert(rel==='update-manifest.json'||paths.has(rel.toLowerCase()),'运行目录含清单外程序文件：'+rel,409);}}
  const release=JSON.parse(fs.readFileSync(path.join(root,'portable-release.json'),'utf8')),pkg=JSON.parse(fs.readFileSync(path.join(root,'package.json'),'utf8'));assert(release.schema===1&&release.product===manifest.product&&release.version===manifest.version&&pkg.version===manifest.version,'本机版本与清单不一致');
  for(const managed of MANAGED)complete(path.join(root,managed));
  for(const file of ['桌面版/工作台/工作台.exe','桌面版/工作台/resources/runtime/node.exe','桌面版/工作台/resources/app/main.cjs','dist/index.html'])assert(paths.has(file.toLowerCase()),'本机清单缺少关键运行文件');
  return evidence;
}
export function reportDeployment(wb:Workbench,input:unknown){const v=deploymentInput.parse(input),r=wb.get('runs',v.run_id),t=wb.get('tasks',r.task_id),p=wb.get('projects',t.project_id);
  const task=runTask(t,r),profile=validatePlannedDelivery(resolveDeliveryProfile(task,p));
  assert(profile.deployment.verification==='portable_manifest','此任务不使用便携清单安装回执',409);
  assert(t.current_run_id===r.id&&['submitted','awaiting_closeout','closing','closeout_blocked'].includes(t.status),'当前执行不允许记录安装',409);
  const review=latestReview(wb,r.id);assert(reviewSkipped(task)||review?.verdict==='passed','须先完成当前交付的独立审查',409);
  const artifacts=wb.all('artifacts').filter(a=>a.run_id===r.id&&a.current);assert(artifacts.some(a=>a.sha256===v.manifest_sha256),'本机清单必须是当前已交付并受审的文件',409);
  if(!reviewSkipped(task))assert(JSON.stringify(artifacts.map(a=>a.sha256).sort())===JSON.stringify([...review!.artifact_hashes].sort()),'审查与交付版本不匹配',409);
  const target=profile.deployment.target;assert(target,'请先在项目资料登记运行目录');const root=safePath(target,wb.roots(p));assert(!wb.privatePath(root),'运行目录不能指向内部账本');
  const pending={...r,deployment:{verified:true,runtime_root:root,manifest_sha256:v.manifest_sha256,verified_at:now(),review_id:review?.id||null}};verifyRuntime(wb,{...t,delivery_target:'runtime'},pending);wb.transaction(()=>{wb.put('runs',pending,{task_id:t.id});wb.audit('run:'+r.id,'deployment_verified',t.id,{runtime_root:root,manifest_sha256:v.manifest_sha256});});return pending.deployment;
}
