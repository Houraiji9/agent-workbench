import fs from 'node:fs';
import path from 'node:path';
import {ROOT,type Config} from '../src/core/config.ts';
import {Workbench} from '../src/core/workbench.ts';
import {seedTestData} from './fixtures.ts';
export {setup,event,taskInput,finishCloseout} from './helpers.ts';

/** Keep synthetic ledgers and logs for review; never delete them or use production configuration. */
export function fixture(){
  const base=process.env.PROJECT_MANAGEMENT_TEST_ROOT||path.join(ROOT,'.test-tmp','agent-routing');fs.mkdirSync(base,{recursive:true});
  const root=fs.mkdtempSync(path.join(base,'routing-'));
  const config:Config={root,dataDir:path.join(root,'data'),port:14317,timezone:'America/Los_Angeles',authorizedRoots:[root],integrations:{tokenMonitor:{baseUrl:''},agentsView:{baseUrl:''}}};
  return {config,root,wb:seedTestData(new Workbench(config))};
}
