import {seedTestData} from './fixtures.ts';
import fs from 'node:fs';import path from 'node:path';import {ROOT} from '../src/core/config.ts';import {createApp} from '../src/server/app.ts';
const testBase=process.env.WORKBENCH_BROWSER_TEMP_DIR?path.resolve(process.env.WORKBENCH_BROWSER_TEMP_DIR):path.join(ROOT,'.test-tmp');
const root=path.join(testBase,'browser-'+Date.now(),'app'),dataDir=path.join(root,'data');
fs.mkdirSync(dataDir,{recursive:true});fs.cpSync(path.join(ROOT,'dist'),path.join(root,'dist'),{recursive:true});
const {app,wb}=await createApp({root,dataDir,authorizedRoots:[root],port:14318,timezone:'America/Los_Angeles',integrations:{tokenMonitor:{baseUrl:''},agentsView:{baseUrl:''}}},{background:false});seedTestData(wb);await app.listen({host:'127.0.0.1',port:14318});

let stopping=false;async function stop(){if(stopping)return;stopping=true;await app.close();const dir=path.dirname(root);if(path.dirname(dir)!==testBase||!path.basename(dir).startsWith('browser-')||fs.lstatSync(dir).isSymbolicLink())throw Error('本轮页面测试清理范围异常');if(process.env.WORKBENCH_RETAIN_TEST_DATA!=='1')fs.rmSync(dir,{recursive:true,force:true,maxRetries:3,retryDelay:100});process.exit(0)}
process.on('SIGTERM',()=>void stop());process.on('SIGINT',()=>void stop());
