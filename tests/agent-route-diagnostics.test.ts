import {test} from 'node:test';
import assert from 'node:assert/strict';
import {harnessAdapterEvidence} from '../src/core/harness-models.ts';
import {staticRouteDiagnostics,effectiveRouteView,classifyReviewInterruption} from '../src/core/agent-route-diagnostics.ts';
import {parseAgentOutput} from '../src/core/agent-output.ts';
import type {ClientRecord} from '../src/core/client-discovery.ts';

const record:ClientRecord={kind:'dsh',label:'synthetic',status:'verified',reason:'synthetic',checkedAt:'2026-10-29T00:00:00Z',version:'1.0.0',authentication:'unknown',quota:'unknown',invocation:'unknown'};
test('adapter diagnostics project only known enabled/disabled registrations, unknown remains advisory',()=>{
 const adapters=harnessAdapterEvidence([{name:'@deepseek-ai/dsh-llm-pi-ai',config:{providers:{registered:{apiKey:'SECRET',baseURL:'PRIVATE'}}}},{name:'@deepseek-ai/dsh-deepseek-account-platform',disabled:true},{name:'unrecognized',config:{providers:{unproven:{}}}}]);
 assert.deepEqual(adapters.map(x=>[x.provider,x.status]),[['registered','configured'],['deepseek-account','disabled']]);
 assert(!JSON.stringify(adapters).includes('SECRET'));assert(!JSON.stringify(adapters).includes('PRIVATE'));
 for(const provider of ['registered','deepseek-account','unproven']){const result=staticRouteDiagnostics(record,{client:'dsh',model:'future-native-id',provider},adapters);assert.equal(result.blocking,false);assert.equal(result.adapter?.status,provider==='registered'?'configured':provider==='deepseek-account'?'disabled':'unknown');}
 assert.equal(staticRouteDiagnostics(record,{client:'dsh',model:'future-native-id'}).model_validation,'not_probed');
});
test('requested Fast identity is preserved and actual display name never masquerades as actual ID',()=>{
 const route={client:'grok' as const,model:'grok-4.7-build-fast'};
 assert.equal(effectiveRouteView(route,undefined,'grok-4.7-build','user').comparison,'unknown');
 const mismatch=effectiveRouteView(route,'grok-4.7',undefined,'user');assert.equal(mismatch.comparison,'different');assert.equal(mismatch.blocking,false);assert.equal(mismatch.requested_model,route.model);assert.equal(mismatch.preference_source,'user');
});
test('observed tool cancellation never attributes cancellation to user or creates a terminal report',()=>{
 const cancelled=parseAgentOutput('grok',JSON.stringify({type:'tool_call_update',toolCallId:'synthetic',status:'failed',content:[{type:'content',content:{type:'text',text:'User cancelled the execution for tool `run_terminal_command`'}}]}));
 assert.equal(cancelled.terminal,false);assert.equal(cancelled.finalText,undefined);
 const interruption=classifyReviewInterruption(undefined,cancelled.toolInterruption);assert.equal(interruption.kind,'cancelled');assert.equal(interruption.cancel_source,'unknown');
 for(const [code,kind] of [['EACCES','tool_permission_denied'],['approval_required','tool_approval_unavailable']])assert.equal(classifyReviewInterruption(undefined,{code}).kind,kind);
 assert.equal(parseAgentOutput('grok',JSON.stringify({type:'text',data:'permission denied'})).toolInterruption,undefined);
});
