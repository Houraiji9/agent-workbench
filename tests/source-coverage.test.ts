import {test,mock} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {ROOT} from '../src/core/config.ts';
import {captureSourceBaseline,compareSourceCoverage} from '../src/core/source-coverage.ts';

function dir(){const root=path.join(ROOT,'.test-tmp','source-coverage-'+crypto.randomUUID());fs.mkdirSync(root,{recursive:true});return root;}
function git(root:string,...args:string[]){const result=spawnSync('git',['-C',root,...args],{encoding:'utf8',windowsHide:true});assert.equal(result.status,0,result.stderr);return result.stdout;}
function repo(){const root=dir();git(root,'init');fs.writeFileSync(path.join(root,'.gitignore'),'ignored/\n');for(const name of ['clean.ts','modify.ts','delete.ts','dirty.ts'])fs.writeFileSync(path.join(root,name),name+'\n');git(root,'add','.');git(root,'-c','user.name=Fixture','-c','user.email=fixture@invalid.test','-c','commit.gpgsign=false','commit','-m','synthetic baseline');return root;}
test('授权Git源码记录既有dirty，比较新增修改删除并提示受审覆盖缺口',()=>{
  const root=repo();fs.appendFileSync(path.join(root,'dirty.ts'),'before run\n');fs.writeFileSync(path.join(root,'existing-untracked.ts'),'preexisting\n');
  fs.mkdirSync(path.join(root,'nested','deeper'),{recursive:true});fs.writeFileSync(path.join(root,'nested','deeper','untracked.ts'),'nested source');
  const baseline=captureSourceBaseline({sourceRoot:root,allowedRoots:[root]});
  assert.equal(baseline.status,'observed');assert.equal(baseline.files.find(file=>file.path==='dirty.ts')?.preexisting_dirty,true);assert.equal(baseline.files.find(file=>file.path==='existing-untracked.ts')?.tracked,false);
  assert.equal(baseline.files.find(file=>file.path==='nested/deeper/untracked.ts')?.tracked,false);
  fs.appendFileSync(path.join(root,'modify.ts'),'after start\n');fs.unlinkSync(path.join(root,'delete.ts'));fs.writeFileSync(path.join(root,'new.ts'),'new source\n');
  const result=compareSourceCoverage(baseline,{allowedRoots:[root],reviewFiles:[path.join(root,'modify.ts'),path.join(root,'delete.ts')]});
  assert.equal(result.status,'observed');assert.equal(result.advisory,true);
  assert.deepEqual(result.changes.map(item=>[item.path,item.change,item.covered]),[['delete.ts','deleted',true],['modify.ts','modified',true],['new.ts','added',false]]);
  assert.deepEqual(result.uncovered.map(item=>item.path),['new.ts']);assert.ok(result.preexisting_dirty.some(item=>item.path==='dirty.ts'&&!item.changed_during_run));
  assert.ok(result.warnings.includes('preexisting_dirty_source_not_covered'));assert.equal(fs.readFileSync(path.join(root,'dirty.ts'),'utf8'),'dirty.ts\nbefore run\n');
});
test('已有删除不会误报本轮删除，恢复文件显示新增；大文件按字节hash且不受证据20MiB限制',()=>{
  const root=repo();fs.unlinkSync(path.join(root,'delete.ts'));
  const large=path.join(root,'large.bin');fs.writeFileSync(large,'x');fs.truncateSync(large,21*1024*1024);
  const baseline=captureSourceBaseline({sourceRoot:root,allowedRoots:[root]});
  assert.equal(baseline.status,'observed');assert.equal(baseline.files.find(item=>item.path==='large.bin')?.size_bytes,21*1024*1024);
  assert.equal(baseline.files.find(item=>item.path==='large.bin')?.sha256,crypto.createHash('sha256').update(fs.readFileSync(large)).digest('hex'));
  assert.equal(compareSourceCoverage(baseline,{allowedRoots:[root],reviewFiles:[]}).changes.length,0);
  fs.writeFileSync(path.join(root,'delete.ts'),'restored\n');
  assert.deepEqual(compareSourceCoverage(baseline,{allowedRoots:[root],reviewFiles:[]}).changes.map(item=>[item.path,item.change]),[['delete.ts','added']]);
});
test('忽略目录、敏感配置、DB和链接被排除，显式目录边界不扩扫',()=>{
  const root=repo();fs.mkdirSync(path.join(root,'ignored'));fs.writeFileSync(path.join(root,'ignored','private.ts'),'ignored');
  for(const name of ['.env','.npmrc','state.sqlite','config.local.json'])fs.writeFileSync(path.join(root,name),'private');
  const outside=dir();fs.writeFileSync(path.join(outside,'unrelated.ts'),'unrelated');fs.symlinkSync(outside,path.join(root,'linked'),'junction');
  const baseline=captureSourceBaseline({sourceRoot:root,allowedRoots:[root]});
  assert.ok(!baseline.files.some(file=>/private|unrelated|sqlite|\.env|npmrc|config\.local/.test(file.path)));
  assert.ok(baseline.excluded.some(file=>file.path==='.env'));
  const unauthorized=captureSourceBaseline({sourceRoot:outside,allowedRoots:[root]});assert.equal(unauthorized.status,'unknown');assert.equal(unauthorized.files.length,0);
});
test('非Git、读取失败和清单观察上限保持未知或partial，不伪称完整覆盖',()=>{
  const plain=dir();fs.writeFileSync(path.join(plain,'sample.ts'),'sample');
  // This fixture lives inside the application's Git tree; an invalid local gitdir prevents
  // discovery of that unrelated parent and represents an unavailable repository explicitly.
  fs.writeFileSync(path.join(plain,'.git'),'gitdir: missing-synthetic-gitdir\n');
  const unknown=captureSourceBaseline({sourceRoot:plain,allowedRoots:[plain]});assert.equal(unknown.status,'unknown');
  assert.equal(compareSourceCoverage(unknown,{allowedRoots:[plain],reviewFiles:[]}).status,'unknown');
  const root=repo(),baseline=captureSourceBaseline({sourceRoot:root,allowedRoots:[root]});
  const original=fs.openSync;
  const open=mock.method(fs,'openSync',((file:fs.PathLike,flags:fs.OpenMode,mode?:fs.Mode)=>{if(String(file)===path.join(root,'clean.ts'))throw Object.assign(Error('synthetic read denial'),{code:'EACCES'});return original(file,flags,mode);}) as typeof fs.openSync);
  try{
    const current=compareSourceCoverage(baseline,{allowedRoots:[root],reviewFiles:[]});assert.equal(current.status,'partial');assert.equal(current.changes.find(item=>item.path==='clean.ts')?.change,'unknown');assert.ok(current.warnings.includes('source_inventory_partial_no_complete_coverage_claim'));
  }finally{open.mock.restore();}
  const limited=captureSourceBaseline({sourceRoot:root,allowedRoots:[root],maxFiles:1});assert.equal(limited.status,'partial');assert.equal(limited.files.length,1);assert.ok(limited.warnings.some(warning=>warning.startsWith('inventory_truncated')));
});

