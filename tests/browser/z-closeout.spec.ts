import {test,expect} from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {api,makeTask,drawer,shot,noHorizontalScroll,completeCloseout} from './support.ts';

test('用户免审任务交付后显示继续收尾，不等待审查结果',async({page})=>{
  const m=await makeTask(page,{title:'测试：用户免审任务继续收尾',skipReview:true,stage:'submitted'});
  await page.goto('/#/today?task='+m.tid);
  await expect(drawer(page).getByText('Codex 交付后继续完成剩余事项',{exact:true})).toBeVisible();
  await expect(drawer(page)).not.toContainText('收到审查结果后');
  await expect(drawer(page).getByRole('button',{name:'试用后确认完成'})).toHaveCount(0);
  await shot(page,'免审-交付后继续收尾');
  await completeCloseout(m);await expect(drawer(page).getByRole('button',{name:'试用后确认完成'})).toBeVisible();
});

test('审查交接卡显示当前审查者图标，改派同步，审查通过收尾时交回执行者',async({page})=>{
  const m=await makeTask(page,{title:'测试：交给 Claude 审查的卡片图标',stage:'submitted'}),boot=await api(page);
  const assign=async(reviewer_id:string)=>{const d=await m.get('/tasks/'+m.tid);return m.post('/review-orders',{run_id:m.rid,reviewer_id,expected_revision:d.task.revision,reason:'隔离测试当前交接对象与图标',delivery_mode:'manual'})};
  await assign('claude');await page.goto('/#/today');
  const card=page.getByRole('region',{name:'轮到你了'}).getByRole('article',{name:m.title});
  const expectIcon=async(img:any,file:string)=>{
    // Vite inlines small icons and normalizes SVG attribute quotes.
    const digest=(bytes:Buffer)=>createHash('sha256').update(file.endsWith('.svg')?bytes.toString('utf8').replaceAll("'",'"').trim():bytes).digest('hex');
    const expected=digest(fs.readFileSync(path.join('src/web/assets/agents',file)));
    await expect.poll(async()=>{const src=await img.getAttribute('src');if(!src)return null;const response=await fetch(new URL(src,'http://127.0.0.1:14318').href);return digest(Buffer.from(await response.arrayBuffer()))}).toBe(expected);
  };
  await expect(card.locator('.turn-agent')).toHaveAttribute('title','审查：Claude');
  await expect(card.locator('.turn-agent-role')).toHaveText('审查');
  await expectIcon(card.locator('.turn-agent img'),'claude.svg');
  await expect.poll(()=>card.locator('.turn-agent img').evaluate((img:HTMLImageElement)=>img.complete&&img.naturalWidth>0)).toBe(true);
  await expect(card.getByRole('button',{name:'交给审查者'})).toBeVisible();
  for(const width of [1440,900]){await page.setViewportSize({width,height:900});expect(await noHorizontalScroll(page)).toBe(true);await shot(page,'审查交接-Claude图标-'+width,false)}
  await card.locator('.turn-title').click();await expect(drawer(page).locator('.task-people')).toContainText('执行：Codex');await page.goto('/#/today');
  await assign('zcode');await expect(card.locator('.turn-agent')).toHaveAttribute('title','审查：Zcode');await expectIcon(card.locator('.turn-agent img'),'zcode.png');
  const order=await assign('claude');await expect(card.locator('.turn-agent')).toHaveAttribute('title','审查：Claude');
  const token=JSON.parse(fs.readFileSync(path.join(boot.root,'data/review-keys',order.review_id+'.json'),'utf8')).token;
  const review=async(name:string,body:any)=>{const r=await fetch('http://127.0.0.1:14318/api/mcp/'+name,{method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:JSON.stringify(body)});expect(r.ok).toBe(true);return r.json()};
  await review('report_review_started',{review_id:order.review_id,identity:'claude'});
  const active=page.getByRole('region',{name:'正在由 Agent 处理'}).locator('.active-task').filter({has:page.getByText(m.title,{exact:true})});
  await expectIcon(active.locator('.agent-icon img'),'claude.svg');
  await review('submit_review_result',{...order.context.final_response,review_id:order.review_id,verdict:'passed',findings:[],limitations:['隔离测试回执'],evidence:['页面图标切换检查'],report_markdown:'隔离测试审查报告，仅用于验证当前交接图标随角色切换。'});
  await expect(card.locator('.turn-agent')).toHaveAttribute('title','执行：Codex');await expectIcon(card.locator('.turn-agent img'),'codex.svg');
  await expect(card.getByRole('button',{name:'交回执行者收尾'})).toBeVisible();
  expect((await m.get('/tasks/'+m.tid)).task.status).toBe('awaiting_closeout');
});

