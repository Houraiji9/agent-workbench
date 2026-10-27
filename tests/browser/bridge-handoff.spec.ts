import {test,expect} from '@playwright/test';
import {randomUUID} from 'node:crypto';
import {api,shot} from './support.ts';
import {taskInput} from '../helpers.ts';

test('任务抽屉展示方案、成果地址和按角色资料，长路径可换行',async({page})=>{
 const a=await api(page),p=await a.post('/projects',{name:'方案交接测试',path:a.root+'/handoff-'+randomUUID(),create:true});
 const q=await a.post('/requests',{project_id:p.id,text:'测试：只改搜索按钮'});
 const contract={plan:{content:'本轮只改搜索按钮，沿用已有接口。',path:'docs/search-plan.md'},required:[{path:'src/Search.tsx',roles:['executor']}],supplemental:[{path:'src/search-api.ts',roles:['reviewer'],reason:'仅当请求参数变化时补读'}],output_dir:p.paths[0]+'/output/search',review_focus:['按钮交互和请求参数']};
 const planned=await a.post('/plans',{schema_version:1,plan_id:randomUUID(),request_id:q.id,expected_version:1,tasks:[{...taskInput(p.paths[0]),context_contract:contract}]});
 await page.goto('/#/today?task='+planned.task_ids[0]);
 const section=page.getByRole('region',{name:'方案与交接'});await expect(section).toBeVisible();await expect(section).toContainText('docs/search-plan.md');await expect(section).toContainText('/output/search');
 await section.getByText('查看方案内容',{exact:true}).click();await expect(section).toContainText('本轮只改搜索按钮');await section.getByText('按需资料',{exact:true}).click();await expect(section).toContainText('仅当请求参数变化时补读');
 await page.setViewportSize({width:900,height:750});expect(await section.evaluate(e=>e.scrollWidth<=e.clientWidth+1)).toBeTruthy();await section.scrollIntoViewIfNeeded();await shot(page,'0413-方案与按需交接');
});