test('总时长、读取字节和目录预算耗尽明确降为partial或unknown，比较只提示',()=>{
  const root=repo();fs.mkdirSync(path.join(root,'nested'));fs.writeFileSync(path.join(root,'nested','new.ts'),'nested');
  const baseline=captureSourceBaseline({sourceRoot:root,allowedRoots:[root]});assert.equal(baseline.status,'observed');
  const timed=captureSourceBaseline({sourceRoot:root,allowedRoots:[root],maxDurationMs:0});
  assert.equal(timed.status,'unknown');assert.ok(timed.warnings.includes('observation_budget_exhausted:duration_ms'));assert.deepEqual(timed.observation?.exhausted,['duration_ms']);assert.equal(timed.observation?.read_bytes,0);
  const bytes=captureSourceBaseline({sourceRoot:root,allowedRoots:[root],maxReadBytes:1});
  assert.equal(bytes.status,'partial');assert.ok(bytes.warnings.includes('observation_budget_exhausted:read_bytes'));assert.ok(bytes.observation!.read_bytes<=1);assert.equal(bytes.files.filter(file=>file.sha256).length,0);
  const directories=captureSourceBaseline({sourceRoot:root,allowedRoots:[root],maxDirectories:1});
  assert.equal(directories.status,'partial');assert.ok(directories.warnings.includes('observation_budget_exhausted:directories'));assert.equal(directories.observation?.directories,1);assert.ok(!directories.files.some(file=>file.path==='nested/new.ts'));
  const comparison=compareSourceCoverage(baseline,{allowedRoots:[root],reviewFiles:[],maxReadBytes:0});assert.equal(comparison.status,'partial');assert.equal(comparison.advisory,true);assert.ok(comparison.warnings.includes('source_inventory_partial_no_complete_coverage_claim'));
});

test('超大文件超过剩余总读取预算时不读取正文',()=>{
  const root=repo(),large=path.join(root,'000-large.bin');fs.writeFileSync(large,'x');fs.truncateSync(large,129*1024*1024);
  const original=fs.readSync;let largeReads=0;
  const read=mock.method(fs,'readSync',((fd:number,...args:unknown[])=>{if(fs.fstatSync(fd).size===129*1024*1024)largeReads++;return (original as (...args:unknown[])=>unknown)(fd,...args);}) as typeof fs.readSync);
  try{
    const result=captureSourceBaseline({sourceRoot:root,allowedRoots:[root]});assert.equal(result.status,'partial');assert.ok(result.warnings.includes('observation_budget_exhausted:read_bytes'));assert.equal(largeReads,0);assert.ok(result.observation!.read_bytes<=128*1024*1024);
  }finally{read.mock.restore();}
});
