import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js';
import {createRequire} from 'node:module';
import {execFileSync} from 'node:child_process';
import {parse} from 'yaml';
import {callImageBackend, harnessImagePatch, installHarnessImageTools, mergeHarnessImagePatch, readImageBridgeCredential, rollbackHarnessImageTools, type HarnessImageLaunch} from '../src/core/harness-image-tools.ts';
import {createExternalImageServer, imageArtifactResult} from '../scripts/external-image-mcp.ts';
import {runHarnessImageInstaller} from '../scripts/install-harness-image-tools.ts';
import {Workbench} from '../src/core/workbench.ts';
import {ExternalServices} from '../src/core/external-services.ts';
import {callExternalTool} from '../src/server/external-service-routes.ts';
import type {ExternalVault} from '../src/core/external-vault.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '.local-dev', 'tests', 'harness-image-tools');
function fixture() {
  fs.mkdirSync(root, {recursive: true}); const directory = fs.mkdtempSync(path.join(root, 'fixture-'));
  const profile = path.join(directory, 'desktop'), runtime = path.join(directory, 'runtime');
  fs.mkdirSync(profile); fs.mkdirSync(runtime);
  const launch: HarnessImageLaunch = {nodePath: path.join(runtime, 'node.exe'), scriptPath: path.join(runtime, 'external-image-mcp.ts'), loaderPath: path.join(runtime, 'tsx.mjs'), credentialFile: path.join(runtime, 'bridge-credential.json'), cwd: runtime};
  for (const file of [launch.nodePath, launch.scriptPath, launch.loaderPath, launch.credentialFile]) fs.writeFileSync(file, 'synthetic fixture');
  return {directory, profile, runtime, launch, config: path.join(profile, 'cordis.patch.yml')};
}