test('审查通过先交回执行者：复制、收尾提问、回报完成后才开放验收',async({page})=>{
  const m=await makeTask(page,{title:'测试：审查后执行者继续收尾',stage:'closeout'});
  await page.goto('/#/today?task='+m.tid);const d=drawer(page);
  await expect(d.getByRole('button',{name:'试用后确认完成'})).toHaveCount(0);
  await d.getByRole('button',{name:'复制收尾单给执行者'}).click();await expect.poll(()=>page.evaluate(()=>navigator.clipboard.readText())).toContain('CLOSEOUT.md');
  let detail=await m.get('/tasks/'+m.tid);expect(detail.task.status).toBe('awaiting_closeout');const co=detail.runs.find((r:any)=>r.id===m.rid).closeout;
  await shot(page,'收尾-待交回执行者');
  await m.report('closeout_started',{closeout_id:co.id});await expect(d.getByText('Codex 正在收尾',{exact:true})).toBeVisible();
  await m.report('closeout_waiting_input',{closeout_id:co.id,message:'这次是先本机试用，还是一起发布？'});
  await d.getByLabel('你的回答').fill('先在本机试用，发布另行安排');await d.getByRole('button',{name:'保存并复制回答'}).click();
  await expect.poll(()=>page.evaluate(()=>navigator.clipboard.readText())).toContain('closeout_started');expect((await m.get('/tasks/'+m.tid)).task.status).toBe('closeout_waiting_input');
  await completeCloseout(m);await expect(d.getByRole('button',{name:'试用后确认完成'})).toBeVisible();await expect(d.getByRole('region',{name:'收尾结果'})).toBeVisible();
  await shot(page,'收尾-完成待用户验收');await page.setViewportSize({width:880,height:650});expect(await noHorizontalScroll(page)).toBe(true);await shot(page,'收尾-窄窗口',false);
  await d.getByRole('button',{name:'试用后确认完成'}).click();const ok=page.getByRole('dialog',{name:'试用后确认完成'});await ok.getByLabel('我能看懂测试结果').check();await ok.getByLabel('结果符合测试需求').check();await ok.getByRole('button',{name:'确认结果符合需求'}).click();await expect(d.getByText('已完成').first()).toBeVisible();
});

test('待手动转发审查单在轮到你了；直接调用待接单显示执行者，接单后显示审查者',async({page})=>{
  const m=await makeTask(page,{title:'测试：审查交接责任人',stage:'submitted'}),boot=await api(page);
  await page.goto('/');const card=page.getByRole('article',{name:m.title});await expect(card.getByRole('button',{name:'交给审查者'})).toBeVisible();
  const t=(await m.get('/tasks/'+m.tid)).task;
  const order=await m.post('/review-orders',{run_id:m.rid,reviewer_id:'claude',expected_revision:t.revision,reason:'测试执行者直接调用 CLI',delivery_mode:'agent'});
  await expect(card.getByRole('button',{name:'交给审查者'})).toHaveCount(0);await expect(page.getByText('Codex 正在安排 Claude 审查',{exact:true})).toBeVisible();
  const key=JSON.parse(fs.readFileSync(path.join(boot.root,'data/review-keys',order.review_id+'.json'),'utf8')).token;
  const start=await fetch('http://127.0.0.1:14318/api/mcp/report_review_started',{method:'POST',headers:{Authorization:'Bearer '+key,'Content-Type':'application/json'},body:JSON.stringify({review_id:order.review_id,identity:'claude'})});expect(start.ok).toBe(true);
  await expect(page.getByText('Claude 正在独立审查',{exact:true})).toBeVisible();await shot(page,'审查-直接调用实际接单');
  const detail=await m.get('/tasks/'+m.tid),token=JSON.parse(fs.readFileSync(path.join(boot.root,'data/run-keys',m.rid+'.json'),'utf8')).token;
  const failed=await fetch('http://127.0.0.1:14318/api/mcp/report_review_handoff',{method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:JSON.stringify({run_id:m.rid,review_id:order.review_id,expected_revision:detail.task.revision,reason:'CLI 登录已失效，请重新选择审查者'})});expect(failed.ok).toBe(true);
  await expect(page.getByRole('article',{name:m.title}).getByRole('button',{name:'交给审查者'})).toBeVisible();await page.goto('/#/today?task='+m.tid);await expect(drawer(page)).toContainText('CLI 登录已失效');await expect(drawer(page).getByRole('button',{name:'更换审查者',exact:true})).toBeVisible();
});
