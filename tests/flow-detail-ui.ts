// Focused synthetic browser fixture; no production ledger or external model calls.
import fs from 'node:fs';import path from 'node:path';import assert from 'node:assert/strict';
import {build} from 'vite';import {chromium} from '@playwright/test';
import {fixture,setup} from './helpers.ts';import {createApp} from '../src/server/app.ts';
const evidence=path.resolve(process.env.WORKBENCH_FLOW_UI_EVIDENCE||'.test-tmp/flow-detail-ui-evidence');fs.mkdirSync(evidence,{recursive:true});
process.env.WORKBENCH_RETAIN_TEST_DATA='1';
const f=fixture();f.wb.close();
await build({build:{outDir:path.join(f.root,'dist'),emptyOutDir:false},logLevel:'warn'});
const {app,wb}=await createApp(f.config,{background:false});
const target=setup(wb,f.root),source=setup(wb,f.root);
const t=wb.get('tasks',target.tid),r=wb.get('runs',target.rid),st=wb.get('tasks',source.tid);
wb.put('tasks',{...t,title:'隔离展示测试：协作交付收尾',status:'awaiting_confirmation'},{project_id:t.project_id});
wb.put('tasks',{...st,title:'隔离展示测试：整合主任务'},{project_id:st.project_id});
wb.put('runs',{...r,status:'submitted',closeout:{id:'CO-synthetic',status:'completed',source:'integration_owner',recorded_by:{role:'runner',id:'runner:synthetic-main',run_id:source.rid,agent_id:'codex'},items:[{id:'C1',text:'协作成果已覆盖'}],results:[{item_id:'C1',evidence:'隔离展示夹具：已记录覆盖说明'}],result:'隔离展示夹具的整合收尾报告，仅用于浏览器展示验证。',verification_warnings:['隔离夹具未知事项，保留未验证状态'],integration:{source_task_id:source.tid,source_run_id:source.rid,coverage_note:'隔离夹具覆盖说明',source:{review:{review_status:'passed',source:'synthetic'},deployment_evidence:{verification:'executor_reported',deployment_evidence:'synthetic only'}},coverage:[{path:'fixture.ts',status:'unchanged'}],warnings:['隔离夹具未知事项']}},notes:Array.from({length:8},(_,i)=>({id:'TN-synthetic-'+i,at:new Date().toISOString(),actor:'runner:synthetic-main',note:'隔离备注第'+(i+1)+'条',verification:'unverified_note',references:[]}))},{task_id:t.id});
await app.listen({host:'127.0.0.1',port:14317});
let browser;const checks:string[]=[];
try{
 browser=await chromium.launch({channel:'chrome',headless:true});const page=await browser.newPage({viewport:{width:1440,height:1000}});
 await page.goto('http://127.0.0.1:14317/#/today?task='+target.tid);
 const closeout=page.getByRole('region',{name:'收尾结果'}),notes=page.getByRole('region',{name:'事实与证据备注'});
 await closeout.getByRole('heading',{name:'整合负责人收尾结果'}).waitFor();
 assert.match(await closeout.innerText(),/runner:synthetic-main/);assert.match(await closeout.innerText(),new RegExp(source.rid));checks.push('integration_owner title and actual actor/run visible');
 assert.equal(await notes.locator(':scope > ul > li').count(),5);assert.equal(await notes.getByText('隔离备注第1条',{exact:true}).isVisible(),false);
 await notes.getByText('更早的备注（3）',{exact:true}).click();assert.equal(await notes.getByText('隔离备注第1条',{exact:true}).isVisible(),true);checks.push('latest five notes and expandable earlier three');
 assert.match(await notes.innerText(),/未经验证/);await closeout.getByText('整合来源、文件覆盖与未验证事项',{exact:true}).click();assert.match(await closeout.innerText(),/executor_reported/);assert.match(await closeout.innerText(),/未知事项/);checks.push('source deployment/review and warnings expand without verified-note badge');
 await closeout.scrollIntoViewIfNeeded();await page.screenshot({path:path.join(evidence,'wide.png')});
 await page.setViewportSize({width:390,height:844});await closeout.scrollIntoViewIfNeeded();
 const overflow=await page.evaluate(()=>({body:document.documentElement.scrollWidth>window.innerWidth,drawer:[...document.querySelectorAll('.drawer-body')].some(e=>e.scrollWidth>e.clientWidth+1)}));assert.equal(overflow.body,false);assert.equal(overflow.drawer,false);checks.push('390px and 1440px viewport no horizontal overflow');
 await notes.scrollIntoViewIfNeeded();await page.screenshot({path:path.join(evidence,'narrow.png')});
 await closeout.getByRole('button',{name:source.tid,exact:true}).click();await page.getByRole('heading',{name:'隔离展示测试：整合主任务',exact:true}).waitFor();checks.push('source task navigation opens the integration main task');
 fs.writeFileSync(path.join(evidence,'result.json'),JSON.stringify({status:'passed',synthetic:true,checks,fixture_root:f.root,screenshots:['wide.png','narrow.png']},null,2));
}finally{await browser?.close();await app.close();}