test('Harness MCP patch uses the native insert form and contains only a credential reference', () => {
  const f = fixture(), patch = harnessImagePatch(f.launch), row = patch[0].insert[0];
  assert.equal(row.name, '@deepseek-ai/dsh-mcp-client'); assert.equal(row.config.transport, 'stdio');
  assert.equal(row.config.failOnStartupError, true);
  assert.equal(row.config.env.WORKBENCH_EXTERNAL_TOOLS_CREDENTIAL_FILE, f.launch.credentialFile);
  assert.deepEqual(row.config.args.slice(0, 1), ['--import']); assert.match(row.config.args[1], /^file:\/\//);
  assert.equal(row.config.args[2], f.launch.scriptPath); assert(!JSON.stringify(patch).includes('Bearer'));
  assert.throws(() => harnessImagePatch({...f.launch, credentialFile: 'relative.json'}), /绝对路径/);
});

test('merge preserves native YAML comments, JS credential expressions and CRLF without evaluation', () => {
  const f = fixture(), original = '# preserved comment\r\n- id: provider\r\n  config:\r\n    apiKey: !!js process.env.PRIVATE_KEY\r\n    quoted: "PRIVATE_VALUE"\r\n';
  const merged = mergeHarnessImagePatch(original, f.launch);
  assert(merged.content.startsWith(original)); assert.equal(merged.changed, true);
  assert.equal(mergeHarnessImagePatch(merged.content, f.launch).changed, false);
  const next = mergeHarnessImagePatch(merged.content, {...f.launch, scriptPath: path.join(f.runtime, 'new.ts')});
  assert(next.content.startsWith(original)); assert.equal(next.content.split('# BEGIN').length, 2);
  assert(!next.content.includes(f.launch.scriptPath.replaceAll('\\', '\\\\')));
});

test('merge supports empty, flow/JSON and explicit-end YAML while refusing ambiguous documents', () => {
  const f = fixture();
  for (const original of ['', '[]', '[{"id":"existing"}]', '[{"id":"existing"},]', '---\n- id: existing\n...\n# trailing\n']) {
    const result = mergeHarnessImagePatch(original, f.launch), parsed = parse(result.content);
    assert(Array.isArray(parsed)); assert.equal(parsed.at(-1).insert[0].id, 'workbench-image-tools');
    assert.equal(mergeHarnessImagePatch(result.content, f.launch).changed, false);
  }
  assert.throws(() => mergeHarnessImagePatch('- id: workbench-image-tools\n', f.launch), /同名/);
  assert.throws(() => mergeHarnessImagePatch('- config:\n    serverName: workbench_images\n', f.launch), /同名/);
  assert.throws(() => mergeHarnessImagePatch('---\n[]\n---\n[]\n', f.launch), /有效/);
  assert.throws(() => mergeHarnessImagePatch('secret: [PRIVATE_SECRET', f.launch), error => !String(error).includes('PRIVATE_SECRET'));
  assert.throws(() => mergeHarnessImagePatch('# BEGIN agent-workbench managed image tools v1\n[]', f.launch), /标记/);
});

test('installer dry run is non-mutating; installed patch is reversible and backs up private bytes locally', () => {
  const f = fixture(), original = Buffer.from('- id: provider\n  config:\n    apiKey: "SYNTHETIC_SECRET"\n');
  fs.writeFileSync(f.config, original);
  const preview = installHarnessImageTools({...f.launch, profilePath: f.profile, dryRun: true});
  assert.equal(preview.applied, false); assert.deepEqual(fs.readFileSync(f.config), original);
  assert.deepEqual(fs.readdirSync(f.profile), ['cordis.patch.yml']);
  const installed = installHarnessImageTools({...f.launch, profilePath: f.profile});
  assert(installed.applied); assert('receipt_path' in installed); assert(installed.receipt_path);
  assert(installed.backup_path); assert.deepEqual(fs.readFileSync(installed.backup_path), original);
  assert(!fs.readFileSync(installed.receipt_path, 'utf8').includes('SYNTHETIC_SECRET'));
  assert.equal(installHarnessImageTools({...f.launch, profilePath: f.profile}).changed, false);
  assert.equal(rollbackHarnessImageTools(f.profile, installed.receipt_path).rolled_back, true);
  assert.deepEqual(fs.readFileSync(f.config), original);
});

test('rollback refuses later edits and corrupt backup, preserving current user changes', () => {
  const f = fixture(); fs.writeFileSync(f.config, '- id: existing\n');
  const installed = installHarnessImageTools({...f.launch, profilePath: f.profile});
  assert('receipt_path' in installed && installed.receipt_path && installed.backup_path);
  const current = fs.readFileSync(f.config); fs.appendFileSync(f.config, '\n# user later edit\n');
  assert.throws(() => rollbackHarnessImageTools(f.profile, installed.receipt_path!), /已变化/);
  assert(fs.readFileSync(f.config, 'utf8').endsWith('# user later edit\n'));
  fs.writeFileSync(f.config, current); fs.appendFileSync(installed.backup_path!, '# corrupted');
  assert.throws(() => rollbackHarnessImageTools(f.profile, installed.receipt_path!), /校验失败/);
  assert.deepEqual(fs.readFileSync(f.config), current);
});

test('install then rollback a previously absent patch preserves an empty equivalent and local receipts', () => {
  const f = fixture();
  const installed = installHarnessImageTools({...f.launch, profilePath: f.profile});
  assert('receipt_path' in installed && installed.receipt_path);
  assert.equal(installed.backup_path, null);
  const rollback = rollbackHarnessImageTools(f.profile, installed.receipt_path);
  assert.equal(rollback.originally_absent, true); assert.equal(fs.readFileSync(f.config, 'utf8'), '');
  assert(fs.existsSync(installed.receipt_path));
});

for (const extraReader of [true, false]) test(`Windows existing backup directory with ${extraReader ? 'an extra explicit reader' : 'inherited access'} is rejected without changing ACL or configuration`, {skip: process.platform !== 'win32'}, () => {
  const f = fixture(), original = Buffer.from('- id: provider\r\n  config: {apiKey: "SYNTHETIC_PRIVATE"}\r\n'); fs.writeFileSync(f.config, original);
  const backupRoot = path.join(f.profile, '.workbench-image-backups'); fs.mkdirSync(backupRoot);
  const icacls = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'icacls.exe');
  if (extraReader) execFileSync(icacls, [backupRoot, '/grant', '*S-1-1-0:(OI)(CI)R'], {windowsHide: true, stdio: 'pipe'});
  const before = path.join(f.directory, 'acl-before.txt'), after = path.join(f.directory, 'acl-after.txt');
  execFileSync(icacls, [backupRoot, '/save', before], {windowsHide: true, stdio: 'pipe'});
  assert.throws(() => installHarnessImageTools({...f.launch, profilePath: f.profile}), /无法保护配置备份/);
  execFileSync(icacls, [backupRoot, '/save', after], {windowsHide: true, stdio: 'pipe'});
  assert.deepEqual(fs.readFileSync(after), fs.readFileSync(before));
  assert.deepEqual(fs.readFileSync(f.config), original);
  for (const name of fs.readdirSync(backupRoot)) {
    assert(name.startsWith('acl-check-'));
    const file = path.join(backupRoot, name); assert(fs.statSync(file).isFile());
    assert(!fs.readFileSync(file).toString('utf16le').includes('SYNTHETIC_PRIVATE'));
  }
});

