import {test,expect} from '@playwright/test';
const session={id:'audit',kind:'session',title:'隔离分页会话',native_id:'audit-native',agent:'codex',sources:[],association:'pending_confirmation'};
test('会话第二页可读时，第一页仍可回看',async({page})=>{
 await page.route('**/api/history?*',r=>r.fulfill({json:{items:[session]}}));
 await page.route('**/api/sessions/audit/messages?*',r=>{const first=new URL(r.request().url()).searchParams.get('from')==='0';return r.fulfill({json:{messages:[{ordinal:first?0:1,role:'assistant',content:first?'第一页需要保留的正文':'第二页的新正文'}],next_from:first?1:null}})});
 await page.goto('/#/records');await page.getByRole('button',{name:/隔离分页会话/}).click();
 const d=page.getByRole('dialog',{name:'隔离分页会话'});
 await d.getByRole('button',{name:'读取第一页正文'}).click();await expect(d.getByText('第一页需要保留的正文')).toBeVisible();
 await d.getByRole('button',{name:'读取下一页正文'}).click();await expect(d.getByText('第二页的新正文')).toBeVisible();
 await d.getByRole('button',{name:'读取上一页正文'}).click();
 await expect(d.getByText('第一页需要保留的正文')).toBeVisible();
});
test('新查询失败后，不应将旧查询的结果继续当作当前结果',async({page})=>{
 await page.route('**/api/history?*',r=>new URL(r.request().url()).searchParams.get('query')==='新查询' ?r.fulfill({status:503,json:{error:'隔离测试：检索暂时不可用'}}):r.fulfill({json:{items:[session]}}));
 await page.goto('/#/records');await expect(page.getByRole('button',{name:/隔离分页会话/})).toBeVisible();
 await page.getByLabel('搜索记录').fill('新查询');await expect(page.getByRole('alert')).toContainText('检索暂时不可用');
 await expect(page.getByRole('button',{name:/隔离分页会话/})).toHaveCount(0);
});
test('中文组合输入期间的 Enter 不应执行快速跳转',async({page})=>{
 await page.goto('/');await page.getByRole('heading',{level:1}).waitFor();await page.keyboard.press('Control+k');
 const d=page.getByRole('dialog',{name:'快速跳转'}),input=d.getByRole('textbox');
 await input.fill('项目');await input.dispatchEvent('compositionstart',{data:'项目'});
 await input.dispatchEvent('keydown',{key:'Enter',code:'Enter',keyCode:229,isComposing:true,bubbles:true});
 await expect(d).toBeVisible();
});
