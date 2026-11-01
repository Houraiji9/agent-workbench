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
// A single flight covers startup, the low frequency check and resume. Shutdown
// removes every future trigger before awaiting the last launch, so cleanup cannot
// race a late PowerShell launch. Repeated identical failures are logged once.
function createIntegrationSupervisor({run, log, powerMonitor, intervalMs = 60000,
  setIntervalFn = setInterval, clearIntervalFn = clearInterval}) {
  let current, stopped = false, lastResult;
  function poll() {
    if (stopped) return Promise.resolve();
    if (current) return current;
    current = Promise.resolve().then(run).then(output => {
      const result = 'ok:' + (output || '');
      if (lastResult !== result) log('integrations_checked', {message: output || '本机数据服务已检查'});
      lastResult = result;
    }, error => {
      const message = error.message || String(error), result = 'error:' + message;
      if (lastResult !== result) log('integrations_error', {message});
      lastResult = result;
    }).finally(() => { current = undefined; });
    return current;
  }
  const onResume = () => { void poll(); };
  const timer = setIntervalFn(onResume, intervalMs);
  timer?.unref?.();
  powerMonitor.on('resume', onResume);
  return {poll, async stop() {
    stopped = true;
    clearIntervalFn(timer);
    powerMonitor.removeListener('resume', onResume);
    await current;
  }};
}
module.exports={stopBackend,createIntegrationSupervisor};