test('Windows existing protected backup directory is reused without changing its ACL', {skip: process.platform !== 'win32'}, () => {
  const f = fixture(), original = Buffer.from('- id: provider\n'); fs.writeFileSync(f.config, original);
  const first = installHarnessImageTools({...f.launch, profilePath: f.profile});
  assert('receipt_path' in first && first.receipt_path);
  rollbackHarnessImageTools(f.profile, first.receipt_path);
  const backupRoot = path.join(f.profile, '.workbench-image-backups');
  const icacls = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'icacls.exe');
  const before = path.join(f.directory, 'acl-protected-before.txt'), after = path.join(f.directory, 'acl-protected-after.txt');
  execFileSync(icacls, [backupRoot, '/save', before], {windowsHide: true, stdio: 'pipe'});
  const second = installHarnessImageTools({...f.launch, profilePath: f.profile});
  assert(second.applied && 'receipt_path' in second && second.receipt_path);
  execFileSync(icacls, [backupRoot, '/save', after], {windowsHide: true, stdio: 'pipe'});
  assert.deepEqual(fs.readFileSync(after), fs.readFileSync(before));
  rollbackHarnessImageTools(f.profile, second.receipt_path);
  assert.deepEqual(fs.readFileSync(f.config), original);
});

test('credential reader accepts only encrypted current-user credentials and loopback URL', async () => {
  const f = fixture(), token = 'synthetic-restricted-token-123456789';
  fs.writeFileSync(f.launch.credentialFile, JSON.stringify({base_url: 'http://127.0.0.1:4317', protected_token: 'dpapi:v1:FIXTURE'}));
  let decrypts = 0;
  const c = await readImageBridgeCredential(f.launch.credentialFile, async value => { decrypts++; assert.equal(value, 'dpapi:v1:FIXTURE'); return {token}; });
  assert.deepEqual(c, {base_url: 'http://127.0.0.1:4317', token}); assert.equal(decrypts, 1);
  fs.writeFileSync(f.launch.credentialFile, JSON.stringify({base_url: 'http://127.0.0.1:4317', token}));
  await assert.rejects(readImageBridgeCredential(f.launch.credentialFile, async () => ({token})), /不接受明文/);
  fs.writeFileSync(f.launch.credentialFile, JSON.stringify({base_url: 'https://example.com', protected_token: 'dpapi:v1:FIXTURE'}));
  await assert.rejects(readImageBridgeCredential(f.launch.credentialFile, async () => ({token})), /回环/);
});

test('backend transport uses a restricted bearer, forbids redirects/retries, and redacts leaked token', async () => {
  const token = 'synthetic-restricted-token-123456789', credential = {base_url: 'http://127.0.0.1:4317', token}; let calls = 0;
  const result = await callImageBackend(credential, 'invoke_external_service', {request_id: 'same-id'}, undefined, (async (url, init) => {
    calls++; assert.equal(String(url), 'http://127.0.0.1:4317/api/mcp/invoke_external_service'); assert.equal(init?.redirect, 'error');
    assert.equal((init?.headers as Record<string, string>).Authorization, 'Bearer ' + token);
    return new Response(JSON.stringify({status: 'queued', accidental: token}));
  }) as typeof fetch);
  assert.equal(calls, 1); assert.equal(result.accidental, '[redacted]');
  await assert.rejects(callImageBackend(credential, 'invoke_external_service', {}, undefined, (async () => { calls++; throw Error(token); }) as typeof fetch), error => !String(error).includes(token));
  assert.equal(calls, 2);
  await assert.rejects(callImageBackend({...credential, base_url: 'http://external.example'}, 'list_external_services', {}, undefined, (async () => { throw Error('must not call'); }) as typeof fetch), /回环/);
});

