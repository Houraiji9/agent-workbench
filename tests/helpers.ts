import {seedTestData} from './fixtures.ts';
import {after} from 'node:test';
const createdFixtures=new Set<string>();
after(()=>{for(const dir of createdFixtures){if(path.dirname(dir)!==path.join(ROOT,'.test-tmp')||!path.basename(dir).startsWith('测试项目-'))throw Error('测试清理范围异常');if(fs.existsSync(dir)&&!fs.lstatSync(dir).isSymbolicLink())fs.rmSync(dir,{recursive:true,force:true,maxRetries:3,retryDelay:100})}});
import fs from 'node:fs';import path from 'node:path';import crypto from 'node:crypto';import {ROOT,type Config} from '../src/core/config.ts';import {Workbench} from '../src/core/workbench.ts';
export function fixture(){const root=path.join(ROOT,'.test-tmp','测试项目-'+crypto.randomUUID());fs.mkdirSync(root,{recursive:true});createdFixtures.add(root);const config:Config={root,dataDir:path.join(root,'data'),port:14317,timezone:'America/Los_Angeles',authorizedRoots:[root],integrations:{tokenMonitor:{baseUrl:''},agentsView:{baseUrl:''}}};return {config,root,wb:seedTestData(new Workbench(config))}}
export function taskInput(root:string,key='task'){return {key,title:'测试专用：回执与归档',agent_id:'codex',reviewer_id:'grok-build',work_kind:'engineering',rationale:'测试环境验证工程闭环',goal:'验证真实业务约束',scope:'仅临时目录',non_goals:['不修改生产数据'],required_files:[],allowed_paths:[root],forbidden_actions:['禁止越权'],deliverables:['结果报告'],acceptance:['真实测试通过'],tests:['npm test'],dependencies:[],capabilities:['TypeScript'],risk:'medium',resource_expectation:'现有订阅，实际消耗未知',additional_cost_limit:0,currency:null,deadline:null,fallback:'等待资源',stop_conditions:['超出授权范围立即停止']}}
export function setup(wb:Workbench,root:string){const q=wb.request({project_id:'P-workbench',text:'测试数据：验证回执生命周期'});const plan={schema_version:1,plan_id:'plan-'+crypto.randomUUID(),request_id:q.id,expected_version:1,tasks:[taskInput(root)]};const p=wb.submitPlan(plan);const order=wb.exportOrder(p.task_ids[0],1);return {q,plan,tid:p.task_ids[0],rid:order.run_id,order}}
export function event(root:string,tid:string,rid:string,seq:number,type='started',extra:any={}){return {schema_version:1,event_id:'EV-'+crypto.randomUUID(),task_id:tid,run_id:rid,task_version:1,seq,event_type:type,occurred_at:new Date().toISOString(),data:{identity:'codex',cwd:root,message:'测试数据：'+type,...extra}}}

/** Explicitly perform the executor's separate closeout in acceptance-focused fixtures. */
export function finishCloseout(wb:Workbench,tid:string){
  let r=wb.get('runs',wb.get('tasks',tid).current_run_id);
  const send=(type:string,extra:any={})=>{r=wb.get('runs',r.id);const e=wb.event(event(r.cwd,tid,r.id,r.seq+1,type,{identity:r.agent_id,closeout_id:r.closeout.id,...extra}));if(e.disposition!=='applied')throw Error(e.error||'测试收尾未应用');return e};
  send('closeout_started');
  return send('closeout_completed',{result:'隔离测试中的执行者收尾报告：已逐项核对入口和文档，不是实际生产验收。',closeout_results:r.closeout.items.map((i:any)=>({item_id:i.id,outcome:'done',evidence:'隔离测试实际核对了此项收尾结果'}))});
}
