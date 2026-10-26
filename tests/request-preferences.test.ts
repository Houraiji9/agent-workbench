import test from 'node:test';import assert from 'node:assert/strict';import crypto from 'node:crypto';
import {fixture,taskInput} from './helpers.ts';import {saveRequest} from '../src/core/request-management.ts';
const remote={schema:1,artifacts:['source','service'],artifact_description:'',deployment:{mode:'remote',target:'合成测试服务器',deploy:'安装此版本',health:'合成健康测试',rollback:'恢复旧版',verification:'executor_reported'}};
test('explicit planner delegation releases generic default but requires a complete planned delivery',()=>{
 const {wb,root}=fixture();try{
 const q=wb.request({project_id:'P-workbench',text:'给我更新线上机器人',planning_preferences:{delivery:'planner'}});
 assert.equal(q.importance_source,'project_default');assert.equal(q.delivery_profile_source,'planner_requested');
 const plan={schema_version:1,plan_id:crypto.randomUUID(),request_id:q.id,expected_version:q.version,tasks:[taskInput(root)]};
 assert.throws(()=>wb.submitPlan(plan),/填写完整成果/);
 const accepted=wb.submitPlan({...plan,tasks:[{...taskInput(root),delivery_profile:remote}]});
 assert.equal(wb.get('tasks',accepted.task_ids[0]).delivery_profile.deployment.mode,'remote');
 }finally{wb.close()}
});
test('explicit/custom and inherited project delivery remain binding; edit history preserves choices',()=>{
 const {wb,root}=fixture();try{
 const q=wb.request({project_id:'P-workbench',text:'指定线上成果',delivery_profile:remote});
 assert.equal(q.delivery_profile_source,'user_selected');assert.equal(q.planning_preferences.delivery,'custom');
 const changed=saveRequest(wb,q.id,{version:q.version,project_id:q.project_id,text:'改为大脑建议',planning_preferences:{delivery:'planner'}});
 assert.equal(changed.history[0].delivery_profile_source,'user_selected');assert.deepEqual(changed.history[0].delivery_profile,remote);
 const p=wb.get('projects',q.project_id);wb.put('projects',{...p,delivery_profile:remote});
 const inherited=wb.request({project_id:p.id,text:'沿用项目的线上交付',planning_preferences:{delivery:'project'}});
 assert.equal(inherited.delivery_profile_source,'project_default');
 assert.throws(()=>wb.submitPlan({schema_version:1,plan_id:crypto.randomUUID(),request_id:inherited.id,expected_version:1,tasks:[{...taskInput(root),delivery_profile:{...remote,artifacts:['document']}}]}),/不能静默改变/);
 assert.throws(()=>wb.request({project_id:p.id,text:'矛盾选择',planning_preferences:{delivery:'planner'},delivery_profile:remote}),/不要同时提交/);
 }finally{wb.close()}
});
test('moving a request does not carry the old project defaults and shelved projects cannot receive new requests',()=>{
 const {wb,root}=fixture();try{
 const old=wb.get('projects','P-workbench');wb.put('projects',{...old,delivery_profile:remote,importance:'critical'});
 const q=wb.request({project_id:old.id,text:'原项目需求',planning_preferences:{delivery:'project'}});
 const p=wb.registerProject({name:'另一个合成项目',path:root+'/other',create:true});
 const moved=saveRequest(wb,q.id,{version:q.version,project_id:p.id,text:q.text});
 assert.equal(moved.importance,'normal');assert.equal(moved.importance_source,'project_default');assert.equal(moved.delivery_profile.deployment.mode,'none');assert.equal(moved.planning_preferences,null);
 wb.put('projects',{...p,shelved:true});assert.throws(()=>wb.request({project_id:p.id,text:'不应送入已收纳项目'}),/已收纳/);
 }finally{wb.close()}
});
