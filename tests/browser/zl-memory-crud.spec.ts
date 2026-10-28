import {test,expect,type Page} from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {makeTask,noHorizontalScroll,shot,type Made} from './support.ts';

async function agentMemory(page:Page,m:Made,content:string,status='candidate'){
 const token=JSON.parse(fs.readFileSync(path.join(path.dirname(m.root),'data','run-keys',m.rid+'.json'),'utf8')).token;
 const response=await page.request.post('/api/mcp/manage_memories',{headers:{authorization:'Bearer '+token},data:{run_id:m.rid,request_id:randomUUID(),user_instruction:'合成浏览器验证：当前执行者保存本轮经验，保留实际Agent来源。',change:{project_id:m.project.id,kind:'decision',status,content,source_id:m.tid}}});
 expect(response.ok(),await response.text()).toBe(true);return (await response.json()).result;
}
const memoryRow=(page:Page,marker:string)=>page.locator('.project-memories > .memory-list > article').filter({hasText:marker});

test('用户页面与真实Agent接口记录均可编辑取消删除恢复，原作者来源和修订历史保留',async({page})=>{
 test.setTimeout(90000);
 const m=await makeTask(page,{title:'合成经验来源CRUD '+randomUUID(),stage:'order'}),tag=randomUUID().slice(0,8);
 const originals={user:`用户经验 ${tag} `+'可复用证据'.repeat(55)+` BROWSER_PRIVATE_TAIL_USER_${tag}`,agent:`Agent经验 ${tag} `+'自动记录证据'.repeat(55)+` BROWSER_PRIVATE_TAIL_AGENT_${tag}`};
 await page.goto('/#/projects/'+m.project.id+'?tab=memory');await page.getByRole('button',{name:'记一条',exact:true}).click();
 const create=page.getByRole('dialog',{name:'记下一条项目经验',exact:true});await create.getByLabel('内容',{exact:true}).fill(originals.user);await create.getByLabel('来自哪里').selectOption(m.tid);await create.getByRole('radio',{name:'我确认这是事实',exact:true}).click();await create.getByRole('button',{name:'记下',exact:true}).click();await expect(create).toHaveCount(0);
 const auto=await agentMemory(page,m,originals.agent);expect(auto.source).toBe('runner:'+m.rid);await page.reload();
 for(const origin of ['user','agent'] as const){
  const marker=(origin==='user'?'用户经验 ':'Agent经验 ')+tag,original=originals[origin],row=memoryRow(page,marker),before=(await m.get('/state')).memories.find((r:any)=>r.content===original);await expect(row).toBeVisible();expect(before).toBeTruthy();
  await row.getByRole('button',{name:'编辑',exact:true}).click();let edit=page.getByRole('dialog',{name:'编辑项目经验',exact:true});await edit.getByLabel('经验内容',{exact:true}).fill('本次取消的草稿 '+tag);await edit.getByRole('button',{name:'取消',exact:true}).click();await expect(edit).toHaveCount(0);expect((await m.get('/state')).memories.find((r:any)=>r.id===before.id).content).toBe(original);
  await row.getByRole('button',{name:'编辑',exact:true}).click();edit=page.getByRole('dialog',{name:'编辑项目经验',exact:true});await edit.getByLabel('经验内容',{exact:true}).fill(original+' 已编辑');await edit.getByLabel('经验类型').selectOption('known_issue');await edit.getByLabel('适用范围',{exact:true}).fill('本项目');await edit.getByRole('button',{name:'保存',exact:true}).click();await expect(edit).toHaveCount(0);
  await expect(row).toContainText('已编辑');await expect(row).toContainText('原作者：'+(origin==='user'?'用户':'runner:'+m.rid));await expect(row).toContainText(m.title);const saved=(await m.get('/state')).memories.find((r:any)=>r.id===before.id);expect(saved.source).toBe(before.source);expect(saved.source_id).toBe(m.tid);expect(saved.confirmation).toEqual(before.confirmation);expect(saved.status).toBe(origin==='user'?'confirmed':'candidate');expect(saved.version).toBe(2);
  const context=await m.get('/projects/'+m.project.id+'/context');expect(JSON.stringify(context)).not.toContain('BROWSER_PRIVATE_TAIL');expect(await noHorizontalScroll(page)).toBe(true);await shot(page,'经验-'+origin+'-已编辑');
  await row.getByRole('button',{name:'删除',exact:true}).click();await expect(row).toHaveCount(0);expect((await m.get('/state')).memories.some((r:any)=>r.id===before.id)).toBe(false);expect((await m.get('/projects/'+m.project.id+'/context')).memories.some((r:any)=>r.id===before.id)).toBe(false);
  await page.getByRole('button',{name:'历史与已删除',exact:true}).click();await expect(row).toBeVisible();await expect(row.locator('.pill').first()).toHaveText('已删除');await row.locator(':scope > details > summary').click();await expect(row.getByText(original,{exact:true})).toBeVisible();await shot(page,'经验-'+origin+'-删除与修订历史');
  const history=(await m.get('/projects/'+m.project.id+'/memories/history')).items.find((r:any)=>r.id===before.id);expect(history.deleted_at).toBeTruthy();expect(history.source).toBe(before.source);expect(history.source_id).toBe(m.tid);expect(history.revisions).toHaveLength(2);
  await row.getByRole('button',{name:'恢复',exact:true}).click();await expect(row.locator('.pill').first()).toHaveText(origin==='user'?'已确认':'候选');await page.getByRole('button',{name:'返回当前经验',exact:true}).click();await expect(row).toBeVisible();
  const restored=(await m.get('/state')).memories.find((r:any)=>r.id===before.id);expect(restored.version).toBe(4);expect(restored.source).toBe(before.source);expect(restored.source_id).toBe(m.tid);expect(restored.confirmation).toEqual(before.confirmation);expect(restored.revisions).toHaveLength(3);await shot(page,'经验-'+origin+'-已恢复');
 }
 expect((await m.get('/tasks/'+m.tid)).task.id).toBe(m.tid);expect(await noHorizontalScroll(page)).toBe(true);
});