test('MCP handshake and tools/list never call backend; image tools map requests and expose only scoped reads', async () => {
  const calls: Array<{tool: string; input: Record<string, unknown>}> = [];
  const server = createExternalImageServer(async (tool, input) => {
    calls.push({tool, input});
    if (tool === 'list_external_services') return {services: [{id: 'image', capabilities: ['image'], operations: ['image.generate', 'image.edit']}, {id: 'text', capabilities: ['text'], operations: ['chat']}, {id: 'unadapted-image', capabilities: ['image'], operations: []}]};
    if (tool === 'get_external_artifact') return {path: '/synthetic/not-read.png', mime_type: 'image/png', inline_image: {mime_type: 'image/png', data: Buffer.from('synthetic').toString('base64')}};
    return {invocation_id: 'EI-test', status: 'queued'};
  });
  const client = new Client({name: 'isolated-test', version: '1'}), [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport); await client.connect(clientTransport);
  try {
    const tools = await client.listTools(); assert.equal(tools.tools.length, 5); assert.equal(calls.length, 0);
    const list = await client.callTool({name: 'list_image_services', arguments: {}});
    const listed = JSON.parse((list.content as Array<{text: string}>)[0].text);
    assert.deepEqual(listed.services.map((s: {id: string}) => s.id), ['image']);
    const request_id = randomUUID();
    await client.callTool({name: 'edit_image', arguments: {service_id: 'image', request_id, prompt: 'edit synthetic', images: [{image_url: '/synthetic/source.png'}], options: {size: '1024x1024'}}});
    assert.deepEqual(calls.at(-1), {tool: 'invoke_external_service', input: {service_id: 'image', request_id, operation: 'edit_image', input: {size: '1024x1024', prompt: 'edit synthetic', images: [{image_url: '/synthetic/source.png'}]}}});
    const prior = calls.length, failure = await client.callTool({name: 'generate_image', arguments: {service_id: 'image', request_id: randomUUID(), prompt: 'synthetic', options: {apiKey: 'DO_NOT_FORWARD'}}});
    assert.equal(failure.isError, true); assert.equal(calls.length, prior);
    const artifact = await client.callTool({name: 'get_image_artifact', arguments: {invocation_id: 'EI-test', artifact_id: 'artifact-test'}});
    assert(JSON.stringify(artifact).includes('/synthetic/not-read.png')); assert.equal((artifact.content as any[])[1].type, 'image');
  } finally { await client.close(); await server.close(); }
});

test('artifact projection does not inline unsafe types or arbitrary backend content', () => {
  const value = imageArtifactResult({path: '/not/read', inline_image: {mime_type: 'image/svg+xml', data: 'PHN2Zz4='}});
  assert.equal(value.content.length, 1); assert(!JSON.stringify(value).includes('PHN2Zz4='));
});

test('installed native MCP config discovers tools over a real stdio subprocess without a readable credential', {timeout: 20000}, async () => {
  const f = fixture(), project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const original = '# synthetic existing profile\n- id: unchanged\n'; fs.writeFileSync(f.config, original);
  const args = ['--profile', f.profile, '--runtime', project, '--node', process.execPath, '--credential-file', f.launch.credentialFile];
  const preview = runHarnessImageInstaller([...args, '--dry-run']); assert('applied' in preview && !preview.applied);
  const installed = runHarnessImageInstaller(args); assert('receipt_path' in installed && typeof installed.receipt_path === 'string');
  const patch = parse(fs.readFileSync(f.config, 'utf8')), config = patch.at(-1).insert[0].config;
  assert.equal(config.command, process.execPath);
  assert.equal(config.args[1], pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href);
  const transport = new StdioClientTransport({command: config.command, args: config.args, cwd: config.cwd, env: {...config.env, ...(process.env.SystemRoot ? {SystemRoot: process.env.SystemRoot} : {}), ...(process.env.TEMP ? {TEMP: process.env.TEMP} : {}), ...(process.env.TMP ? {TMP: process.env.TMP} : {})}, stderr: 'pipe'});
  let stderr = ''; transport.stderr?.on('data', chunk => {stderr += chunk.toString();});
  const client = new Client({name: 'isolated-native-config-discovery', version: '1'});
  try {
    await client.connect(transport); const tools = await client.listTools();
    assert.deepEqual(tools.tools.map(tool => tool.name).sort(), ['edit_image', 'generate_image', 'get_image_artifact', 'get_image_invocation', 'list_image_services']);
    // The fixture is deliberately not a credential JSON file. Discovery must work,
    // and an actual tool call must fail locally before any backend/API request.
    const response = await client.callTool({name: 'list_image_services', arguments: {}});
    assert.equal(response.isError, true); assert(!JSON.stringify(response).includes('synthetic fixture'));
    assert(!stderr.includes('synthetic fixture'));
  } finally { await client.close(); await transport.close(); }
  const rollback = runHarnessImageInstaller(['--profile', f.profile, '--rollback', installed.receipt_path]);
  assert('rolled_back' in rollback && rollback.rolled_back); assert.equal(fs.readFileSync(f.config, 'utf8'), original);
});

