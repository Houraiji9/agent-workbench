import {test,expect} from '@playwright/test';import fs from 'node:fs';import path from 'node:path';import crypto from 'node:crypto';import {makeTask,drawer,api,EVIDENCE} from './support.ts';
const out=EVIDENCE;
fs.mkdirSync(out,{recursive:true});
test('复核 Grok CSP 疑点：HTML 预览内容真实显示且只收到一条预览策略',async({page})=>{
 const m=await makeTask(page,{title:'CSP隔离测试',stage:'running'});const file=path.join(m.root,'audit.html');fs.writeFileSync(file,'<!doctype html><h1>隔离HTML内容实际可见</h1><script>parent.document.title="不应该执行"</script>');await m.report('submitted',{artifacts:[{path:file,label:'audit.html'}]});
 await page.goto('/#/today?task='+m.tid);const response=page.waitForResponse(r=>/\/api\/artifacts\/.*\/content$/.test(r.url()));await drawer(page).getByRole('button',{name:/audit.html/}).click();
 const r=await response;const headers=(await r.headersArray()).filter(h=>h.name.toLowerCase()==='content-security-policy');
 fs.writeFileSync(out+'/html-preview-csp.json',JSON.stringify(headers,null,2));expect(headers).toHaveLength(1);expect(headers[0].value).toContain("frame-ancestors 'self'");
 await expect(page.frameLocator('iframe[title="audit.html"]').getByRole('heading',{name:'隔离HTML内容实际可见'})).toBeVisible();expect(await page.title()).not.toBe('不应该执行');
});
test('复核 Grok CSP 疑点：Archify 图解在框内实际出现',async({page})=>{
 const m=await makeTask(page,{title:'图解内容可见核对'});await page.goto('/#/projects/'+m.project.id+'?tab=diagrams');
 const response=page.waitForResponse(r=>/\/api\/diagrams\/.*\/content$/.test(r.url()));await page.getByRole('button',{name:'生成项目总览'}).click();
 const r=await response;const headers=(await r.headersArray()).filter(h=>h.name.toLowerCase()==='content-security-policy');fs.writeFileSync(out+'/diagram-preview-csp.json',JSON.stringify(headers,null,2));expect(headers).toHaveLength(1);
 const viewer=page.getByRole('dialog',{name:/项目总览/});await expect(viewer.locator('iframe').contentFrame().getByRole('heading',{level:1,name:/项目总览/})).toBeVisible();
 await page.screenshot({path:out+'/图解内容实测-隔离环境.png',fullPage:true});
});
test('新建项目的一键授权应只授权所选新目录',async({page})=>{
 const parent=path.join(process.cwd(),'.test-tmp','独立授权父级-'+crypto.randomUUID()),child=path.join(parent,'新项目');fs.mkdirSync(parent,{recursive:true});
 const helper=await api(page);await page.goto('/#/projects');await page.getByRole('button',{name:'添加项目',exact:true}).click();
 const d=page.getByRole('dialog',{name:'添加项目'});await d.getByRole('radio',{name:'新建文件夹'}).click();await d.getByLabel('项目名称',{exact:true}).fill('隔离授权路径核对');await d.getByLabel('新文件夹的完整路径').fill(child);await d.getByRole('button',{name:'新建并登记'}).click();await d.getByRole('button',{name:'授权这个文件夹并登记'}).click();await expect(d).toHaveCount(0);
 const state=await helper.get('/state');fs.writeFileSync(out+'/create-parent-authorization.json',JSON.stringify({selected:child,actualAuthorizedParent:state.authorized_roots.includes(parent),actualAuthorizedChild:state.authorized_roots.includes(child)},null,2));expect(state.authorized_roots).toContain(child);expect(state.authorized_roots).not.toContain(parent);
});
