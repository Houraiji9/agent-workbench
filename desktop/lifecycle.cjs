const {spawn} = require('node:child_process');

async function stopBackend(child, graceMs = 10000) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  let timer;
  const exited = new Promise(resolve => child.once('exit', resolve));
  const timeout = new Promise(resolve => { timer=setTimeout(()=>resolve(false),graceMs); });
  if(child.connected)child.send({type:'shutdown'},()=>{});
  try {
    if(await Promise.race([exited.then(()=>true),timeout]))return;
    if(child.exitCode!==null||child.signalCode!==null)return;
    if(process.platform==='win32') {
      await new Promise((resolve,reject)=>{
        const killer=spawn('taskkill.exe',['/PID',String(child.pid),'/T','/F'],{windowsHide:true,stdio:'ignore'});
        killer.once('error',reject);
        killer.once('exit',code=>code===0||child.exitCode!==null||child.signalCode!==null?resolve():reject(new Error('后台进程树未能退出')));
      });
    } else child.kill('SIGKILL');
    await exited;
  } finally { clearTimeout(timer); }
}
module.exports={stopBackend};
