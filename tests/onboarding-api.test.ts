import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {fixture} from './helpers.ts';
import {createApp} from '../src/server/app.ts';
import {getOnboardingContext,verifyWorkbenchConnection} from '../src/core/onboarding.ts';
import {installCodexMcpSetup} from '../src/core/codex-mcp-setup.ts';

function isolatedSetup(root:string){
  const runtimeRoot=path.join(root,'合成 工作台');
  for(const file of ['src/mcp/index.ts','node_modules/tsx/dist/loader.mjs','scripts/setup-codex-mcp.ts']){
    const target=path.join(runtimeRoot,file);fs.mkdirSync(path.dirname(target),{recursive:true});fs.writeFileSync(target,'');
  }
  const nodePath=path.join(root,'合成 node.exe');fs.writeFileSync(nodePath,'');
  return {root:runtimeRoot,nodePath,configPath:path.join(root,'isolated-codex/config.toml')};
}
function diagnosticFiles(dataDir:string){return fs.readdirSync(dataDir).filter(name=>name.startsWith('onboarding-')||name==='agent-clients.json').sort();}

test('onboarding GET requires browser session and only reads existing state without writes or diagnostics',async()=>{
  const f=fixture();f.wb.close();
  const previousHome=process.env.CODEX_HOME;process.env.CODEX_HOME=path.join(f.root,'isolated-codex');
  const {app,wb}=await createApp(f.config,{background:false});
  const host='127.0.0.1:'+f.config.port;
  try{
    assert.equal((await app.inject({url:'/api/onboarding',headers:{host}})).statusCode,401);
    assert.equal((await app.inject({url:'/api/onboarding',headers:{host,authorization:'Bearer '+wb.keys.manager}})).statusCode,401);
    const boot=await app.inject({url:'/api/bootstrap',headers:{host}}),cookie=String(boot.headers['set-cookie']).split(';')[0]!;
    const before=wb.db.prepare('SELECT total_changes() AS n').get(),files=diagnosticFiles(f.config.dataDir);
    const response=await app.inject({url:'/api/onboarding',headers:{host,cookie}});
    assert.equal(response.statusCode,200);
    const result=response.json();assert.equal(typeof result.prompt,'string');assert.deepEqual(result.exclusions,['claude']);assert.equal(result.mcp.connection_status,'not_verified');assert.deepEqual(result.diagnostics,[]);
    assert.deepEqual(wb.db.prepare('SELECT total_changes() AS n').get(),before);
    assert.deepEqual(diagnosticFiles(f.config.dataDir),files);
    assert.equal(fs.existsSync(path.join(process.env.CODEX_HOME!,'config.toml')),false);
    assert.equal((await app.inject({method:'POST',url:'/api/onboarding',headers:{host,cookie,'x-workbench-csrf':boot.json().csrf},payload:{}})).statusCode,404);
  }finally{await app.close();if(previousHome===undefined)delete process.env.CODEX_HOME;else process.env.CODEX_HOME=previousHome;}
});

test('isolated persisted configuration is not connected until Codex handshake and tool call, and changed configuration invalidates connection',()=>{
  const f=fixture(),options=isolatedSetup(f.root);
  try{
    installCodexMcpSetup(options);
    const configured=getOnboardingContext(f.wb,options);assert.equal(configured.mcp.status,'current');assert.equal(configured.mcp.connection_status,'not_verified');
    assert.throws(()=>verifyWorkbenchConnection(f.wb,{}, {instance:randomUUID(),client:'workbench-local-manager'},options),/目标 Codex/);
    assert.equal(getOnboardingContext(f.wb,options).mcp.connection_status,'not_verified');
    assert.throws(()=>verifyWorkbenchConnection(f.wb,{}, {client:'Codex'},options),/新建/);
    const receipt=verifyWorkbenchConnection(f.wb,{}, {instance:randomUUID(),client:'Codex CLI',version:'synthetic'},options);
    assert.equal(receipt.connection_status,'connected');
    assert.equal(getOnboardingContext(f.wb,options).mcp.connection_status,'connected');
    const changedNode=path.join(f.root,'另一份 node.exe');fs.writeFileSync(changedNode,'');const changed={...options,nodePath:changedNode};
    installCodexMcpSetup(changed);
    const stale=getOnboardingContext(f.wb,changed);assert.equal(stale.mcp.status,'current');assert.equal(stale.mcp.connection_status,'not_verified');
    assert.equal(fs.readFileSync(path.join(f.config.dataDir,'onboarding-connection.json'),'utf8').includes(receipt.instance!),true);
  }finally{f.wb.close();}
});

test('onboarding MCP tools require manager and Claude diagnostic is rejected before discovery or diagnostic persistence',async()=>{
  const f=fixture();f.wb.close();const previousHome=process.env.CODEX_HOME;process.env.CODEX_HOME=path.join(f.root,'isolated-codex');
  const {app,wb}=await createApp(f.config,{background:false}),host='127.0.0.1:'+f.config.port;
  const call=(name:string,token:string,payload:object)=>app.inject({method:'POST',url:'/api/mcp/'+name,headers:{host,authorization:'Bearer '+token},payload});
  try{
    for(const name of ['get_onboarding_context','verify_workbench_connection','record_onboarding_models','refresh_onboarding_models','run_onboarding_diagnostic']){
      assert.equal((await call(name,wb.keys.planner,{})).statusCode,403,name);
      assert.equal((await call(name,wb.keys.chat_planner,{})).statusCode,403,name);
    }
    assert.equal((await call('get_onboarding_context',wb.keys.manager,{})).statusCode,200);
    const before=diagnosticFiles(f.config.dataDir),changes=wb.db.prepare('SELECT total_changes() AS n').get();
    for(const patch of [{agent_id:'claude',model:'Native-ID'},{agent_id:'grok-build',model:'Claude-Opus'},{agent_id:'grok-build',model:'Native-ID',provider:'Anthropic'}]){
      const denied=await call('run_onboarding_diagnostic',wb.keys.manager,{request_id:randomUUID(),...patch});
      assert.equal(denied.statusCode,400);assert.match(denied.json().error,/Claude/);
    }
    assert.deepEqual(diagnosticFiles(f.config.dataDir),before);
    assert.deepEqual(wb.db.prepare('SELECT total_changes() AS n').get(),changes);
  }finally{await app.close();if(previousHome===undefined)delete process.env.CODEX_HOME;else process.env.CODEX_HOME=previousHome;}
});