test('MCP bridge integrates with real scoped service logic, archives a synthetic image, and rejects another identity', async () => {
  const f = fixture();
  const wb = new Workbench({root: f.directory, dataDir: path.join(f.directory, 'data'), port: 14317, timezone: 'America/Los_Angeles', authorizedRoots: [f.directory], integrations: {tokenMonitor: {baseUrl: ''}, agentsView: {baseUrl: ''}}});
  const vault: ExternalVault = {available: true, encrypt: async value => 'fixture:' + Buffer.from(JSON.stringify(value)).toString('base64'), decrypt: async value => JSON.parse(Buffer.from(value.slice(8), 'base64').toString('utf8'))};
  const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3]);
  let providerCalls = 0;
  const services = new ExternalServices(wb, vault, (async (_url, init) => {
    providerCalls++;
    const body = JSON.parse(String(init?.body));
    assert.equal(body.images[0].image_url, 'data:image/png;base64,' + png.toString('base64'));
    return new Response(JSON.stringify({data: [{b64_json: png.toString('base64')}]}));
  }) as typeof fetch);
  const caller = {id: 'synthetic-image-grant', agent_id: 'codex', project_id: 'P-workbench', kind: 'bridge' as const, image_only: true};
  const server = createExternalImageServer((tool, input) => callExternalTool(services, tool, input, caller));
  const client = new Client({name: 'isolated-integration', version: '1'}), [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(b); await client.connect(a);
  try {
    const connection = await services.save({preset_id: 'openai-images', name: 'Synthetic images', model: 'fixture-only', enabled: true, allowed_project_ids: ['P-workbench'], allowed_agent_ids: ['codex'], allow_paid: true, secrets: {apiKey: 'SYNTHETIC_NOT_A_REAL_KEY'}});
    const localImage = path.join(f.directory, 'source.png'); fs.writeFileSync(localImage, png);
    const request_id = randomUUID(), args = {service_id: connection.id, request_id, prompt: 'isolated fixture only', images: [{image_url: localImage}]};
    const submission = await client.callTool({name: 'edit_image', arguments: args});
    const invocation = JSON.parse((submission.content as Array<{text: string}>)[0].text);
    await services.wait(invocation.invocation_id);
    const query = await client.callTool({name: 'get_image_invocation', arguments: {invocation_id: invocation.invocation_id}});
    const result = JSON.parse((query.content as Array<{text: string}>)[0].text);
    assert.equal(result.status, 'succeeded'); assert.equal(result.artifacts.length, 1);
    assert.deepEqual(fs.readFileSync(result.artifacts[0].path), png);
    const artifact = await client.callTool({name: 'get_image_artifact', arguments: {invocation_id: result.invocation_id, artifact_id: result.artifacts[0].id}});
    const image = (artifact.content as Array<{type: string; mimeType?: string; data?: string}>).find(block => block.type === 'image');
    assert(image, 'real ExternalServices artifact must produce an MCP image block');
    assert.equal(image.mimeType, 'image/png'); assert.equal(image.data, png.toString('base64'));
    await client.callTool({name: 'edit_image', arguments: args}); assert.equal(providerCalls, 1);
    assert.throws(() => services.get(result.invocation_id, {...caller, id: 'another-grant'}), /当前身份/);
    await assert.rejects(services.invoke({service_id: connection.id, request_id: randomUUID(), operation: 'chat', input: {prompt: 'denied'}}, caller), /仅允许生图/);
  } finally { await client.close(); await server.close(); wb.close(); }
});
