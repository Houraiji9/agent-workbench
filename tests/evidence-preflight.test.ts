import {test,mock} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {ROOT} from '../src/core/config.ts';
import {EVIDENCE_LIMITS,preflightEvidence} from '../src/core/evidence-preflight.ts';

function fixture(){const root=path.join(ROOT,'.test-tmp','evidence-preflight-'+crypto.randomUUID());fs.mkdirSync(root,{recursive:true});return root;}
function file(root:string,name:string,size=1){const value=path.join(root,name);fs.writeFileSync(value,'x');fs.truncateSync(value,size);return value;}
test('证据清单一次返回全部缺失、超限、越权和保护问题，不读取正文或归档',()=>{
  const root=fixture(),allowed=path.join(root,'allowed'),outside=path.join(root,'outside');fs.mkdirSync(allowed);fs.mkdirSync(outside);
  const oversize=file(allowed,'large.bin',EVIDENCE_LIMITS.file_bytes+1),unauthorized=file(outside,'outside.txt'),secret=file(allowed,'.env');
  const before=fs.readdirSync(allowed);
  const read=mock.method(fs,'readFileSync',()=>{throw Error('preflight must not read payload');});
  try{
    const result=preflightEvidence({allowedRoots:[allowed],files:[{path:path.join(allowed,'missing.txt'),kind:'artifact'},{path:oversize,kind:'artifact'},{path:unauthorized,kind:'review_file'},{path:secret,kind:'artifact'}]});
    assert.equal(result.ok,false);assert.deepEqual(result.issues.map(issue=>issue.code),['missing','file_too_large','unauthorized','protected_path']);
    assert.equal(result.total.limit_bytes,null);assert.equal(result.total.observed_bytes,EVIDENCE_LIMITS.file_bytes+1);assert.equal(read.mock.callCount(),0);assert.deepEqual(fs.readdirSync(allowed),before);
  }finally{read.mock.restore();}
});
test('沿用20MiB边界、30个产物和500个受审文件，总量无新增门槛',()=>{
  const root=fixture(),a=file(root,'a.bin',EVIDENCE_LIMITS.file_bytes),b=file(root,'b.bin',EVIDENCE_LIMITS.file_bytes);
  const result=preflightEvidence({allowedRoots:[root],files:[{path:a,kind:'artifact'},{path:b,kind:'artifact'}]});
  assert.equal(result.ok,true);assert.equal(result.total.observed_bytes,40*1024*1024);assert.equal(result.total.limit_bytes,null);
  const counts=preflightEvidence({allowedRoots:[root],files:[...Array.from({length:31},()=>({path:a,kind:'artifact' as const})),...Array.from({length:501},()=>({path:b,kind:'review_file' as const}))]});
  assert.equal(counts.issues.filter(issue=>issue.code==='count_exceeded').length,2);assert.equal(counts.counts.total,532);
});
test('目录、不可读文件和内部目录例外有明确状态，链接不能绕过允许目录',()=>{
  const root=fixture(),internal=path.join(root,'internal'),run=path.join(internal,'run');fs.mkdirSync(run,{recursive:true});
  const allowed=file(run,'report.txt'),blocked=file(internal,'database-dump.txt'),unreadable=file(root,'unreadable.txt');
  const original=fs.accessSync;
  const access=mock.method(fs,'accessSync',((p:fs.PathLike,mode?:number)=>{if(p===unreadable)throw Object.assign(Error('fixture denied'),{code:'EACCES'});return original(p,mode);}) as typeof fs.accessSync);
  try{
    const result=preflightEvidence({allowedRoots:[root],protectedRoots:[internal],protectedExceptions:[run],files:[{path:allowed,kind:'artifact'},{path:blocked,kind:'artifact'},{path:unreadable,kind:'artifact'},{path:run,kind:'artifact'}]});
    assert.equal(result.files[0].ok,true);assert.deepEqual(result.issues.map(issue=>issue.code),['protected_path','unreadable','not_file']);
  }finally{access.mock.restore();}
  const outside=fixture(),link=path.join(root,'linked');fs.symlinkSync(outside,link,'junction');
  const outsideFile=file(outside,'external.txt');assert.ok(outsideFile);
  assert.equal(preflightEvidence({allowedRoots:[root],files:[{path:path.join(link,'external.txt'),kind:'artifact'}]}).issues[0].code,'unauthorized');
});
