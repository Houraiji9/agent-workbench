import {test, expect, type Page, type Route} from '@playwright/test';
import {noHorizontalScroll, shot} from './support.ts';

const now = Date.parse('2026-10-23T12:00:00Z');
const stamp = new Date(now).toISOString();
const reset = (days:number) => new Date(now + days * 86_400_000).toISOString();

async function quotaFixture(page:Page) {
  const pools:any[] = [
    {id:'near-rich',name:'测试 · 充足且将重置'},
    {id:'later-rich',name:'测试 · 充足但稍晚重置'},
    {id:'near-small',name:'测试 · 余量较少但更快重置'},
    {id:'low',name:'测试 · 快用完了'},
    {id:'unknown',name:'测试 · 时间未知'},
    {id:'expired',name:'测试 · 等待刷新'},
    {id:'balance',name:'测试 · 余额',provider:'deepseek',balance:{amount:50,currency:'CNY'}},
    {id:'points',name:'测试 · 月度积分',points_editable:true,display_state:'manual'},
    {id:'antigravity',name:'Antigravity',provider:'antigravity',cache_editable:true},
  ].map(p=>({...p,source:'token_monitor',status:'ok',freshness:'fresh',source_updated_at:stamp}));
  const w = (id:string, remaining:number, days:number|null, label='每周', kind='weekly') => ({id,pool_id:id,label,kind,remaining_percent:remaining,resets_at:days===null?null:reset(days),display_state:'live',freshness:'fresh',source_updated_at:stamp});
  const windows:any[] = [w('near-rich',80,1),w('later-rich',80,2),w('near-small',20,.25,'Weekly','billing'),w('low',1,.001),w('unknown',100,null),w('expired',100,-1),
    {...w('points',100,.01,'月度基础积分','custom'),monthly:{allowance:500,remaining:500},remaining:3200},
    {...w('ag-gemini',60,1,'Gemini 每周'),pool_id:'antigravity'},
    {...w('ag-argon',10,.1,'Gemini 4 Argon 每周'),pool_id:'antigravity'},
    {...w('ag-claude',90,3,'Claude / GPT 每周'),pool_id:'antigravity'},
  ];
  // Tall, nearly exhausted card must not jump ahead of weekly usage priority.
  for(let i=0;i<4;i++)windows.push({...w('low-session-'+i,99,.1,'5 小时','session'),pool_id:'low'});
  const patch=async(route:Route)=>{
    const response=await route.fetch(),s=await response.json();
    s.quota_pools=pools;s.quota_windows=windows;
    s.integrations=s.integrations.map((i:any)=>i.id==='tokenMonitor'?{...i,status:'connected',last_success:stamp}:i);
    await route.fulfill({response,json:s});
  };
  await page.clock.install({time:now});
  await page.route('**/api/bootstrap',patch);await page.route('**/api/state',patch);
  await page.goto('/#/resources');
  await expect(page.locator('.quota-rows').first().getByRole('article')).toHaveCount(11);
  return windows;
}

const order=(page:Page)=>page.locator('.quota-rows').first().getByRole('article').evaluateAll(els=>els.map(e=>e.getAttribute('aria-label')));
const leading=['测试 · 充足且将重置 额度','Antigravity · Gemini 额度','测试 · 充足但稍晚重置 额度','Antigravity · Claude / GPT 额度','测试 · 余量较少但更快重置 额度'];

test('周额度按余量和重置时间综合排序，分组独立，缩放及主题切换仍同行对齐',async({page})=>{
  const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));
  await quotaFixture(page);
  for(const width of [2560,1920,1440,900,390]) {
    await page.setViewportSize({width,height:1080});
    await expect.poll(async()=> (await order(page)).slice(0,5)).toEqual(leading);
    await expect.poll(()=>page.locator('.quota-rows').first().evaluate(el=>{
      const cols=getComputedStyle(el).gridTemplateColumns.split(' ').length, boxes=[...el.children].map(c=>c.getBoundingClientRect());
      return boxes.every((b,i)=>{const first=boxes[Math.floor(i/cols)*cols];return Math.abs(b.top-first.top)<1&&Math.abs(b.bottom-first.bottom)<1});
    })).toBe(true);
    expect(await noHorizontalScroll(page)).toBe(true);
    if(width===1440||width===390)await shot(page,'隔离测试-周额度优先-'+width);
  }
  await page.setViewportSize({width:1440,height:1080});
  await page.getByRole('button',{name:'切换到深色外观'}).click();
  await expect.poll(async()=> (await order(page)).slice(0,5)).toEqual(leading);
  await shot(page,'隔离测试-周额度优先-深色');
  expect(errors).toEqual([]);
});

test('新数据重新排序；停留页面跨过重置时间自动退后',async({page})=>{
  const windows=await quotaFixture(page);
  windows.find(w=>w.id==='near-rich').remaining_percent=10;
  await page.reload();
  await expect.poll(async()=> (await order(page))[0]).toBe('Antigravity · Gemini 额度');
  await page.clock.fastForward(86_400_000+60_000);
  await expect.poll(async()=> (await order(page)).slice(0,2)).toEqual(['测试 · 充足但稍晚重置 额度','Antigravity · Claude / GPT 额度']);
  await expect(page.getByRole('article',{name:'Antigravity · Gemini 额度'})).toContainText('重置时间已过，等待刷新');
});
