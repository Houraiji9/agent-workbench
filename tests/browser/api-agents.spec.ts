import {test,expect,type Page} from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {api,noHorizontalScroll,shot} from './support.ts';

const record=(extra:Record<string,unknown>={})=>({id:'A-api-test',agent_id:'A-api-test',name:'测试 API 助手',base_url:'https://api.example.com/v1',model:'test-model',protocol:'chat_completions',system_prompt:'',enabled:true,has_key:true,status:'ready',version:1,...extra});
async function stub(page:Page,initial:any[]=[],vault=true){
  const state={agents:initial,saves:[] as any[],checks:[] as any[],failSave:false,cloudRequests:[] as string[]};
  page.on('request',request=>{if(new URL(request.url()).hostname==='api.example.com')state.cloudRequests.push(request.method());});
  await page.route('https://api.example.com/**',route=>route.abort('blockedbyclient'));
  await page.route('**/api/api-agents**',async route=>{
    const request=route.request(),pathname=new URL(request.url()).pathname;
    if(request.method()==='GET')return route.fulfill({json:{agents:state.agents,vault:{available:vault,reason:vault?undefined:'测试凭据库暂不可用'}}});
    const body=request.postDataJSON();
    if(pathname.endsWith('/save')){
      state.saves.push(body);if(state.failSave)return route.fulfill({status:409,json:{error:'配置已变化，请刷新后重试'}});
      const previous=state.agents.find(a=>a.id===body.id),hasKey=body.wipe_key?false:!!body.api_key||!!previous?.has_key;
      const next:any=record({...previous,...body,id:body.id||'A-api-new',agent_id:body.id||'A-api-new',has_key:hasKey,version:(previous?.version||0)+1,status:body.enabled===false?'disabled':hasKey?'ready':'missing_key'});
      delete next.api_key;delete next.wipe_key;state.agents=[...state.agents.filter(a=>a.id!==next.id),next];return route.fulfill({json:next});
    }
    if(pathname.endsWith('/check')){state.checks.push(body);return route.fulfill({json:{status:'ready',ready:true,message:'测试：地址、模型和本机密钥配置齐全。',checked_at:'2026-11-05T00:00:00Z'}});}
    return route.fulfill({status:400,json:{error:'测试夹具不支持此操作'}});
  });
  return state;
}

test('团队入口添加 API Agent，失败保留输入，保存不调用云端且密钥不回显',async({page})=>{
  const state=await stub(page);await page.goto('/#/team');await page.getByRole('button',{name:'添加 API 型 Agent',exact:true}).click();
  const dialog=page.getByRole('dialog',{name:'添加 API 型 Agent'});await expect(dialog).toBeVisible();await expect(page.getByRole('tab',{name:'API 型 Agent',exact:true})).toHaveAttribute('aria-selected','true');
  await dialog.getByRole('textbox',{name:'名称',exact:true}).fill('测试设计协作 Agent');await dialog.getByRole('textbox',{name:'API 地址',exact:true}).fill('https://api.example.com/v1');await dialog.getByLabel('API Key',{exact:true}).fill('synthetic-api-agent-secret');await dialog.getByRole('textbox',{name:'模型',exact:true}).fill('test-configured-model');
  await expect(dialog.getByRole('combobox',{name:'API 协议'})).toBeHidden();state.failSave=true;await dialog.getByRole('button',{name:'添加到团队',exact:true}).click();await expect(dialog.getByRole('alert')).toContainText('配置已变化');await expect(dialog.getByLabel('API Key',{exact:true})).toHaveValue('synthetic-api-agent-secret');
  state.failSave=false;await dialog.getByRole('button',{name:'添加到团队',exact:true}).click();await expect(dialog).toHaveCount(0);
  expect(state.saves.at(-1)).toMatchObject({name:'测试设计协作 Agent',base_url:'https://api.example.com/v1',model:'test-configured-model',protocol:'chat_completions',enabled:true,api_key:'synthetic-api-agent-secret'});expect(state.checks).toHaveLength(0);expect(state.cloudRequests).toHaveLength(0);
  expect(await page.evaluate(()=>JSON.stringify({local:{...localStorage},session:{...sessionStorage}}))).not.toContain('synthetic-api-agent-secret');await expect(page.locator('body')).not.toContainText('synthetic-api-agent-secret');
  const card=page.getByRole('article',{name:'测试设计协作 Agent',exact:true});await expect(card).toContainText('配置就绪，尚未验证调用');await card.getByRole('button',{name:'编辑配置'}).click();const edit=page.getByRole('dialog',{name:'编辑 API 型 Agent'});await expect(edit.getByLabel('API Key',{exact:true})).toHaveValue('');await expect(edit).toContainText('留空保留原密钥');
});

