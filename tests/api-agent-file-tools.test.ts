import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {createApiAgentFileTools,ApiAgentFileError,isApiAgentProtectedPath} from '../src/core/api-agent-file-tools.ts';
const root=path.resolve('.test-tmp/api-agent-files');
function fixture(){fs.mkdirSync(root,{recursive:true});const dir=fs.mkdtempSync(path.join(root,'中文 space-'));return {dir,tools:createApiAgentFileTools({cwd:dir,allowedRoots:[dir]})};}
const hash=(value:string|Buffer)=>createHash('sha256').update(value).digest('hex');
const code=(expected:string)=>(error:unknown)=>error instanceof ApiAgentFileError&&error.code===expected;

test('file tools create, read and compare-before-replace Unicode paths',async()=>{
 const {dir,tools}=fixture(),file=path.join(dir,'中文 space','结果.txt');
 const made=await tools.callTool('write_project_file',{path:file,content:'初稿\n',expected_sha256:null});assert.equal(made?.created,true);
 const read=await tools.callTool('read_project_file',{path:'中文 space/结果.txt'});assert.equal(read?.content,'初稿\n');assert.equal(read?.sha256,hash('初稿\n'));
 await tools.callTool('write_project_file',{path:file,content:'修订\n',expected_sha256:read?.sha256});assert.equal(fs.readFileSync(file,'utf8'),'修订\n');
 await assert.rejects(tools.callTool('write_project_file',{path:file,content:'旧修改',expected_sha256:read?.sha256}),code('api_file_conflict'));assert.equal(fs.readFileSync(file,'utf8'),'修订\n');
 await assert.rejects(tools.callTool('write_project_file',{path:file,content:'覆盖',expected_sha256:null}),code('api_file_conflict'));
 await assert.rejects(tools.callTool('write_project_file',{path:'missing',content:'x',expected_sha256:hash('x')}),code('api_file_conflict'));
});
test('write requires an explicit concurrency condition and refuses extra fields',async()=>{
 const {tools}=fixture();for(const args of [{path:'a',content:'a'},{path:'a',content:'a',expected_sha256:'bad'},{path:'a',content:'a',expected_sha256:null,shell:'ignored?'}])await assert.rejects(tools.callTool('write_project_file',args),code('api_file_invalid_arguments'));
});
test('raw BOM bytes determine SHA while text is decoded without BOM',async()=>{
 const {dir,tools}=fixture(),bytes=Buffer.concat([Buffer.from([239,187,191]),Buffer.from('文字')]);fs.writeFileSync(path.join(dir,'bom.txt'),bytes);
 const read=await tools.callTool('read_project_file',{path:'bom.txt'});assert.equal(read?.content,'文字');assert.equal(read?.utf8_bom,true);assert.equal(read?.sha256,hash(bytes));assert.equal(read?.bytes,bytes.length);
});
test('outside paths, Windows ADS and device paths are rejected before access',async()=>{
 const {dir,tools}=fixture();await assert.rejects(tools.callTool('read_project_file',{path:'../outside.txt'}),code('api_file_outside_scope'));
 for(const file of [path.join(dir,'normal.txt:secret'),'\\\\?\\C:\\test','C:relative.txt','NUL.txt','bad.'])await assert.rejects(tools.callTool('read_project_file',{path:file}),code('api_file_invalid_path'));
});
test('credential/internal files and dynamic workbench private paths are excluded from reads and listing',async()=>{
 const {dir}=fixture();for(const name of ['safe.txt','.env','auth.json','settings.local.json','one.pem','state.db'])fs.writeFileSync(path.join(dir,name),'synthetic');
 fs.mkdirSync(path.join(dir,'config'));fs.writeFileSync(path.join(dir,'config','local.json'),'synthetic');fs.mkdirSync(path.join(dir,'custom-runtime'));fs.mkdirSync(path.join(dir,'dynamic-private'));
 const tools=createApiAgentFileTools({cwd:dir,allowedRoots:[dir],protectedPaths:[path.join(dir,'custom-runtime')],isPrivatePath:p=>p.startsWith(path.join(dir,'dynamic-private'))});
 for(const name of ['.env','auth.json','settings.local.json','one.pem','state.db','config/local.json','custom-runtime/file','dynamic-private/file'])await assert.rejects(tools.callTool('read_project_file',{path:name}),code('api_file_protected_path'));
 const listed=await tools.callTool('list_project_files',{path:'.'});assert.deepEqual(listed?.entries?.map(x=>x.name).sort(),['config','safe.txt']);
 assert(isApiAgentProtectedPath('C:\\project\\.env.production'));assert(isApiAgentProtectedPath('C:\\project\\config\\local.json'));
});
test('directory junctions inside/outside roots are rejected, including a root itself',async()=>{
 const {dir,tools}=fixture(),outside=fixture().dir,link=path.join(dir,'linked');fs.writeFileSync(path.join(outside,'target.txt'),'outside');fs.symlinkSync(outside,link,'junction');
 await assert.rejects(tools.callTool('read_project_file',{path:path.join(link,'target.txt')}),code('api_file_linked_path'));
 await assert.rejects(tools.callTool('write_project_file',{path:path.join(link,'new.txt'),content:'blocked',expected_sha256:null}),code('api_file_linked_path'));
 assert.throws(()=>createApiAgentFileTools({cwd:link,allowedRoots:[link]}),code('api_file_linked_path'));
 const listed=await tools.callTool('list_project_files',{path:dir});assert(!listed?.entries?.some(e=>e.name==='linked'));assert(!fs.existsSync(path.join(outside,'new.txt')));
});
test('hard-linked files are unreadable and cannot be overwritten',async()=>{
 const {dir,tools}=fixture(),other=fixture().dir;fs.writeFileSync(path.join(other,'original.txt'),'unchanged');fs.linkSync(path.join(other,'original.txt'),path.join(dir,'alias.txt'));
 await assert.rejects(tools.callTool('read_project_file',{path:'alias.txt'}),code('api_file_not_regular'));
 await assert.rejects(tools.callTool('write_project_file',{path:'alias.txt',content:'bad',expected_sha256:hash('unchanged')}),code('api_file_not_regular'));
 assert.equal(fs.readFileSync(path.join(other,'original.txt'),'utf8'),'unchanged');
});
test('bounded UTF-8 only files, bounded listing and cancellation are truthful',async()=>{
 const {dir,tools}=fixture();fs.writeFileSync(path.join(dir,'bad.txt'),Buffer.from([255]));fs.writeFileSync(path.join(dir,'binary.txt'),'a\0b');fs.writeFileSync(path.join(dir,'large.txt'),Buffer.alloc(128*1024+1));
 for(const name of ['bad.txt','binary.txt'])await assert.rejects(tools.callTool('read_project_file',{path:name}),code('api_file_not_utf8'));
 await assert.rejects(tools.callTool('read_project_file',{path:'large.txt'}),code('api_file_too_large'));
 await assert.rejects(tools.callTool('write_project_file',{path:'large-write.txt',content:'界'.repeat(100000),expected_sha256:null}),code('api_file_too_large'));
 const listed=await tools.callTool('list_project_files',{path:'.',limit:1});assert.equal(listed?.entries?.length,1);assert.equal(listed?.has_more,true);
 const cancelled=AbortSignal.abort();await assert.rejects(tools.callTool('write_project_file',{path:'cancelled.txt',content:'x',expected_sha256:null},{signal:cancelled}),code('api_cancelled'));assert(!fs.existsSync(path.join(dir,'cancelled.txt')));
});
test('scope validation forbids broad private roots and unavailable tools',async()=>{
 const {dir,tools}=fixture();const privateDir=path.join(dir,'.codex');fs.mkdirSync(privateDir);assert.throws(()=>createApiAgentFileTools({cwd:privateDir,allowedRoots:[privateDir]}),code('api_file_protected_path'));
 assert.throws(()=>createApiAgentFileTools({cwd:dir,allowedRoots:[]}),code('api_file_invalid_scope'));
 await assert.rejects(tools.callTool('shell',{command:'echo unsafe'}),code('api_tool_unavailable'));
});
