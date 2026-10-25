import {test,expect,type Page} from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {api,shot,EVIDENCE,noHorizontalScroll} from './support.ts';

const paragraphs='第一段：测试正文。\n第二段：保留手动换行。\n\n第三段：保留空行。';
const longGoal=paragraphs+'\n链接：https://example.test/'+ 'abcdefgh'.repeat(60)
  +'\n路径：G:\\测试项目\\'+ 'folder'.repeat(60)+'\\结果.txt\n哈希：'+'abcdef0123456789'.repeat(24)+'\n结束：完整正文。';

async function project(page:Page,goal:string,name='测试段落 '+randomUUID().slice(0,6)){
  const client=await api(page),folder=path.join(client.root,'测试换行-'+randomUUID());
  fs.mkdirSync(folder,{recursive:true});
  const p=await client.post('/projects',{name,path:folder,goal});
  return {...client,project:p};
}

async function paragraphPositions(page:Page){
  return page.locator('.project-goal').evaluate(el=>{
    const text=el.firstChild!;const content=text.textContent!;
    return ['第一段','第二段','第三段'].map(label=>{const start=content.indexOf(label),range=document.createRange();range.setStart(text,start);range.setEnd(text,start+3);return range.getBoundingClientRect().y;});
  });
}

test('项目目标保留 LF/CRLF 换行与空行；编辑保存不丢全文',async({page})=>{
  for(const newline of ['\n','\r\n']){
    const original=paragraphs.replaceAll('\n',newline),m=await project(page,original);
    await page.goto('/#/projects/'+m.project.id);
    const expand=page.getByRole('button',{name:'展开完整说明'});if(await expand.count())await expand.click();
    const ys=await paragraphPositions(page);
    await shot(page,newline==='\n'?'项目段落-LF':'项目段落-CRLF',false);
    expect(ys[1]-ys[0],'手动换行必须使第二段进入下一行').toBeGreaterThan(10);
    expect(ys[2]-ys[1],'空行必须保持额外段落距离').toBeGreaterThan((ys[1]-ys[0])*1.8);
    await page.getByRole('button',{name:'编辑资料',exact:true}).click();
    const dialog=page.getByRole('dialog',{name:'编辑项目资料'});
    // HTML textarea exposes LF; changing a different field must preserve stored CRLF.
    await expect(dialog.getByLabel('项目目标')).toHaveValue(paragraphs);
    await dialog.getByText('项目近况（可选）').click();await dialog.getByLabel('现在处在什么阶段').fill('测试：只修改阶段');
    await dialog.getByRole('button',{name:'保存',exact:true}).click();
    await expect(dialog).toHaveCount(0);
    expect((await m.get('/state')).projects.find((p:any)=>p.id===m.project.id).goal).toBe(original);
    await page.reload();await page.getByRole('button',{name:'编辑资料',exact:true}).click();
    const edited=longGoal+'\n追加段落：完整保存。';
    await dialog.getByLabel('项目目标').fill(edited);
    await dialog.getByRole('button',{name:'保存',exact:true}).click();await expect(dialog).toHaveCount(0);
    await page.reload();
    expect((await m.get('/state')).projects.find((p:any)=>p.id===m.project.id).goal).toBe(edited);
    expect(await page.locator('.project-goal').textContent()).toBe(edited);
  }
});