test('编辑空密钥保留，协议为高级项，本机检查不生成，撤销保留其他配置',async({page})=>{
  const state=await stub(page,[record()]);await page.goto('/#/team?tab=api');const card=page.getByRole('article',{name:'测试 API 助手',exact:true});await card.getByRole('button',{name:'编辑配置'}).click();const dialog=page.getByRole('dialog',{name:'编辑 API 型 Agent'});
  await dialog.getByText('高级设置',{exact:true}).click();await dialog.getByRole('combobox',{name:'API 协议'}).selectOption('responses');await dialog.getByRole('textbox',{name:'系统提示词（可选）'}).fill('测试：按项目范围协作并回报。');await dialog.getByRole('button',{name:'保存配置',exact:true}).click();await expect(dialog).toHaveCount(0);
  expect(state.saves[0]).toMatchObject({id:'A-api-test',version:1,protocol:'responses',system_prompt:'测试：按项目范围协作并回报。'});expect(state.saves[0]).not.toHaveProperty('api_key');expect(state.agents[0].has_key).toBe(true);
  await card.getByRole('button',{name:'本机配置检查'}).click();await expect(card.getByRole('status')).toContainText('未向模型服务发送请求');expect(state.checks).toEqual([{}]);expect(state.cloudRequests).toHaveLength(0);
  await card.getByRole('button',{name:'撤销密钥',exact:true}).click();const revoke=page.getByRole('dialog',{name:'撤销本机密钥'});await revoke.getByRole('button',{name:'撤销并停用'}).click();await expect(revoke).toHaveCount(0);expect(state.saves.at(-1)).toMatchObject({id:'A-api-test',version:2,wipe_key:true,enabled:false,name:'测试 API 助手',model:'test-model',protocol:'responses'});await expect(card).toContainText('尚未配置');await expect(card).toContainText('已停用');
});

test('含密钥的地址和远程明文地址会在本机拒绝，凭据库不可用时不允许输入Key',async({page})=>{
  const state=await stub(page);await page.goto('/#/team?tab=api');await page.getByRole('button',{name:'添加 API 型 Agent',exact:true}).click();const dialog=page.getByRole('dialog',{name:'添加 API 型 Agent'});
  await dialog.getByRole('textbox',{name:'名称',exact:true}).fill('测试地址校验');await dialog.getByRole('textbox',{name:'模型',exact:true}).fill('test-model');await dialog.getByRole('textbox',{name:'API 地址',exact:true}).fill('https://api.example.com/v1?api_key=synthetic-url-secret');await dialog.getByRole('button',{name:'添加到团队'}).click();await expect(dialog.getByRole('alert')).toContainText('不能包含');expect(state.saves).toHaveLength(0);
  await dialog.getByRole('textbox',{name:'API 地址',exact:true}).fill('http://api.example.com/v1');await dialog.getByRole('button',{name:'添加到团队'}).click();await expect(dialog.getByRole('alert')).toContainText('需要使用 HTTPS');expect(state.saves).toHaveLength(0);await dialog.getByRole('button',{name:'取消',exact:true}).click();
  await page.unroute('**/api/api-agents**');await stub(page,[],false);await page.reload();await page.getByRole('button',{name:'添加 API 型 Agent',exact:true}).click();await expect(page.getByRole('dialog').getByLabel('API Key',{exact:true})).toBeDisabled();await expect(page.getByRole('dialog')).toContainText('本机凭据库暂不可用');
});

