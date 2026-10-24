import {test,expect} from '@playwright/test';
import fs from 'node:fs';import path from 'node:path';import {randomUUID} from 'node:crypto';
import {api,EVIDENCE,noHorizontalScroll} from './support.ts';

test('会话 MCP 直接保存和编辑，打开的需求箱自动同步，不用页面填表',async({page})=>{
  const {root}=await api(page);
  // Isolated browser-server fixture only; never access production credentials.
  expect(path.basename(root)).toBe('app');expect(path.basename(path.dirname(root))).toMatch(/^browser-/);
  const token=JSON.parse(fs.readFileSync(path.join(root,'data/keys.json'),'utf8')).manager;
  const call=async(tool:string,change:any)=>{const r=await page.request.post('/api/mcp/'+tool,{headers:{authorization:'Bearer '+token},data:{request_id:randomUUID(),user_instruction:'隔离测试用户：请在会话里直接记录和修改，不要让我再填表。',change}});expect(r.ok(),await r.text()).toBeTruthy();return (await r.json()).result};
  await page.goto('/#/requests');
  const q=await call('manage_requests',{action:'create',data:{project_id:'P-workbench',text:'测试：从 Agent 会话直接保存的备忘',status:'draft'}});
  await expect(page.getByRole('article',{name:q.text,exact:true})).toBeVisible();
  const updated=await call('manage_requests',{action:'update',request_id:q.id,data:{project_id:q.project_id,text:'测试：我说一句，备忘已经更新',status:'draft',version:q.version}});
  await expect(page.getByRole('article',{name:updated.text,exact:true})).toBeVisible();await expect(page.getByRole('article',{name:q.text,exact:true})).toHaveCount(0);
  await expect(page.getByRole('dialog')).toHaveCount(0);await noHorizontalScroll(page);
  if(process.env.WORKBENCH_EVIDENCE_DIR){fs.mkdirSync(EVIDENCE,{recursive:true});await page.screenshot({animations:'disabled',path:path.join(EVIDENCE,'会话直接修改-需求箱同步.png')})}
  await call('manage_requests',{action:'delete',request_id:q.id,version:updated.version});await expect(page.getByRole('article',{name:updated.text,exact:true})).toHaveCount(0);
});
