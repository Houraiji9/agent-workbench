import test from 'node:test';import assert from 'node:assert/strict';
import {requestProjects,defaultRequestProject,readRecentProjects} from '../src/shared/request-projects.ts';
test('recent project uses visits and request activity, ignores creation/metadata, filters shelved and archived',()=>{
 const projects=[{id:'new',name:'新建',created_at:'2099-01-01',updated_at:'2099-01-01'},{id:'old',name:'常用'},{id:'hidden',name:'收纳',shelved:true},{id:'archived',name:'归档',archived:true}];
 const rows=requestProjects(projects,[{project_id:'new',updated_at:'2026-01-01'},{project_id:'old',updated_at:'2026-02-01'},{project_id:'hidden',updated_at:'2099-01-01'}],{});
 assert.deepEqual(rows.map(p=>p.id),['old','new']);assert.deepEqual(requestProjects(projects,[],{old:'2026-02-01',hidden:'2026-03-01'}).map(p=>p.id),['old','new']);
 assert.equal(defaultRequestProject(rows,undefined,{page:'projects',id:'new'}),'new');
 assert.equal(defaultRequestProject(rows,'hidden',{page:'projects',id:'archived'}),'old');
 assert.equal(defaultRequestProject(rows,undefined,{page:'today',task:'task'},[{id:'task',project_id:'new'}]),'new');
 assert.equal(defaultRequestProject([]),'');
});
test('recent storage tolerates invalid values and keeps only bounded newest entries',()=>{
 assert.deepEqual(readRecentProjects('broken'),{});assert.deepEqual(readRecentProjects('[]'),{});
 assert.deepEqual(readRecentProjects('{"a":null,"b":"bad","c":"2026-01-01"}'),{c:'2026-01-01'});
 assert.equal(Object.keys(readRecentProjects(JSON.stringify(Object.fromEntries(Array.from({length:80},(_,i)=>['p'+i,new Date(i*1000).toISOString()]))))).length,50);
});
