const fs=require('node:fs');const path=require('node:path');const {spawn}=require('node:child_process');
const {MANAGED,inside,plain,tree,writeJson,validateStage,checkInstallRoot}=require('./update-files.cjs');
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function rename(from,to) { for(let n=0;;n++){try{fs.renameSync(from,to);return;}catch(e){if(n===19||!['EPERM','EBUSY','EACCES'].includes(e.code))throw e;await sleep(250);}} }
async function replaceProgram(job, hooks={}) {
  const {root,dataDir,stage,backup,version}=job;
  checkInstallRoot(root,dataDir);tree(stage);plain(backup);
  if(!inside(stage,path.dirname(backup))||inside(backup,stage)||fs.existsSync(backup))throw Error('更新暂存目录无效');
  await validateStage(stage,version);
  fs.mkdirSync(backup,{recursive:true});const journal=[];
  try {
    for(const item of MANAGED) {
      const dest=path.join(root,item),old=path.join(backup,item),src=path.join(stage,item);
      fs.mkdirSync(path.dirname(old),{recursive:true});fs.mkdirSync(path.dirname(dest),{recursive:true});
      // Journal intent first so an interrupted operation remains recoverable from its two locations.
      const row={item,hadOld:fs.existsSync(dest),saved:false,installed:false};journal.push(row);writeJson(path.join(backup,'journal.json'),journal);
      if(row.hadOld){await rename(dest,old);row.saved=true;writeJson(path.join(backup,'journal.json'),journal);}
      await hooks.beforeMove?.(item);
      await rename(src,dest);row.installed=true;writeJson(path.join(backup,'journal.json'),journal);
    }
    return {backup};
  } catch(error) {
    // Keep failed new files in staging; never recursively delete user folders.
    const failures=[];
    for(const row of journal.toReversed()) {try{
      const dest=path.join(root,row.item),old=path.join(backup,row.item),src=path.join(stage,row.item);
      if(row.installed){fs.mkdirSync(path.dirname(src),{recursive:true});await rename(dest,src);}
      if(row.saved)await rename(old,dest);
    }catch(e){failures.push(row.item);}}
    if(failures.length)throw Error('程序文件恢复未完成，请按更新说明使用 previous-program 与 journal.json 恢复：'+failures.join(', '));
    throw Error('安装未完成，原程序已恢复：'+error.message);
  }
}
async function run(jobFile) {
  plain(jobFile);const job=JSON.parse(fs.readFileSync(jobFile,'utf8')),dir=path.dirname(jobFile);
  const result=path.join(job.dataDir,'updates','last-result.json');
  if(!inside(dir,path.join(job.dataDir,'updates'))||path.resolve(job.backup)!==path.join(dir,'previous-program')||path.resolve(job.stage)!==path.join(dir,'extracted','AgentWorkbench'))throw Error('安装任务路径无效');
  const pid=job.parentPid;if(!Number.isInteger(pid)||pid<=0||pid===process.pid)throw Error('安装进程信息无效');
  let hasLock=false;
  try {
    const lock=fs.openSync(path.join(job.dataDir,'updates','install.lock'),'wx');fs.closeSync(lock);
    hasLock=true;
    try {
      let exited=false;
      for(let i=0;i<240;i++){try{process.kill(pid,0);}catch(e){if(e.code==='ESRCH'){exited=true;break;}throw e;}await sleep(500);}
      if(!exited)throw Error('工作台尚未退出，本次未替换文件');
      // SQLite online backup also remains consistent if an independent MCP reader is open.
      const snapshot=path.join(dir,'before-update-data');fs.mkdirSync(snapshot,{recursive:true});
      const database=path.join(job.dataDir,'workbench.sqlite');plain(database);
      if(fs.existsSync(database)){const {DatabaseSync,backup}=require('node:sqlite');const db=new DatabaseSync(database,{readOnly:true});try{await backup(db,path.join(snapshot,'workbench.sqlite'));}finally{db.close();}}
      await replaceProgram(job);
      writeJson(result,{status:'installed',version:job.version,at:new Date().toISOString(),jobDir:dir});
    }finally{if(hasLock)fs.unlinkSync(path.join(job.dataDir,'updates','install.lock'));}
    const env={...process.env,WORKBENCH_ROOT:job.root,WORKBENCH_DATA_DIR:job.dataDir};delete env.ELECTRON_RUN_AS_NODE;
    const child=spawn(path.join(job.root,'桌面版/工作台/工作台.exe'),[],{cwd:job.root,detached:true,windowsHide:true,stdio:'ignore',env});
    await new Promise((resolve,reject)=>{child.once('spawn',resolve);child.once('error',reject);});child.unref();
  }catch(e){writeJson(result,{status:'error',message:e.message,version:job.version,jobDir:dir,at:new Date().toISOString()});throw e;}
}
if(require.main===module)run(process.argv[2]).catch(e=>{process.stderr.write(e.message+'\n');process.exitCode=1;});
module.exports={replaceProgram,run};
