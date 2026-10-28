import {test,expect,type Page,type Locator} from '@playwright/test';
import {randomUUID} from 'node:crypto';
import {api,noHorizontalScroll,shot} from './support.ts';

async function setup(page:Page){
  const a=await api(page),token=randomUUID().slice(0,6);
  const project=await a.post('/projects',{name:'测试预选 '+token,path:a.root+'/selection-'+token,create:true});
  await page.goto('/#/projects/'+project.id);
  await page.getByRole('banner').getByRole('button',{name:'提需求',exact:true}).click();
  const dialog=page.getByRole('dialog',{name:'提一个需求',exact:true});await expect(dialog).toBeVisible();
  return {a,project,dialog,token};
}
async function chooseProject(page:Page,dialog:Locator,name:string){
  await dialog.getByRole('combobox',{name:'属于哪个项目'}).click();
  await page.getByRole('listbox',{name:'项目选项'}).getByRole('option').filter({hasText:name}).click();
}

test('需求预选四项默认留空，保存后编辑保留自定义模型与Agent',async({page})=>{
  const {a,dialog,token}=await setup(page);
  for(const label of ['执行者（可选）','执行模型（可选）','审查者（可选）','审查模型（可选）'])await expect(dialog.getByLabel(label,{exact:true})).toHaveValue('');
  await expect(dialog.getByLabel('执行供应商（可选）')).toHaveCount(0);
  await dialog.getByLabel('执行者（可选）',{exact:true}).selectOption('codex');
  await dialog.getByLabel('执行模型（可选）',{exact:true}).fill('custom-execution-'+token);
  await dialog.getByLabel('审查者（可选）',{exact:true}).selectOption('grok-build');
  await dialog.getByLabel('审查模型（可选）',{exact:true}).fill('custom-review-'+token);
  const text='测试四项预选 '+token;await dialog.getByLabel('你想完成什么？').fill(text);
  await dialog.getByRole('button',{name:'先记下来',exact:true}).click();
  const card=page.getByRole('article',{name:text,exact:true});await expect(card).toBeVisible();
  const q=(await a.get('/state')).requests.find((q:any)=>q.text===text);
  expect(q.agent_selection).toEqual({execution:{agent_id:'codex',model:'custom-execution-'+token},review:{agent_id:'grok-build',model:'custom-review-'+token}});
  await card.getByRole('button',{name:'继续编辑',exact:true}).click();const edit=page.getByRole('dialog',{name:'编辑需求',exact:true});
  await expect(edit.getByLabel('执行者（可选）',{exact:true})).toHaveValue('codex');await expect(edit.getByLabel('执行模型（可选）',{exact:true})).toHaveValue('custom-execution-'+token);
  await expect(edit.getByLabel('审查者（可选）',{exact:true})).toHaveValue('grok-build');await expect(edit.getByLabel('审查模型（可选）',{exact:true})).toHaveValue('custom-review-'+token);
});

test('模型可先填，每项目草稿独立，空选择提交由大脑安排',async({page})=>{
  const {a,project,dialog,token}=await setup(page);
  const other=await a.post('/projects',{name:'测试另一个预选项目 '+token,path:a.root+'/other-selection-'+token,create:true});
  await dialog.getByLabel('执行模型（可选）',{exact:true}).fill('model-before-agent');
  await dialog.getByLabel('审查模型（可选）',{exact:true}).fill('review-before-agent');
  // Refresh the live snapshot after creating the second project without closing the form.
  await expect.poll(()=>dialog.getByRole('combobox',{name:'属于哪个项目'}).isVisible()).toBe(true);
  await chooseProject(page,dialog,other.name);
  for(const label of ['执行模型（可选）','审查模型（可选）'])await expect(dialog.getByLabel(label,{exact:true})).toHaveValue('');
  await chooseProject(page,dialog,project.name);
  await expect(dialog.getByLabel('执行模型（可选）',{exact:true})).toHaveValue('model-before-agent');
  await expect(dialog.getByLabel('审查模型（可选）',{exact:true})).toHaveValue('review-before-agent');
  const text='测试模型先填 '+token;await dialog.getByLabel('你想完成什么？').fill(text);await dialog.getByRole('button',{name:'先记下来',exact:true}).click();
  await expect(page.getByRole('article',{name:text,exact:true})).toBeVisible();
  expect((await a.get('/state')).requests.find((q:any)=>q.text===text).agent_selection).toEqual({execution:{model:'model-before-agent'},review:{model:'review-before-agent'}});
  await page.getByRole('banner').getByRole('button',{name:'提需求',exact:true}).click();const fresh=page.getByRole('dialog',{name:'提一个需求',exact:true});
  const empty='测试全部留空 '+token;await fresh.getByLabel('你想完成什么？').fill(empty);await fresh.getByRole('button',{name:'先记下来',exact:true}).click();
  await expect(page.getByRole('article',{name:empty,exact:true})).toBeVisible();expect((await a.get('/state')).requests.find((q:any)=>q.text===empty).agent_selection).toEqual({});
});

test('更换Agent清空模型和供应商，关闭审查清空预选且窄屏可操作',async({page})=>{
  const {a,dialog,token}=await setup(page);
  await dialog.getByLabel('执行者（可选）',{exact:true}).selectOption('deepseek');
  await dialog.getByLabel('执行模型（可选）',{exact:true}).fill('harness-model');await dialog.getByLabel('执行供应商（可选）',{exact:true}).fill('my-provider');
  await dialog.getByLabel('执行者（可选）',{exact:true}).selectOption('zcode');await expect(dialog.getByLabel('执行模型（可选）',{exact:true})).toHaveValue('');await expect(dialog.getByLabel('执行供应商（可选）',{exact:true})).toHaveValue('');
  await dialog.getByLabel('执行模型（可选）',{exact:true}).fill('new-harness-model');await dialog.getByLabel('执行供应商（可选）',{exact:true}).fill('chosen-provider');
  await dialog.getByLabel('审查者（可选）',{exact:true}).selectOption('grok-build');await dialog.getByLabel('审查模型（可选）',{exact:true}).fill('discarded-review-model');
  await dialog.getByLabel('交付后的审查').selectOption('not_requested');await expect(dialog.getByLabel('审查者（可选）',{exact:true})).toHaveCount(0);await expect(dialog.getByLabel('审查模型（可选）',{exact:true})).toHaveCount(0);
  await dialog.getByLabel('交付后的审查').selectOption('required');await expect(dialog.getByLabel('审查者（可选）',{exact:true})).toHaveValue('');await expect(dialog.getByLabel('审查模型（可选）',{exact:true})).toHaveValue('');
  await dialog.getByLabel('交付后的审查').selectOption('not_requested');
  await page.setViewportSize({width:390,height:600});await dialog.getByLabel('执行供应商（可选）',{exact:true}).scrollIntoViewIfNeeded();
  expect(await noHorizontalScroll(page)).toBe(true);expect(await dialog.evaluate(e=>e.scrollWidth<=e.clientWidth+1)).toBe(true);await shot(page,'需求预选-窄屏',false);
  const text='测试Harness预选 '+token;await dialog.getByLabel('你想完成什么？').fill(text);await dialog.getByRole('button',{name:'先记下来',exact:true}).click();await expect(page.getByRole('article',{name:text,exact:true})).toBeVisible();
  const q=(await a.get('/state')).requests.find((q:any)=>q.text===text);expect(q.agent_selection.execution).toEqual({agent_id:'zcode',model:'new-harness-model',provider:'chosen-provider'});expect(Object.values(q.agent_selection.review||{})).toHaveLength(0);
});
