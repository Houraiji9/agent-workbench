import {test,expect} from '@playwright/test';
import {randomUUID} from 'node:crypto';
import {api,shot} from './support.ts';

test('默认复制简短且不指定主脑，离线复制保留设置与精简项目背景',async({page})=>{
 const a=await api(page),p=await a.post('/projects',{name:'测试0412 '+randomUUID().slice(0,8),path:a.root+'/planning-'+randomUUID(),create:true});
 const q=await a.post('/requests',{project_id:p.id,text:'测试0412：Claude 可以负责规划；保留完整原文。',status:'awaiting_planning'});
 await page.addInitScript(()=>{(window as any).copied='';Object.defineProperty(navigator.clipboard,'writeText',{configurable:true,value:async(text:string)=>{(window as any).copied=text}})});
 await page.goto('/#/requests?tab=waiting');const card=page.getByRole('article',{name:q.text,exact:true});
 await card.getByRole('button',{name:'复制规划请求',exact:true}).click();
 await expect.poll(()=>page.evaluate(()=>(window as any).copied)).toContain(q.text);
 const copied=await page.evaluate(()=>(window as any).copied);expect(copied.length-q.text.length).toBeLessThan(550);expect(copied).toContain('get_chat_planning_context');expect(copied).not.toContain('给 Codex');
 await card.getByRole('button',{name:'在聊天里规划',exact:true}).click();const d=page.getByRole('dialog',{name:'在聊天里规划'});
 await d.getByRole('button',{name:'复制给规划 Agent',exact:true}).click();
 await expect.poll(()=>page.evaluate(()=>(window as any).copied)).toContain('plan_template');
 const data=JSON.parse((await page.evaluate(()=>(window as any).copied)).split('\n').slice(1).join('\n'));
 expect(data.request.text).toBe(q.text);expect(data.project_summary.source).toBe('workbench_project_records');expect(data.plan_template.planner.name).toBeNull();expect(data.project_memory).toBeUndefined();
 await shot(page,'0412-任意规划Agent与精简聊天资料');
});
test('接入说明明确支持 Claude，保留通用手册入口',async({page})=>{
 await page.goto('/#/settings');await expect(page.getByText('Codex、Claude 等都可以担任规划者。',{exact:false})).toBeVisible();await expect(page.getByRole('button',{name:'粘贴规划 Agent 的计划',exact:true})).toBeVisible();
});
