import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';
const {RELEASE_ENTRIES,isReleaseExcluded,copyReleaseEntries,quarantineExcludedReleaseEntries,assertReleaseTreeClean}=createRequire(import.meta.url)('../scripts/release-files.cjs');
const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');

function fixture(){
  const base=path.join(ROOT,'.test-tmp','release-files');fs.mkdirSync(base,{recursive:true});
  const root=fs.mkdtempSync(path.join(base,'copy-')),source=path.join(root,'source'),stage=path.join(root,'stage');
  fs.mkdirSync(source);fs.mkdirSync(stage);
  const write=(file:string,content='synthetic fixture only')=>{const target=path.join(source,file);fs.mkdirSync(path.dirname(target),{recursive:true});fs.writeFileSync(target,content);};
  return {root,source,stage,write};
}

test('release copy excludes local plans and their calls while preserving public documentation',()=>{
  const f=fixture(),plan='docs/plans/Q-synthetic';
  for(const name of ['PROVIDERS.md','HARNESS.md','IMPLEMENTATION.md','VALIDATION.md'])f.write(`${plan}/${name}`,'formal synthetic guidance');
  for(const name of ['TASK.txt','stdout.jsonl','stderr.log','review-result.json','cursor-agent-logs/session.log','nested/arbitrary.txt'])f.write(`${plan}/calls/AJ-synthetic/${name}`,'SYNTHETIC_RUNTIME_MUST_NOT_SHIP');
  f.write(`${plan}/runs/R-synthetic/RUN.md`);f.write(`${plan}/execution-history/receipt.json`);
  f.write('docs/PLANNER.md');f.write('docs/images/overview.svg');
  const result=copyReleaseEntries(f.source,f.stage,['docs']);
  assert(!fs.existsSync(path.join(f.stage,plan,'calls')));
  assert(!fs.existsSync(path.join(f.stage,plan,'runs')));
  assert(!fs.existsSync(path.join(f.stage,plan,'execution-history')));
  assert(!fs.existsSync(path.join(f.stage,'docs/plans')));
  assert(fs.existsSync(path.join(f.stage,'docs/PLANNER.md')));assert(fs.existsSync(path.join(f.stage,'docs/images/overview.svg')));
  assert(result.excluded.includes('docs/plans'));assert.equal(result.copied.length,2);
  assertReleaseTreeClean(f.stage);
});

test('the same source-copy filter covers source, scripts, config and old portable runtime output',()=>{
  const f=fixture();
  for(const file of ['src/core/agent-history.ts','src/cache/index.ts','src/config/credentials.ts','scripts/backup.ts','config/example.json','docs/.env.example','桌面版/工作台/resources/app/main.cjs','桌面版/使用说明.txt'])f.write(file);
  const excluded=['src/core/debug.log','scripts/trace.jsonl','config/local.json','config/client-secrets.json','docs/.env.local',
    '桌面版/工作台/data/user.json','桌面版/工作台/.agent-workbench/tasks/RUN.md','桌面版/工作台/logs/debug.txt','桌面版/工作台/Cache/cache.bin','桌面版/工作台/session.sqlite-wal','docs/.workbench-review-checks/AJ-test/verify.mjs','src/.workbench-review-checks/retained-permissions/cli.json',
    'src/.workbench-workgroups/WG-test/WJ-test/prompt.txt','docs/.workbench-workgroups/WG-test/WJ-test/workgroup-tools.json'];
  for(const file of excluded)f.write(file);
  copyReleaseEntries(f.source,f.stage,['src','scripts','config','docs','桌面版']);
  for(const file of excluded)assert(!fs.existsSync(path.join(f.stage,file)),file);
  assert(fs.existsSync(path.join(f.stage,'src/core/agent-history.ts')));
  assert(fs.existsSync(path.join(f.stage,'src/cache/index.ts')));assert(fs.existsSync(path.join(f.stage,'src/config/credentials.ts')));
  assert(fs.existsSync(path.join(f.stage,'桌面版/工作台/resources/app/main.cjs')));
  assert(fs.existsSync(path.join(f.stage,'config/example.json')));
  assert(fs.existsSync(path.join(f.stage,'docs/.env.example')));
  assertReleaseTreeClean(f.stage);
});

