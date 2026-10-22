// Local configuration only. Token Monitor account files are never opened here.
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';
export function inside(file, base) {
 const target=path.resolve(file),boundary=fs.realpathSync(base);let ancestor=target;
 while(!fs.existsSync(ancestor))ancestor=path.dirname(ancestor);
 const actual=path.resolve(fs.realpathSync(ancestor),path.relative(ancestor,target)),rel=path.relative(boundary,actual);
 if(!rel||rel==='..'||rel.startsWith('..'+path.sep)||path.isAbsolute(rel))throw Error('连接密钥必须放在工作台 data 目录内。');
 return target;
}
export function atomic(file,value) {
 const temp=file+'.'+crypto.randomUUID()+'.tmp';
 try{fs.writeFileSync(temp,value,{mode:0o600,flag:'wx'});fs.renameSync(temp,file);}finally{if(fs.existsSync(temp))fs.unlinkSync(temp);}
}
const available=port=>new Promise(resolve=>{const server=net.createServer();server.once('error',()=>resolve(false));server.listen(port,'127.0.0.1',()=>server.close(()=>resolve(true)));});
export async function configure({root,desktopExe,dataDir=process.env.WORKBENCH_DATA_DIR||path.join(root,'data'),port,agentsView=false}) {
 const configFile=path.join(root,'config/local.json'),original=fs.existsSync(configFile)?fs.readFileSync(configFile,'utf8'):null;
 const config=JSON.parse((original||fs.readFileSync(path.join(root,'config/example.json'),'utf8')).replace(/^\uFEFF/,''));
 const previous=config.integrations?.tokenMonitor;
 if(previous?.baseUrl&&!previous.managed)throw Error('已有 Token Monitor 连接已保留。若要改为本机服务，请先备份并清空 config/local.json 中的 tokenMonitor 连接。');
 if(desktopExe&&(!fs.existsSync(desktopExe)||!fs.statSync(desktopExe).isFile()||path.basename(desktopExe).toLowerCase()!=='token monitor.exe'))throw Error('请选择已安装的 Token Monitor.exe。');
 if(agentsView&&config.integrations?.agentsView?.baseUrl)throw Error('已有 AgentsView 连接已保留；请单独配置该服务。');
 if(previous?.baseUrl){const u=new URL(previous.baseUrl);if(u.protocol!=='http:'||u.hostname!=='127.0.0.1'||!u.port||u.username||u.password||u.pathname!=='/'||u.search||u.hash)throw Error('已有自管地址不是本机 HTTP 地址，请先检查配置。');if(port&&Number(port)!==Number(u.port))throw Error('已有端口已保留，请先检查配置。');port=Number(u.port);}
 else {
  if(port!==undefined&&(!Number.isInteger(port)||port<1024||port>65535))throw Error('服务端口应为 1024–65535。');
  if(port&&!await available(port))throw Error('选择的端口正在使用，请选择其他端口。');
  if(!port)for(let candidate=17321;candidate<=17340;candidate++)if(await available(candidate)){port=candidate;break;}
  if(!port)throw Error('本机连接端口均已占用，请指定其他端口。');
 }
 fs.mkdirSync(dataDir,{recursive:true});
 const privateDir=inside(path.join(dataDir,'integrations/private'),dataDir);fs.mkdirSync(privateDir,{recursive:true});
 const keyFile=inside(path.resolve(root,previous?.secretFile||path.join(privateDir,'token-monitor.key')),dataDir);
 if(previous?.baseUrl&&(!previous.secretFile||!fs.existsSync(keyFile)))throw Error('已有连接缺少密钥文件，请恢复原文件，避免生成不匹配的密钥。');
 if(fs.existsSync(keyFile)&&(fs.statSync(keyFile).size>4096||!/^\S{32,4096}$/.test(fs.readFileSync(keyFile,'utf8').trim())))throw Error('本机连接密钥格式异常，请检查原文件。');
 const backupFile=inside(path.join(privateDir,'workbench-config.before.json'),dataDir);
 if(original&&!fs.existsSync(backupFile))fs.writeFileSync(backupFile,original,{mode:0o600,flag:'wx'});
 if(!fs.existsSync(keyFile))fs.writeFileSync(keyFile,crypto.randomBytes(32).toString('hex'),{mode:0o600,flag:'wx'});
 config.integrations??={};
 config.integrations.tokenMonitor={baseUrl:`http://127.0.0.1:${port}`,managed:true,secretFile:path.relative(root,keyFile),...(previous?.desktopExe?{desktopExe:previous.desktopExe}:{}),...(desktopExe?{desktopExe:path.resolve(desktopExe)}:{})};
 if(agentsView){
  const avKey=inside(path.join(privateDir,'agentsview.key'),dataDir);if(!fs.existsSync(avKey))fs.writeFileSync(avKey,crypto.randomBytes(32).toString('hex'),{mode:0o600,flag:'wx'});
  config.integrations.agentsView={baseUrl:'http://127.0.0.1:4319',secretFile:path.relative(root,avKey),managed:true};
  const avState=inside(path.join(dataDir,'integrations/agentsview/state'),dataDir);fs.mkdirSync(avState,{recursive:true});
  const avConfig=inside(path.join(avState,'config.toml'),dataDir);if(!fs.existsSync(avConfig))fs.writeFileSync(avConfig,'host = "127.0.0.1"\nport = 4319\nrequire_auth = true\ndisable_update_check = true\ndaemon_idle_timeout = "0s"\narchive_content = "transcripts"\n');
 }
 fs.mkdirSync(path.dirname(configFile),{recursive:true});atomic(configFile,JSON.stringify(config,null,2)+'\n');
 return {baseUrl:config.integrations.tokenMonitor.baseUrl,secretFile:keyFile,settingsChanged:false};
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const args=process.argv.slice(2),value=name=>args[args.indexOf(name)+1];
 try{
  if(args.includes('--connect-desktop'))throw Error('请在 Token Monitor 的多设备同步页面选择连接已有 Hub，填写连接地址与密钥。工作台已改为保留原软件设置。');
  const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
  const result=await configure({root,desktopExe:args.includes('--desktop')?value('--desktop'):undefined,port:args.includes('--port')?Number(value('--port')):undefined,agentsView:args.includes('--agentsview')});
  console.log(JSON.stringify(result));
 }catch(error){console.error(error.message);process.exitCode=1;}
}
