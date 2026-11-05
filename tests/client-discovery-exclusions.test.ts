import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {discoverAgentClients,setClientOverride,resolveClientLauncher,publicClientCapabilities,pathEntries,readDiscoveryPolicy} from '../src/core/client-discovery.ts';
const base=path.resolve('.test-tmp/client-discovery-current-authorization');
async function fixture(){await fs.mkdir(base,{recursive:true});return fs.mkdtemp(path.join(base,'case-'));}
const help='Claude Code --print --output-format --verbose --model --permission-mode --resume';
test('当前明确授权包含 Claude，未知产品仍不执行试探',async()=>{
 const dir=await fixture(),exe=path.join(dir,'claude.exe');await fs.writeFile(exe,'synthetic');let probes=0;
 await assert.rejects(resolveClientLauncher(path.join(dir,'unknown','agent.exe')),/未知客户端/);
 const records=await setClientOverride({dataDir:dir,kind:'claude',executable:exe,testHooks:{candidates:[],probe:async(_command,args)=>{probes++;return args.includes('--version')?'2.1.310':help;}}});
 assert.equal(records.find(r=>r.kind==='claude')?.status,'verified');assert(probes>=2);assert.deepEqual(readDiscoveryPolicy().excluded_kinds,[]);
 assert(publicClientCapabilities(records).find(r=>r.kind==='claude')?.executionSupported);
 assert.deepEqual(pathEntries([path.join(dir,'Claude')]),[path.join(dir,'Claude')]);
});
test('旧缓存仅保留为历史，不凭历史状态或指纹声明可用',async()=>{
 const dir=await fixture(),cache=path.join(dir,'local-agent-clients.json');const previous={schema:2,machine:'test',createdAt:100,records:[{kind:'claude',status:'verified',executable:path.join(dir,'private.exe'),candidatePath:path.join(dir,'private.exe'),fingerprints:[{path:path.join(dir,'secret'),value:'bogus'}]}]};
 await fs.writeFile(cache,JSON.stringify(previous));
 const records=await discoverAgentClients({dataDir:dir,testHooks:{machineId:'test',now:101,candidates:[],probe:async()=>{throw Error('must not probe');}}});
 assert.equal(records.find(r=>r.kind==='claude')!.status,'missing');assert(!JSON.stringify(records).includes('private.exe'));
 const history=(await fs.readdir(dir)).find(f=>f.includes('.history-'));assert(history);assert.deepEqual(JSON.parse(await fs.readFile(path.join(dir,history),'utf8')),previous);
});
test('官方 npm shim 可解析，但伪装产品 help 不能通过身份匹配',async()=>{
 const dir=await fixture(),shim=path.join(dir,'grok.cmd'),entry=path.join(dir,'node_modules','@anthropic-ai','claude-code','cli.js');await fs.mkdir(path.dirname(entry),{recursive:true});await fs.writeFile(entry,'synthetic');
 await fs.writeFile(shim,'@echo off\n"%dp0%\\node_modules\\@anthropic-ai\\claude-code\\cli.js" %*');
 assert.equal((await resolveClientLauncher(shim)).prefixArgs[0],entry);
 const records=await discoverAgentClients({dataDir:dir,testHooks:{candidates:[{path:shim,source:'path'}],probe:async()=>help}});
 assert.equal(records.find(r=>r.kind==='grok')?.status,'unverified');assert.equal(records.find(r=>r.kind==='claude')?.status,'missing');
});
