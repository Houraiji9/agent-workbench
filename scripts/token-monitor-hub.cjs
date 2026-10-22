// Runs the installed vendor's Hub implementation, without another collector.
const fs=require('node:fs');
const path=require('node:path');
const root=path.resolve(__dirname,'..');
const config=JSON.parse(fs.readFileSync(path.join(root,'config/local.json'),'utf8'));
const settings=config.integrations.tokenMonitor;
const address=new URL(settings.baseUrl);
if(address.hostname!=='127.0.0.1')throw new Error('Managed Hub must bind to loopback');
const secret=fs.readFileSync(path.resolve(root,settings.secretFile),'utf8').trim();
if(secret.length<32)throw new Error('Missing private Hub token');
const {createHub}=require('../data/integrations/token-monitor/upstream-0.70.0/src/hub/server.js');
const hub=createHub({port:Number(address.port),host:'127.0.0.1',secret,syncSessionTitles:false,dataFile:path.join(root,'data/integrations/token-monitor/hub/devices.json'),logger:{log(){},warn(){},error(){console.error('Hub request failed')}}});
hub.start().then(()=>console.log('Token Monitor official Hub ready (loopback only)')).catch(()=>process.exit(1));
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>hub.stop().then(()=>process.exit(0)));
