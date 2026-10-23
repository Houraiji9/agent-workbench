import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
export const ROOT = process.env.WORKBENCH_ROOT || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export type IntegrationConfig = {baseUrl:string;secretEnv?:string;secretFile?:string;managed?:boolean;desktopExe?:string};
export type Config = {root:string; dataDir:string; port:number; timezone:string; authorizedRoots:string[]; review?:{grokExecutable?:string}; integrations:{tokenMonitor:IntegrationConfig;agentsView:IntegrationConfig}};
export function loadConfig():Config {
  const f=path.join(ROOT,'config/local.json'); const v=fs.existsSync(f)?JSON.parse(fs.readFileSync(f,'utf8')):{};
  return {root:ROOT,dataDir:process.env.WORKBENCH_DATA_DIR||path.join(ROOT,'data'),port:Number(process.env.WORKBENCH_PORT||v.port||4317),timezone:v.timezone||Intl.DateTimeFormat().resolvedOptions().timeZone||'UTC',review:v.review,authorizedRoots:v.authorizedRoots||[ROOT],integrations:v.integrations||{tokenMonitor:{baseUrl:''},agentsView:{baseUrl:''}}};
}
