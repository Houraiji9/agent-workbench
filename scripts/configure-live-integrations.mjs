// One-time local wiring. Does not read any account credentials or session DB.
import fs from 'node:fs';import path from 'node:path';import crypto from 'node:crypto';import {fileURLToPath} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const privateDir=path.join(root,'data/integrations/private');fs.mkdirSync(privateDir,{recursive:true});
const key=name=>{const f=path.join(privateDir,name);if(!fs.existsSync(f))fs.writeFileSync(f,crypto.randomBytes(32).toString('hex'),{mode:0o600});return path.relative(root,f)};
const configFile=path.join(root,'config/local.json');if(!fs.existsSync(configFile)){fs.mkdirSync(path.dirname(configFile),{recursive:true});fs.copyFileSync(path.join(root,'config/example.json'),configFile);}const config=JSON.parse(fs.readFileSync(configFile,'utf8'));config.integrations??={};
for(const [name,url]of Object.entries({tokenMonitor:'http://127.0.0.1:17321',agentsView:'http://127.0.0.1:4319'}))if(config.integrations[name]?.baseUrl&&config.integrations[name].baseUrl!==url)throw new Error('Existing integration endpoint must not be replaced: '+name);
if(!fs.existsSync(path.join(privateDir,'workbench-config.before.json')))fs.copyFileSync(configFile,path.join(privateDir,'workbench-config.before.json'));
config.integrations.tokenMonitor={baseUrl:'http://127.0.0.1:17321',secretFile:key('token-monitor.key'),managed:true,desktopExe:path.join(process.env.LOCALAPPDATA,'Programs/Token Monitor/Token Monitor.exe')};
config.integrations.agentsView={baseUrl:'http://127.0.0.1:4319',secretFile:key('agentsview.key'),managed:true};
fs.writeFileSync(configFile,JSON.stringify(config,null,2));
const av=path.join(root,'data/integrations/agentsview/state');fs.mkdirSync(av,{recursive:true});
const avConfig=path.join(av,'config.toml');
if(!fs.existsSync(avConfig))fs.writeFileSync(avConfig,`host = "127.0.0.1"\nport = 4319\nrequire_auth = true\ndisable_update_check = true\ndaemon_idle_timeout = "0s"\narchive_content = "transcripts"\n# Official standard session directories only; no disk-wide discovery.\n`);
if(process.argv.includes('--connect-desktop')){
 const settingsFile=path.join(process.env.APPDATA,'Token Monitor/settings.json');
 const original=fs.readFileSync(settingsFile,'utf8');
 const backup=path.join(privateDir,'token-monitor-settings.before.json');if(!fs.existsSync(backup))fs.writeFileSync(backup,original,{mode:0o600});
 const settings=JSON.parse(original);if(!['local','client'].includes(settings.hubMode))throw new Error('Existing host settings require manual reconciliation');
 if(settings.hubMode==='client'&&settings.hubUrl&&settings.hubUrl!==config.integrations.tokenMonitor.baseUrl)throw new Error('Existing remote Hub must not be replaced');
 settings.hubMode='client';settings.hubUrl=config.integrations.tokenMonitor.baseUrl;settings.hubSyncSessionTitles=false;
 // Only connection fields change. The desktop loads and persists its own credentials.
 fs.writeFileSync(settingsFile,JSON.stringify(settings,null,2),{mode:0o600});
}
console.log('Local integration configuration prepared. No secrets printed.');