test('已被替代的用户和Agent经验可编辑删除恢复，恢复后不重新成为当前事实',async({page})=>{
 const m=await makeTask(page,{title:'合成已替代经验 '+randomUUID(),stage:'order'}),tag=randomUUID().slice(0,8);
 for(const origin of ['user','agent']){
  const marker=`已替代${origin} ${tag}`,content=marker+' 原内容';
  const old=origin==='agent'?await agentMemory(page,m,content,'confirmed'):await m.post('/memories',{project_id:m.project.id,kind:'decision',status:'confirmed',content,source_id:m.tid});
  const replacement=await m.post('/memories',{project_id:m.project.id,kind:'decision',status:'confirmed',content:`后继${origin} ${tag}`,source_id:m.tid,supersedes:old.id});
  await page.goto('/#/projects/'+m.project.id+'?tab=memory');await page.reload();const row=memoryRow(page,marker);await expect(row.locator('.pill').first()).toHaveText('已被取代');
  await row.getByRole('button',{name:'编辑',exact:true}).click();const edit=page.getByRole('dialog',{name:'编辑项目经验',exact:true});await edit.getByLabel('经验内容',{exact:true}).fill(content+' 修订说明');await edit.getByRole('button',{name:'保存',exact:true}).click();await expect(edit).toHaveCount(0);await expect(row).toContainText('修订说明');await expect(row.locator('.pill').first()).toHaveText('已被取代');
  await row.getByRole('button',{name:'删除',exact:true}).click();await expect(row).toHaveCount(0);await page.getByRole('button',{name:'历史与已删除',exact:true}).click();await expect(row.locator('.pill').first()).toHaveText('已删除');await row.getByRole('button',{name:'恢复',exact:true}).click();await expect(row.locator('.pill').first()).toHaveText('已被取代');
  const current=await m.get('/state'),restored=current.memories.find((r:any)=>r.id===old.id);expect(restored.source).toBe(old.source);expect(restored.status).toBe('superseded');expect(current.memories.find((r:any)=>r.id===replacement.id).supersedes).toBe(old.id);await shot(page,'经验-'+origin+'-恢复保留替代状态');
  await page.getByRole('button',{name:'返回当前经验',exact:true}).click();
 }
});

test('编辑期间服务端版本变化会拒绝覆盖，页面保留草稿供复制或取消',async({page})=>{
 const m=await makeTask(page,{title:'合成经验冲突 '+randomUUID()}),marker='并发经验 '+randomUUID().slice(0,8),original=await m.post('/memories',{project_id:m.project.id,kind:'handoff',status:'candidate',content:marker,source_id:m.tid});
 await page.goto('/#/projects/'+m.project.id+'?tab=memory');await memoryRow(page,marker).getByRole('button',{name:'编辑',exact:true}).click();const edit=page.getByRole('dialog',{name:'编辑项目经验',exact:true}),draft=marker+' 未保存草稿';await edit.getByLabel('经验内容',{exact:true}).fill(draft);
 await m.post('/memories',{action:'update',project_id:m.project.id,memory_id:original.id,version:1,kind:'handoff',content:marker+' 其他窗口已保存',scope:'project'});await edit.getByRole('button',{name:'保存',exact:true}).click();await expect(edit.getByRole('alert')).toContainText('经验版本冲突');await expect(edit.getByLabel('经验内容',{exact:true})).toHaveValue(draft);await shot(page,'经验-版本冲突保留草稿');
 expect((await m.get('/state')).memories.find((r:any)=>r.id===original.id).content).toBe(marker+' 其他窗口已保存');await edit.getByRole('button',{name:'取消',exact:true}).click();await expect(edit).toHaveCount(0);
});
