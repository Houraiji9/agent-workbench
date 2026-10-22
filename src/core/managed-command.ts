import {spawn,type SpawnOptions} from 'node:child_process';

// A bounded child command with explicit descendant cleanup on Windows.
export function managedCommand(exe:string,args:string[],options:SpawnOptions,timeoutMs=90000){
  const child=spawn(exe,args,{...options,windowsHide:true,stdio:['ignore','pipe','pipe']});
  let stdout='',stderr='',reason='',termination:Promise<void>|undefined;
  const terminate=():Promise<void>=>{
    if(termination)return termination;
    if(child.exitCode!==null||child.signalCode!==null||!child.pid)return Promise.resolve();
    termination=process.platform==='win32'?new Promise<void>((resolve,reject)=>{
      // This PID belongs to the still-live ChildProcess handle, never a discovered process.
      const killer=spawn('taskkill.exe',['/PID',String(child.pid),'/T','/F'],{windowsHide:true,stdio:'ignore'});
      killer.once('error',reject);killer.once('exit',code=>code===0||child.exitCode!==null||child.signalCode!==null?resolve():reject(new Error('无法清理图解进程树')));
    }):new Promise<void>(resolve=>{child.once('exit',()=>resolve());child.kill('SIGKILL')});
    return termination;
  };
  const cancel=async(message='图解已取消')=>{reason=message;await terminate()};
  const result=new Promise<{stdout:string;stderr:string}>((resolve,reject)=>{
    const timer=setTimeout(()=>{void cancel('图解生成超时').catch(reject)},timeoutMs);
    const append=(kind:'stdout'|'stderr',bytes:Buffer)=>{
      if(reason)return;
      if(kind==='stdout')stdout+=bytes.toString();else stderr+=bytes.toString();
      if(Buffer.byteLength(stdout)+Buffer.byteLength(stderr)>2*1024*1024)void cancel('图解输出过大').catch(reject);
    };
    child.stdout!.on('data',b=>append('stdout',b));child.stderr!.on('data',b=>append('stderr',b));
    child.once('error',e=>{clearTimeout(timer);reject(e)});
    child.once('close',code=>{clearTimeout(timer);void (async()=>{
      await termination;
      if(code===0&&!reason)resolve({stdout,stderr});
      else reject(Object.assign(new Error(reason||'Archify 未通过检查'),{stdout,stderr}));
    })().catch(reject)});
  });
  return {child,result,cancel};
}
