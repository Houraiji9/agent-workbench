import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fixture,setup} from './helpers.ts';
import {Archify,projectMap} from '../src/integrations/archify.ts';
import {createBackup} from '../scripts/backup.ts';
import {restore} from '../scripts/restore.ts';
import {Workbench} from '../src/core/workbench.ts';
test('Archify 官方生成、hash、防篡改、状态不变及备份恢复',async()=>{
 const {wb,root,config}=fixture();
 try{
  const {tid}=setup(wb,root),before=wb.get('tasks',tid).status;
  const renderer=new Archify(wb),d=await renderer.generate({project_id:'P-workbench'});
  assert.equal(d.version,'3.2.0');assert.equal(d.source,'ledger_snapshot');assert.equal(wb.get('tasks',tid).status,before);
  assert.match(renderer.content(d.id).bytes.toString(),/ARCHIFY|Archify/);
  const backup=await createBackup(wb),target=path.join(root,'restored');restore(backup.path,target);
  const restored=new Workbench({...config,dataDir:target});try{assert.equal(new Archify(restored).content(d.id).row.sha256,d.sha256)}finally{restored.close()}
  fs.appendFileSync(path.join(d.directory,'diagram.html'),'tampered');assert.throws(()=>renderer.content(d.id),/完整性/);
 }finally{wb.close()}
});
test('图解不接受任意文件引用、输出路径和超出白名单的类型',async()=>{
 const {wb}=fixture();try{
  const a=new Archify(wb);await assert.rejects(()=>a.generate({project_id:'missing'}),/不存在/);
  const c=projectMap(wb,'P-workbench');
  await assert.rejects(()=>a.generate({project_id:'P-workbench',candidate:{...c,sources:[{path:'C:/private'}]}}),/外部资源/);
  await assert.rejects(()=>a.generate({project_id:'P-workbench',candidate:{...c,diagram_type:'explainer'}}),/不支持/);
  assert.equal(wb.all('diagrams').length,0);
 }finally{wb.close()}
});
test('Grok 回归：后台关闭时取消在途图解，不能登记为成功',async()=>{
 const {wb}=fixture();try{
  const renderer=new Archify(wb),pending=renderer.generate({project_id:'P-workbench'});
  const failure=assert.rejects(pending,/未通过生成检查/);
  await renderer.close();await failure;assert.equal(wb.all('diagrams').length,0);
  await assert.rejects(()=>renderer.generate({project_id:'P-workbench'}),/正在退出/);
 }finally{wb.close()}
});
