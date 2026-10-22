import {createApp} from './app.ts';
import {loadConfig} from '../core/config.ts';
const config=loadConfig();const {app}=await createApp(config);
try{await app.listen({host:'127.0.0.1',port:config.port});console.log(`工作台已启动：http://127.0.0.1:${config.port}（仅本机）`)}catch(e){console.error('启动失败：',(e as Error).message);process.exit(1)}
let stopping=false;
async function shutdown(){if(stopping)return;stopping=true;app.server.closeAllConnections();await app.close();process.exit(0)}
for(const signal of ['SIGINT','SIGTERM'] as const)process.on(signal,()=>void shutdown());
if(process.connected){process.on('message',(message:any)=>{if(message?.type==='shutdown')void shutdown()});process.on('disconnect',()=>void shutdown())}
