// Official, pinned upstream Hub. Collection remains in the user's desktop app.
const fs=require('node:fs');
const path=require('node:path');
const {pathToFileURL}=require('node:url');
(async()=>{
 const root=path.resolve(__dirname,'..');
 const {inside}=await import(pathToFileURL(path.join(__dirname,'configure-live-integrations.mjs')).href);
 const config=JSON.parse(fs.readFileSync(path.join(root,'config/local.json'),'utf8').replace(/^\uFEFF/,''));
 const settings=config.integrations.tokenMonitor,address=new URL(settings.baseUrl);
 if(address.protocol!=='http:'||address.hostname!=='127.0.0.1'||!address.port||address.username||address.password||address.pathname!=='/'||address.search||address.hash)throw Error('自管服务只支持本机 HTTP 地址。');
 const dataDir=process.env.WORKBENCH_DATA_DIR||path.join(root,'data');
 const secretFile=inside(path.resolve(root,settings.secretFile),dataDir);
 if(fs.statSync(secretFile).size>4096)throw Error('连接密钥文件过大。');
 const secret=fs.readFileSync(secretFile,'utf8').trim();if(secret.length<32)throw Error('缺少本机连接密钥。');
 const dataFile=inside(path.join(dataDir,'integrations/token-monitor/hub/devices.json'),dataDir);
 const {createHub}=require('../vendor/token-monitor/src/hub/server.js');
 const hub=createHub({port:Number(address.port),host:'127.0.0.1',secret,syncSessionTitles:false,dataFile,logger:{log(){},warn(){},error(){console.error('Hub request failed')}}});
 await hub.start();console.log('Token Monitor official Hub ready (127.0.0.1 only)');
 for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>hub.stop().then(()=>process.exit(0)));
})().catch(error=>{console.error(error.message);process.exitCode=1;});