test('API配置界面浅深色及窄屏可读，字段有标签且高级模型配置不冒称实际模型',async({page})=>{
  await stub(page,[record({name:'测试长名称 API 设计与实现助手',base_url:'https://api.example.com/'+('long-path/'.repeat(12)),model:'test-configured-model'})]);await page.goto('/#/team?tab=api');await expect(page.getByRole('article')).toContainText('调用配置模型');expect(await noHorizontalScroll(page)).toBe(true);await shot(page,'API型Agent-浅色');await page.evaluate(()=>{document.documentElement.dataset.theme='dark';});await shot(page,'API型Agent-深色');
  await page.setViewportSize({width:390,height:844});expect(await noHorizontalScroll(page)).toBe(true);const title=await page.locator('.api-agent-card h3').boundingBox();expect(title!.width).toBeGreaterThan(180);expect(title!.height).toBeLessThan(100);await shot(page,'API型Agent-窄屏');await page.getByRole('button',{name:'编辑配置'}).click();const dialog=page.getByRole('dialog',{name:'编辑 API 型 Agent'});await expect(dialog.getByRole('textbox',{name:'名称',exact:true})).toBeFocused();await shot(page,'API型Agent-窄屏表单',false);await dialog.getByText('高级设置',{exact:true}).click();await expect(dialog.getByRole('textbox',{name:'系统提示词（可选）'})).toHaveAttribute('maxlength','20000');expect(await noHorizontalScroll(page)).toBe(true);await dialog.getByRole('button',{name:'保存配置',exact:true}).scrollIntoViewIfNeeded();await expect(dialog.getByRole('button',{name:'保存配置',exact:true})).toBeVisible();await shot(page,'API型Agent-窄屏高级设置',false);await dialog.press('Escape');await expect(dialog).toHaveCount(0);
});

test('真实本机API保存后成为工作群负责人候选，建群不产生模型调用',async({page})=>{
  const backend=await api(page),root=path.join(backend.root,'测试API群-'+randomUUID());fs.mkdirSync(root,{recursive:true});const project=await backend.post('/projects',{name:'测试 API Agent 项目',path:root});
  const saved=await backend.post('/api-agents/save',{name:'测试真实 API 成员',base_url:'https://api.example.com/v1',model:'test-api-model',protocol:'chat_completions',api_key:'synthetic-real-api-test-key',enabled:true});
  expect(saved.has_key).toBe(true);expect(saved).not.toHaveProperty('api_key');const catalog=await backend.get('/api-agents');expect(JSON.stringify(catalog)).not.toContain('synthetic-real-api-test-key');
  const checked=await backend.post('/api-agents/'+saved.id+'/check',{});expect(checked.ready).toBe(true);
  await page.goto('/#/team/'+saved.id);const panel=page.getByRole('complementary',{name:'测试真实 API 成员 详情'});await expect(panel.getByRole('button',{name:'编辑分工',exact:true})).toHaveCount(0);await expect(panel.getByRole('button',{name:'编辑模型',exact:true})).toHaveCount(0);await panel.getByRole('button',{name:'配置 API 与密钥'}).click();const editor=page.getByRole('dialog',{name:'编辑 API 型 Agent'});await expect(editor.getByLabel('API Key',{exact:true})).toHaveValue('');await expect(editor.getByRole('textbox',{name:'模型',exact:true})).toHaveValue('test-api-model');await editor.getByRole('button',{name:'取消',exact:true}).click();
  await page.goto('/#/workgroups/'+project.id);await page.getByRole('button',{name:'创建项目工作群',exact:true}).click();const dialog=page.getByRole('dialog',{name:'创建项目工作群'});const select=dialog.getByRole('combobox',{name:/^负责人/});await expect(select.locator('option[value="'+saved.id+'"]')).toHaveJSProperty('disabled',false);await expect(select.locator('option[value="'+saved.id+'"]')).toContainText('API');await select.selectOption(saved.id);await dialog.getByRole('textbox',{name:'群名称',exact:true}).fill('测试 API 负责人群');await dialog.getByRole('button',{name:'创建并启用工作群'}).click();await expect(dialog).toHaveCount(0);
  await expect(page.locator('.wg-room-head')).toContainText('负责人：测试真实 API 成员');await expect(page.locator('.wg-members')).toContainText('API');const rooms=await backend.get('/workgroups?project_id='+project.id);const detail=await backend.get('/workgroups/'+rooms.rooms[0].id);expect(detail.members.find((member:any)=>member.id===detail.room.leader_member_id).agent_id).toBe(saved.id);expect(detail.jobs).toHaveLength(0);
});