test('长项目标题/目标/阶段/下一步在深浅主题与宽窄窗口中不溢出，列表仍为两行摘要',async({page})=>{
  test.setTimeout(90000);
  const name='测试长标题-'+ 'LongIdentifier'.repeat(10),m=await project(page,longGoal,name);
  await m.post('/projects/'+m.project.id+'/edit',{version:m.project.version,changes:{name,goal:longGoal,stage:'阶段-'+ 'Stage'.repeat(35),next_step:'下一步：\n'+'https://example.test/'+ 'NextStep'.repeat(70)}});
  const measurements:any[]=[];
  for(const theme of ['light','dark'])for(const [width,height] of [[1684,1118],[1280,720],[880,600],[704,480]]){
    await page.setViewportSize({width,height});await page.goto('/#/projects/'+m.project.id);
    await page.evaluate(t=>localStorage.setItem('wb-theme',t),theme);await page.reload();
    await expect(page.locator('.project-head h1')).toHaveText(name);
    const expand=page.getByRole('button',{name:'展开完整说明'});if(await expand.count())await expand.click();
    const metrics=await page.evaluate(()=>{
      const copy=document.querySelector('.project-head > div:first-child')!,actions=document.querySelector('.project-head .head-actions')!;
      const a=actions.getBoundingClientRect(),c=copy.getBoundingClientRect();
      const buttons=[...actions.querySelectorAll('button')].map(el=>{const r=el.getBoundingClientRect();return {left:r.left,right:r.right,top:r.top,bottom:r.bottom};});
      const overflow:string[]=[];
      for(const el of document.querySelectorAll('.project-head h1,.project-goal,.head-facts > span')){
        const walker=document.createTreeWalker(el,NodeFilter.SHOW_TEXT);let node:Node|null;
        while((node=walker.nextNode())){if(!node.textContent?.trim())continue;const range=document.createRange();range.selectNodeContents(node);for(const rect of range.getClientRects())if(rect.right>innerWidth+1||rect.left< -1)overflow.push(node.textContent.slice(0,24));}
      }
      return {viewport:innerWidth,scrollWidth:document.documentElement.scrollWidth,overflow,buttons,copyActionsOverlap:Math.min(a.right,c.right)-Math.max(a.left,c.left)>1&&Math.min(a.bottom,c.bottom)-Math.max(a.top,c.top)>1};
    });
    measurements.push({theme,width,height,...metrics});
    if(process.env.WORKBENCH_CAPTURE_SHOTS==='1'){fs.mkdirSync(EVIDENCE,{recursive:true});fs.writeFileSync(path.join(EVIDENCE,'project-text-layout.json'),JSON.stringify(measurements,null,2));}
    await shot(page,`项目长文本-${theme}-${width}`,false);
    expect(await noHorizontalScroll(page),`${theme}/${width} 页面不得横向滚动`).toBe(true);
    expect(metrics.overflow).toEqual([]);expect(metrics.copyActionsOverlap).toBe(false);
    for(const b of metrics.buttons){expect(b.left).toBeGreaterThanOrEqual(0);expect(b.right).toBeLessThanOrEqual(width+1);}
    for(let i=0;i<metrics.buttons.length;i++)for(let j=i+1;j<metrics.buttons.length;j++){
      const a=metrics.buttons[i],b=metrics.buttons[j];expect(Math.min(a.right,b.right)-Math.max(a.left,b.left)>1&&Math.min(a.bottom,b.bottom)-Math.max(a.top,b.top)>1).toBe(false);
    }
    await page.getByRole('button',{name:'编辑资料',exact:true}).click();await expect(page.getByRole('dialog',{name:'编辑项目资料'})).toBeVisible();await page.keyboard.press('Escape');
    await page.locator('.more-menu > summary').click();await page.getByRole('button',{name:'归档项目',exact:true}).click();await expect(page.getByRole('dialog',{name:'归档项目'})).toBeVisible();await page.keyboard.press('Escape');
    await page.locator('.head-actions').getByRole('button',{name:'提需求',exact:true}).click();await expect(page.getByRole('dialog')).toBeVisible();await page.keyboard.press('Escape');
    await page.getByRole('tab',{name:'资料与设置',exact:true}).click();await expect(page.locator('.project-head h1')).toBeVisible();
    await page.goto('/#/projects');await page.getByRole('textbox',{name:'搜索项目'}).fill(name);
    const card=page.locator('.project-card').filter({hasText:name});await expect(card).toHaveCount(1);
    expect(await noHorizontalScroll(page),`${theme}/${width} 项目列表不得横向滚动`).toBe(true);
    const summary=await card.locator('.pc-goal').evaluate(el=>({height:el.getBoundingClientRect().height,lineHeight:parseFloat(getComputedStyle(el).lineHeight),text:el.textContent}));
    expect(summary.text).toBe(longGoal);expect(summary.height).toBeLessThanOrEqual(summary.lineHeight*2+1);
  }
});

test('短目标与空目标保持原有显示，项目列表和其他页面无横向回退',async({page})=>{
  for(const goal of ['', '测试短目标']){const m=await project(page,goal);await page.goto('/#/projects/'+m.project.id);await expect(page.locator('.project-goal')).toHaveText(goal||'还没写项目目标');expect(await noHorizontalScroll(page)).toBe(true);}
  for(const route of ['projects','requests','settings']){await page.goto('/#/'+route);await expect(page.getByRole('heading',{level:1})).toBeVisible();expect(await noHorizontalScroll(page)).toBe(true);}
});
