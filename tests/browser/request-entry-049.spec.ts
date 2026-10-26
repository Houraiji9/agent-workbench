import {test,expect,type Page} from '@playwright/test';import {randomUUID} from 'node:crypto';
import {api,shot,noHorizontalScroll} from './support.ts';
async function project(page:Page,label:string){const a=await api(page);return a.post('/projects',{name:'测试049 '+label+' '+randomUUID().slice(0,6),path:a.root+'/project-'+randomUUID(),create:true})}
const form=(page:Page)=>page.getByRole('dialog',{name:'提一个需求',exact:true});
async function open(page:Page){await page.getByRole('banner').getByRole('button',{name:'提需求',exact:true}).click();await expect(form(page)).toBeVisible();return form(page)}
test('最近访问优先于新建项目，刷新保留；收纳和归档不出现在提需求选择中',async({page})=>{
 const a=await api(page),used=await project(page,'常用'),newer=await project(page,'刚新建'),shelved=await project(page,'已收纳'),archived=await project(page,'已归档');
 await a.post('/projects/'+shelved.id+'/hold',{version:shelved.version,shelved:true});await a.post('/projects/'+archived.id+'/archive',{version:archived.version,archived:true});
 await page.goto('/#/projects/'+used.id);await expect(page.getByRole('heading',{name:used.name,exact:true})).toBeVisible();
 await page.getByRole('navigation').getByRole('button',{name:'今天',exact:true}).click();await page.reload();let d=await open(page);
 await expect(d.getByRole('combobox',{name:'属于哪个项目'})).toContainText(used.name);await d.getByRole('combobox',{name:'属于哪个项目'}).click();
 const options=page.getByRole('listbox',{name:'项目选项'});await expect(options).not.toContainText(shelved.name);await expect(options).not.toContainText(archived.name);await expect(options).toContainText(newer.name);
 await options.getByRole('option').filter({hasText:newer.name}).click();await d.getByRole('button',{name:'取消',exact:true}).click();await page.reload();d=await open(page);await expect(d.getByRole('combobox',{name:'属于哪个项目'})).toContainText(newer.name);
 await shot(page,'049-最近项目与简表单');
});
test('描述一次即可保存，主要选择直接可见，默认交大脑安排不会冒充用户指定交付',async({page})=>{
 const p=await project(page,'轻需求'),a=await api(page);await page.goto('/#/projects/'+p.id);const d=await open(page);
 for(const label of ['需求重要程度','交给谁规划','成果与使用位置','交付后的审查'])await expect(d.getByLabel(label)).toBeVisible();
 expect(await d.locator('textarea').count()).toBe(1);await expect(d.getByLabel('成果与使用位置')).toHaveValue('planner');
 const text='测试049 整理线上服务配置 '+randomUUID();await d.getByLabel('你想完成什么？').fill(text);await d.getByRole('button',{name:'先记下来',exact:true}).click();
 const q=(await a.get('/state')).requests.find((q:any)=>q.text===text);expect(q.project_id).toBe(p.id);expect(q.planning_preferences.delivery).toBe('planner');expect(q.importance_source).toBe('project_default');expect(q.delivery_profile_source).toBe('planner_requested');
 await page.getByRole('article',{name:text,exact:true}).getByRole('button',{name:'现在开始',exact:true}).click();const entry=await a.get('/requests/'+q.id+'/entry');expect(entry.text).toContain('planner');expect(entry.text).toContain('当前项目历史事实摘要');expect(entry.text).toContain(p.id);
});
test('沿用项目和显式修改分开记录，旧补充文字可见可编辑',async({page})=>{
 const p=await project(page,'线上'),a=await api(page),profile={schema:1,artifacts:['source','service'],artifact_description:'线上成品',deployment:{mode:'remote',target:'合成服务器',deploy:'安装新版',health:'检查状态',rollback:'恢复旧版',verification:'executor_reported'}};
 await a.post('/projects/'+p.id+'/edit',{version:p.version,changes:{delivery_profile:profile}});await page.goto('/#/projects/'+p.id);let d=await open(page);
 await expect(d.getByLabel('成果与使用位置')).toHaveValue('project');await expect(d).toContainText('合成服务器');await d.getByLabel('你想完成什么？').fill('测试049 沿用线上设置 '+p.id);await d.getByRole('button',{name:'先记下来',exact:true}).click();
 const state=await a.get('/state'),q=state.requests.find((q:any)=>q.text==='测试049 沿用线上设置 '+p.id);expect(q.delivery_profile_source).toBe('project_default');
 const old=await a.post('/requests',{project_id:p.id,text:'测试049 旧需求 '+p.id,status:'draft',desired_output:'原本的交付说明',success_criteria:'原本的完成标准',delivery_profile:profile});
 await page.reload();await page.getByRole('article',{name:old.text,exact:true}).getByRole('button',{name:'继续编辑',exact:true}).click();const edit=page.getByRole('dialog',{name:'编辑需求',exact:true});
 await expect(edit.getByLabel('此前填写的期望结果')).toHaveValue('原本的交付说明');await expect(edit.getByLabel('此前填写的完成标准')).toHaveValue('原本的完成标准');await expect(edit.getByLabel('成果与使用位置')).toHaveValue('custom');
 await edit.getByLabel('使用位置补充说明（可选）').fill('第二合成服务器');await edit.getByRole('button',{name:'保存，稍后再做',exact:true}).click();const changed=(await a.get('/state')).requests.find((q:any)=>q.id===old.id);expect(changed.delivery_profile_source).toBe('user_selected');expect(changed.delivery_profile.deployment.target).toBe('第二合成服务器');expect(changed.success_criteria).toBe(old.success_criteria);
});
test('短窗口提交按钮常驻、字段可用键盘修改，旧版本保存不覆盖新内容',async({page})=>{
 const p=await project(page,'短窗'),a=await api(page),q=await a.post('/requests',{project_id:p.id,text:'测试049 并发需求 '+p.id,status:'draft'});await page.setViewportSize({width:480,height:650});await page.goto('/#/requests');await page.getByRole('article',{name:q.text,exact:true}).getByRole('button',{name:'继续编辑',exact:true}).click();const d=page.getByRole('dialog',{name:'编辑需求',exact:true});
 await d.getByLabel('成果与使用位置').selectOption('custom');await d.getByLabel('交付后在哪里使用').selectOption('remote');await d.getByLabel('使用位置补充说明（可选）').fill('合成位置');await d.getByLabel('你想完成什么？').fill('不应覆盖的新输入');
 await expect(d.locator(':scope > footer').getByRole('button',{name:'现在开始',exact:true})).toBeInViewport();expect(await noHorizontalScroll(page)).toBe(true);await shot(page,'049-短窗需求固定操作',false);
 await a.post('/requests/'+q.id+'/edit',{project_id:p.id,text:'另一会话已保存',status:'draft',version:q.version});await d.getByRole('button',{name:'保存，稍后再做',exact:true}).click();await expect(d.getByRole('alert')).toContainText('需求已更新');expect((await a.get('/state')).requests.find((x:any)=>x.id===q.id).text).toBe('另一会话已保存');
 await d.getByLabel('交给谁规划').focus();await page.keyboard.press('ArrowDown');await page.keyboard.press('Escape');await expect(d).toHaveCount(0);
});
test('GPT聊天复制含有限项目摘要和来源，剪贴板拒绝仍能手动取到全文',async({page})=>{
 const p=await project(page,'聊天'),a=await api(page);await page.goto('/#/projects/'+p.id);const d=await open(page);await d.getByLabel('你想完成什么？').fill('测试049 在现有项目继续优化');await d.getByLabel('交给谁规划').selectOption('small');await d.getByRole('button',{name:'现在开始',exact:true}).click();const chat=page.getByRole('dialog',{name:'在 GPT 聊天里规划'});await expect(chat).toBeVisible();await chat.getByRole('button',{name:'复制给 GPT',exact:true}).click();
 await expect.poll(()=>page.evaluate(()=>navigator.clipboard.readText())).toContain('project_summary');let text=await page.evaluate(()=>navigator.clipboard.readText());const data=JSON.parse(text.slice(text.indexOf('{')));expect(data.project_summary.project_id).toBe(p.id);expect(data.project_summary.as_of).toBeTruthy();expect(JSON.stringify(data.project_summary).length).toBeLessThanOrEqual(16000);expect(data.request.planning_preferences.delivery).toBe('planner');
 await page.evaluate(()=>Object.defineProperty(navigator.clipboard,'writeText',{configurable:true,value:()=>Promise.reject(new Error('测试拒绝'))}));await chat.getByRole('button',{name:'复制给 GPT',exact:true}).click();await expect(chat.getByRole('textbox',{name:'手动复制给 GPT'})).toHaveValue(/project_summary/);
});
