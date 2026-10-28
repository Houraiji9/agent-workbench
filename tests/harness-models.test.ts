import {test} from 'node:test';
import assert from 'node:assert/strict';
import {harnessModelRoutes,resolveHarnessProvider} from '../src/core/harness-models.ts';
test('Harness 从当前默认与任意自定义模型读取供应商，不泄露配置内容',()=>{
 const routes=harnessModelRoutes([
  {name:'@deepseek-ai/dsh-agent-default-model',config:{provider:'private-vendor',model:'new-model'}},
  {name:'@deepseek-ai/dsh-llm-pi-ai',config:{providers:{'custom-a':{apiKey:'SECRET',baseURL:'https://private.example',models:[{id:'third-party-42'}],modelOverrides:{'future-7':{}}}}}},
  {name:'@deepseek-ai/dsh-llm-pi-ai',disabled:true,config:{providers:{disabled:{models:[{id:'third-party-42'}]}}}},
 ]);
 assert.equal(resolveHarnessProvider('third-party-42',routes),'custom-a');
 assert.equal(resolveHarnessProvider('new-model',routes),'private-vendor');
 assert.equal(resolveHarnessProvider('future-7',routes),'custom-a');
 assert(!JSON.stringify(routes).includes('SECRET'));assert(!JSON.stringify(routes).includes('private.example'));
});
test('同名多供应商与未知模型都不猜测；不按 GLM 或 DeepSeek 前缀路由',()=>{
 assert.throws(()=>resolveHarnessProvider('glm-any',[]),/填写 provider/);
 assert.throws(()=>resolveHarnessProvider('deepseek-any',[]),/填写 provider/);
 assert.throws(()=>resolveHarnessProvider('m',[{provider:'a',model:'m'},{provider:'b',model:'m'}]),/多个供应商/);
 assert.equal(resolveHarnessProvider('m',[{provider:'a',model:'m'},{provider:'a',model:'m'}]),'a');
});
test('动态禁用表达式与非数据配置不被推断为可用模型',()=>{
 assert.deepEqual(harnessModelRoutes(null),[]);
 assert.deepEqual(harnessModelRoutes([{name:'@deepseek-ai/dsh-agent-default-model',disabled:'!ctx',config:{provider:'a',model:'m'}},{name:'@deepseek-ai/dsh-agent-default-model',config:{provider:'a\nsecret',model:'m'}}]),[]);
});