test('post-install audit rejects newly added runtime material and permits public dependency data',()=>{
  const f=fixture();fs.mkdirSync(path.join(f.stage,'node_modules/example/data'),{recursive:true});
  fs.writeFileSync(path.join(f.stage,'node_modules/example/data/table.json'),'{}');
  fs.mkdirSync(path.join(f.stage,'node_modules/example/middleware/cache'),{recursive:true});
  fs.writeFileSync(path.join(f.stage,'node_modules/example/middleware/cache/index.js'),'export {};');assertReleaseTreeClean(f.stage);
  fs.mkdirSync(path.join(f.stage,'docs/plans/Q-synthetic/calls/AJ-synthetic'),{recursive:true});
  fs.writeFileSync(path.join(f.stage,'docs/plans/Q-synthetic/calls/AJ-synthetic/review-result.json'),'{}');
  assert.throws(()=>assertReleaseTreeClean(f.stage),/local runtime material/);
});

test('post-install quarantine preserves excluded dependency settings outside staging without touching valid modules',()=>{
  const f=fixture(),quarantine=path.join(f.root,'excluded');
  fs.mkdirSync(path.join(f.stage,'node_modules/example/.claude'),{recursive:true});
  fs.writeFileSync(path.join(f.stage,'node_modules/example/.claude/settings.local.json'),'synthetic package developer setting');
  fs.writeFileSync(path.join(f.stage,'node_modules/example/index.js'),'export {};');
  const moved=quarantineExcludedReleaseEntries(f.stage,quarantine);
  assert.deepEqual(moved,['node_modules/example/.claude']);
  assert.equal(fs.readFileSync(path.join(quarantine,'node_modules/example/.claude/settings.local.json'),'utf8'),'synthetic package developer setting');
  assert(fs.existsSync(path.join(f.stage,'node_modules/example/index.js')));assertReleaseTreeClean(f.stage);
  assert.throws(()=>quarantineExcludedReleaseEntries(f.stage,path.join(f.stage,'excluded')),/separate/);
});

test('release path policy is case-insensitive and rejects traversal rather than copying outside roots',()=>{
  assert(isReleaseExcluded('DOCS\\PLANS\\Q-test\\CALLS\\AJ-test\\report.txt'));
  for(const file of ['../private.txt','docs/../../private.txt','C:\\private.txt','/private.txt'])assert.throws(()=>isReleaseExcluded(file),/relative path/);
  assert(isReleaseExcluded('docs/plans/Q-test/PROVIDERS.md'));
  assert(!isReleaseExcluded('src/core/execution-history.ts'));
  assert(RELEASE_ENTRIES.includes('docs'));assert(!RELEASE_ENTRIES.includes('data'));assert(!RELEASE_ENTRIES.includes('tests'));assert(!RELEASE_ENTRIES.includes('node_modules'));
});

test('included directory links are refused and excluded runtime links are never followed',()=>{
  const f=fixture();f.write('docs/KEEP.md');const outside=path.join(f.root,'outside');fs.mkdirSync(outside);fs.writeFileSync(path.join(outside,'private.txt'),'synthetic private fixture');
  fs.mkdirSync(path.join(f.source,'docs/plans/Q-synthetic'),{recursive:true});
  fs.symlinkSync(outside,path.join(f.source,'docs/plans/Q-synthetic/calls'),'junction');
  copyReleaseEntries(f.source,f.stage,['docs']);assert(!fs.existsSync(path.join(f.stage,'docs/plans/Q-synthetic/calls')));
  const included=path.join(f.source,'docs/included-link');fs.symlinkSync(outside,included,'junction');
  assert.notEqual(fs.realpathSync.native(included).toLowerCase(),path.resolve(included).toLowerCase(),'fixture must remain a real redirected directory even when lstat reports no symbolic link');
  assert.throws(()=>copyReleaseEntries(f.source,path.join(f.root,'linked-stage'),['docs']),/No links allowed/);
  const auditStage=path.join(f.root,'linked-audit');fs.mkdirSync(auditStage);fs.symlinkSync(outside,path.join(auditStage,'included-link'),'junction');
  assert.throws(()=>assertReleaseTreeClean(auditStage),/Unexpected release link/);
  assert.throws(()=>quarantineExcludedReleaseEntries(auditStage,path.join(f.root,'quarantine-linked')),/Unexpected release link/);
  assert.equal(fs.readFileSync(path.join(outside,'private.txt'),'utf8'),'synthetic private fixture');
});
