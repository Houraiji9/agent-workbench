import fs from 'node:fs';import path from 'node:path';import {DatabaseSync} from 'node:sqlite';import {pathToFileURL} from 'node:url';import {inside,atomicWrite,hash,safePath,readBounded} from '../src/core/security.ts';
export function restore(source:string,target:string){
 const src=fs.realpathSync.native(source),resolved=path.resolve(target),dest=safePath(resolved,[path.parse(resolved).root],true);if(inside(src,dest)||inside(dest,src))throw new Error('恢复目标不得与备份源目录重叠');if(fs.existsSync(dest))throw new Error('恢复只写入不存在的新目录；不会覆盖当前数据库');
 const manifest=JSON.parse(fs.readFileSync(path.join(src,'manifest.json'),'utf8'));if(manifest.schema_version!==1)throw new Error('备份版本不支持');
 const probe=new DatabaseSync(path.join(src,'workbench.sqlite'),{readOnly:true});const result=probe.prepare('PRAGMA integrity_check').get() as any;probe.close();if(result.integrity_check!=='ok')throw new Error('备份数据库完整性失败');
 fs.mkdirSync(dest,{recursive:true});atomicWrite(path.join(dest,'RESTORE_INCOMPLETE'),'恢复尚未通过完整性验证');for(const name of ['workbench.sqlite','artifacts','run-keys','keys.json','diagrams','packages','manifest.json']){const f=path.join(src,name);if(fs.existsSync(f))fs.cpSync(f,path.join(dest,name),{recursive:true,filter:(f)=>!fs.lstatSync(f).isSymbolicLink()})}
 const db=new DatabaseSync(path.join(dest,'workbench.sqlite'));try{db.exec('BEGIN');
 for(const r of db.prepare('SELECT id,data FROM artifacts').all() as any[]){const a=JSON.parse(r.data);a.archive_path=safePath(path.join(dest,'artifacts',path.basename(a.archive_path)),[path.join(dest,'artifacts')]);const bytes=readBounded(a.archive_path,20*1024*1024);if(bytes.length!==a.size||hash(bytes)!==a.sha256)throw new Error('备份归档完整性失败：'+a.id);db.prepare('UPDATE artifacts SET data=? WHERE id=?').run(JSON.stringify(a),r.id)}
 if(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='diagrams'").get())for(const r of db.prepare('SELECT id,data FROM diagrams').all() as any[]){
   const d=JSON.parse(r.data);if(!/^D-[a-f0-9-]{36}$/.test(d.id))throw new Error('备份图解标识无效');
   d.directory=safePath(path.join(dest,'diagrams',d.id),[path.join(dest,'diagrams')]);
   if(hash(readBounded(safePath(path.join(d.directory,'diagram.html'),[d.directory]),20*1024*1024))!==d.sha256)throw new Error('备份图解完整性失败');
   db.prepare('UPDATE diagrams SET data=? WHERE id=?').run(JSON.stringify(d),d.id);
 }
 for(const row of db.prepare('SELECT id,data FROM runs').all() as any[]){const r=JSON.parse(row.data),old=r.directory;let targetDir:string|undefined;
   for(const p of manifest.packages){const backupPath=path.resolve(dest,p.backup_path);if(!inside(path.join(dest,'packages'),backupPath))throw new Error('备份执行包路径越界');
     if(p.run_id===r.id)targetDir=backupPath;
     // Compatibility with the original v0.1 project-directory backup manifest.
     if(!p.run_id&&p.path){const original=path.join(p.path,'.agent-workbench');if(inside(original,old))targetDir=path.join(backupPath,path.relative(original,old));}
   }
   if(!targetDir||!fs.existsSync(path.join(targetDir,'RUN.md')))throw new Error('执行包缺失，未完成恢复：'+r.id);
   r.directory=targetDir;r.order_path=path.join(targetDir,'RUN.md');r.restored_at=new Date().toISOString();r.original_directory=old;
   const oldTaskDir=path.resolve(old,'../..');for(const name of ['RUN.md','CONTEXT.md','EXECUTION.md']){const f=path.join(targetDir,name);if(fs.existsSync(f)){let text=fs.readFileSync(f,'utf8').split(old).join(targetDir);text=text.split(path.join(oldTaskDir,'CONTEXT.md')).join(path.join(targetDir,'CONTEXT.md'));atomicWrite(f,text)}}
   const keyFile=path.join(dest,'run-keys',r.id+'.json');const key=JSON.parse(fs.readFileSync(keyFile,'utf8'));key.receipt_directory=path.join(targetDir,'events');atomicWrite(keyFile,JSON.stringify(key));
   db.prepare('UPDATE runs SET data=? WHERE id=?').run(JSON.stringify(r),r.id);
 }
 db.exec('COMMIT');}catch(error){db.exec('ROLLBACK');throw error}finally{db.close()}
 fs.unlinkSync(path.join(dest,'RESTORE_INCOMPLETE'));return {target:dest,integrity:'ok',packages:manifest.packages,notice:'数据库、归档与 Run 执行入口已恢复到新目录；原始 cwd 保留，源项目源码不在备份中，不覆盖原项目。用 WORKBENCH_DATA_DIR 指向此目录启动。'};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){if(!process.argv[2]||!process.argv[3])throw new Error('用法：npm run restore -- <备份目录> <新的恢复目录>');console.log(JSON.stringify(restore(process.argv[2],process.argv[3]),null,2))}
