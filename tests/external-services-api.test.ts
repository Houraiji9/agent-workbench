import {test, type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {createApp} from '../src/server/app.ts';
import type {ExternalVault} from '../src/core/external-vault.ts';
import {fixture, setup} from './helpers.ts';

// The vault and provider are synthetic, isolated dependencies. These tests verify
// HTTP authorization and public projections; DPAPI/provider integration is tested separately.
async function routeFixture(t: TestContext) {
  const f = fixture(); f.wb.close();
  const runtime = await createApp(f.config, {background: false});
  t.after(() => runtime.app.close());
  const envelopes = new Map<string, Record<string, string>>();
  const vault: ExternalVault = {
    available: true,
    async encrypt(value) { const id = 'fixture-sealed:' + crypto.randomUUID(); envelopes.set(id, structuredClone(value)); return id; },
    async decrypt(id) { const value = envelopes.get(id); assert(value, 'Unknown synthetic vault envelope'); return structuredClone(value); },
  };
  const requests: {url: string; headers: Headers; body: any}[] = [];
  const fetcher: typeof fetch = async (input, init) => {
    const url = String(input), headers = new Headers(init?.headers), body = JSON.parse(String(init?.body || '{}'));
    assert.equal(new URL(url).hostname, 'fixture.invalid', 'No external network is allowed in this fixture');
    requests.push({url, headers, body});
    const secret = headers.get('authorization')?.replace(/^Bearer /, '') || '';
    if (url.includes('/images/')) return Response.json({data: [{b64_json: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aP9sAAAAASUVORK5CYII='}]});
    return Response.json({choices: [{message: {content: `Synthetic provider result; echoed credential ${secret}`}}], usage: {total_tokens: 1}});
  };
  Object.defineProperty(runtime.externalServices, 'vault', {value: vault});
  Object.defineProperty(runtime.externalServices, 'fetcher', {value: fetcher});
  const host = '127.0.0.1:' + f.config.port;
  const boot = await runtime.app.inject({url: '/api/bootstrap', headers: {host}});
  assert.equal(boot.statusCode, 200);
  const cookie = String(boot.headers['set-cookie']).split(';')[0], csrf = boot.json().csrf;
  const pageHeaders = {host, cookie, 'x-workbench-csrf': csrf};
  const page = (url: string, body?: unknown) => runtime.app.inject({url: '/api' + url, method: body === undefined ? 'GET' : 'POST', headers: pageHeaders, ...(body === undefined ? {} : {payload: body as object})});
  const mcp = (tool: string, body: object, token = runtime.wb.keys.manager) => runtime.app.inject({url: '/api/mcp/' + tool, method: 'POST', headers: {host, authorization: 'Bearer ' + token}, payload: body});
  const otherRoot = path.join(f.root, 'other-project'); fs.mkdirSync(otherRoot);
  const other = runtime.wb.registerProject({name: '测试外部调用第二项目', path: otherRoot});
  const save = async (extra: Record<string, unknown> = {}) => {
    const res = await page('/external-services/save', {
      preset_id: 'custom-openai-chat', name: '测试外部服务', base_url: 'https://fixture.invalid/v1', model: 'fixture-model',
      enabled: true, allow_paid: true, allowed_project_ids: ['P-workbench'], allowed_agent_ids: ['manager'],
      secrets: {apiKey: 'fixture-key-' + crypto.randomUUID()}, ...extra,
    });
    assert.equal(res.statusCode, 200, res.body); return res.json();
  };
  const invoke = (serviceId: string, extra: Record<string, unknown> = {}) => ({service_id: serviceId, project_id: 'P-workbench', operation: 'chat', input: {prompt: 'isolated fixture'}, request_id: crypto.randomUUID(), ...extra});
  return {...f, ...runtime, host, cookie, csrf, pageHeaders, page, mcp, save, invoke, vault, requests, other};
}

test('external service page writes require CSRF; public connection, snapshot and calling card never return credentials', async t => {
  const f = await routeFixture(t), secret = 'fixture-secret-private-' + crypto.randomUUID();
  const body = {preset_id: 'custom-openai-chat', name: '测试保密连接', base_url: 'https://fixture.invalid/v1', model: 'fixture-model', secrets: {apiKey: secret}};
  const noSession = await f.app.inject({url: '/api/external-services/save', method: 'POST', headers: {host: f.host}, payload: body});
  assert.equal(noSession.statusCode, 401);
  const noCsrf = await f.app.inject({url: '/api/external-services/save', method: 'POST', headers: {host: f.host, cookie: f.cookie}, payload: body});
  assert.equal(noCsrf.statusCode, 403);
  const badCsrf = await f.app.inject({url: '/api/external-services/save', method: 'POST', headers: {host: f.host, cookie: f.cookie, 'x-workbench-csrf': 'wrong'}, payload: body});
  assert.equal(badCsrf.statusCode, 403);
  assert.equal(f.externalServices.snapshot().connections.length, 0);
  const saved = await f.page('/external-services/save', body);
  assert.equal(saved.statusCode, 200, saved.body);
  const c = saved.json(); assert.equal(c.credential_configured, true); assert.deepEqual(c.credential_fields, ['apiKey']);
  const snapshot = await f.page('/external-services'), calling = await f.page(`/external-services/${c.id}/calling`);
  for (const reply of [saved, snapshot, calling]) {
    assert.equal(reply.statusCode, 200, reply.body);
    assert(!reply.body.includes(secret)); assert(!reply.body.includes('fixture-sealed:'));
  }
  assert.equal('secrets' in c, false); assert.equal('secret_cipher' in c, false);
  const row = f.wb.db.prepare('SELECT data,secret_cipher FROM external_connections WHERE id=?').get(c.id) as any;
  assert(!row.data.includes(secret)); assert(!row.secret_cipher.includes(secret));
  const mixedIdentity = await f.app.inject({url: '/api/external-services/save', method: 'POST', headers: {...f.pageHeaders, authorization: 'Bearer ' + f.wb.keys.manager}, payload: body});
  assert.equal(mixedIdentity.statusCode, 403);
  assert.equal((await f.app.inject({url: '/api/external-services', headers: {host: f.host}})).statusCode, 401);
  assert.equal(f.requests.length, 0, 'Saving/configuring must not issue provider requests');
});

test('manager discovery and invocation obey both project and Agent scopes, and never bypass paid-call opt-in', async t => {
  const f = await routeFixture(t);
  const manager = await f.save({name: '测试管理连接', allow_paid: false});
  const codex = await f.save({name: '测试Codex专属', allowed_agent_ids: ['codex']});
  const elsewhere = await f.save({name: '测试其他项目', allowed_project_ids: [f.other.id]});
  const result = await f.mcp('list_external_services', {project_id: 'P-workbench'});
  assert.equal(result.statusCode, 200, result.body); assert.deepEqual(result.json().services.map((s: any) => s.id), [manager.id]);
  assert.deepEqual((await f.mcp('list_external_services', {project_id: f.other.id})).json().services.map((s: any) => s.id), [elsewhere.id]);
  assert.deepEqual((await f.mcp('list_external_services', {})).json().services, []);
  assert.equal((await f.mcp('get_external_calling', {service_id: codex.id, project_id: 'P-workbench'})).statusCode, 403);
  assert.equal((await f.mcp('invoke_external_service', f.invoke(codex.id))).statusCode, 403);
  assert.equal((await f.mcp('invoke_external_service', f.invoke(manager.id, {project_id: f.other.id}))).statusCode, 403);
  const paid = await f.mcp('invoke_external_service', f.invoke(manager.id));
  assert.equal(paid.statusCode, 403); assert.match(paid.json().error, /未允许生成\/消费/);
  assert.equal(f.requests.length, 0);
  const update = await f.page('/external-services/save', {id: manager.id, version: manager.version, allow_paid: true});
  assert.equal(update.statusCode, 200, update.body);
  const invoked = await f.mcp('invoke_external_service', f.invoke(manager.id));
  assert.equal(invoked.statusCode, 200, invoked.body);
  const done = await f.externalServices.wait(invoked.json().invocation_id);
  assert.equal(done.status, 'succeeded'); assert.equal(done.agent_id, 'manager'); assert.equal(done.caller_id, 'manager');
  assert.equal(f.requests.length, 1);
  const queried = await f.mcp('get_external_invocation', {invocation_id: done.id});
  assert.equal(queried.statusCode, 200, queried.body); assert.match(queried.json().text, /已脱敏/);
  assert(!queried.body.includes(f.requests[0].headers.get('authorization')!.slice(7)));
  assert.equal((await f.mcp('list_external_services', {project_id: 'P-workbench'}, f.wb.keys.planner)).statusCode, 403);
});

test('runner routes derive Agent identity from Run credentials and reject spoofed identity, cross-project use and other Runs', async t => {
  const f = await routeFixture(t), run = setup(f.wb, f.root), anotherRun = setup(f.wb, f.root);
  const token = JSON.parse(fs.readFileSync(path.join(f.config.dataDir, 'run-keys', run.rid + '.json'), 'utf8')).token;
  const mine = await f.save({name: '测试当前执行专属', allowed_agent_ids: ['codex']});
  const manager = await f.save({name: '测试管理者专属'});
  const otherProject = await f.save({name: '测试跨项目执行', allowed_agent_ids: ['codex'], allowed_project_ids: [f.other.id]});
  const listed = await f.mcp('list_external_services', {run_id: run.rid}, token);
  assert.equal(listed.statusCode, 200, listed.body); assert.deepEqual(listed.json().services.map((s: any) => s.id), [mine.id]);
  const body = f.invoke(mine.id, {run_id: run.rid});
  assert.equal((await f.mcp('invoke_external_service', {...body, agent_id: 'manager'}, token)).statusCode, 400);
  assert.equal((await f.mcp('invoke_external_service', {...body, service_id: manager.id}, token)).statusCode, 403);
  assert.equal((await f.mcp('invoke_external_service', {...body, project_id: f.other.id}, token)).statusCode, 403);
  assert.equal((await f.mcp('invoke_external_service', {...body, service_id: otherProject.id, project_id: f.other.id}, token)).statusCode, 403);
  assert.equal((await f.mcp('list_external_services', {run_id: anotherRun.rid}, token)).statusCode, 401);
  assert.equal(f.requests.length, 0);
  const good = await f.mcp('invoke_external_service', body, token);
  assert.equal(good.statusCode, 200, good.body);
  const done = await f.externalServices.wait(good.json().invocation_id);
  assert.equal(done.status, 'succeeded'); assert.equal(done.agent_id, 'codex'); assert.equal(done.run_id, run.rid);
  assert.equal(done.project_id, 'P-workbench'); assert.equal(done.caller_id, 'runner:' + run.rid);
  const queried = await f.mcp('get_external_invocation', {run_id: run.rid, invocation_id: done.id}, token);
  assert.equal(queried.statusCode, 200, queried.body);
  assert.equal((await f.mcp('get_external_invocation', {invocation_id: done.id})).statusCode, 403, 'Manager tool identity does not own a runner invocation');
});

test('image bridge grants cannot manage connections, invoke chat, cross projects, or read another caller result/artifact', async t => {
  const f = await routeFixture(t);
  const image = await f.save({preset_id: 'openai-images', name: '测试生图连接', allowed_agent_ids: ['deepseek', 'manager']});
  const chat = await f.save({name: '测试聊天连接', allowed_agent_ids: ['deepseek']});
  const outsideGrant = await f.page('/external-services/harness-grant', {project_id: 'P-workbench', agent_id: 'deepseek', credential_path: path.join(f.config.dataDir, 'fixture-image-grant.json')});
  assert.equal(outsideGrant.statusCode, 403);
  const grantInput = {project_id: 'P-workbench', agent_id: 'deepseek', credential_path: path.join(f.config.dataDir, 'external-tools', 'harness-image-bridge.json')};
  const grant = await f.page('/external-services/harness-grant', grantInput);
  assert.equal(grant.statusCode, 200, grant.body);
  const envelope = JSON.parse(fs.readFileSync(grant.json().path, 'utf8'));
  const {token} = await f.vault.decrypt(envelope.protected_token);
  assert(!grant.body.includes(token));
  const imageInput = f.invoke(image.id, {operation: 'image.generate'});
  assert.equal((await f.mcp('get_management_context', {project_id: 'P-workbench'}, token)).statusCode, 403);
  assert.equal((await f.mcp('invoke_external_service', f.invoke(chat.id), token)).statusCode, 403);
  assert.equal((await f.mcp('invoke_external_service', {...imageInput, project_id: f.other.id}, token)).statusCode, 403);
  assert.equal((await f.app.inject({url: '/api/external-services/save', method: 'POST', headers: {...f.pageHeaders, authorization: 'Bearer ' + token}, payload: {id: image.id, version: image.version, enabled: false}})).statusCode, 403);
  const managerCall = await f.mcp('invoke_external_service', imageInput);
  assert.equal(managerCall.statusCode, 200, managerCall.body);
  const managerDone = await f.externalServices.wait(managerCall.json().invocation_id);
  assert.equal(managerDone.status, 'succeeded'); assert.equal(managerDone.artifacts.length, 1);
  assert.equal((await f.mcp('get_external_invocation', {invocation_id: managerDone.id}, token)).statusCode, 403);
  assert.equal((await f.mcp('get_external_artifact', {invocation_id: managerDone.id, artifact_id: managerDone.artifacts[0].id}, token)).statusCode, 403);
  const own = await f.mcp('invoke_external_service', {...imageInput, request_id: crypto.randomUUID()}, token);
  assert.equal(own.statusCode, 200, own.body);
  const ownDone = await f.externalServices.wait(own.json().invocation_id);
  assert.equal(ownDone.status, 'succeeded'); assert.equal(ownDone.agent_id, 'deepseek'); assert.equal(ownDone.caller_id, grant.json().id);
  const artifact = await f.mcp('get_external_artifact', {invocation_id: ownDone.id, artifact_id: ownDone.artifacts[0].id}, token);
  assert.equal(artifact.statusCode, 200, artifact.body); assert(fs.existsSync(artifact.json().path));
  const edit = await f.mcp('invoke_external_service', f.invoke(image.id, {operation: 'image.edit', input: {prompt: 'edit fixture', images: [{file_id: 'file-fixture-image'}]}}), token);
  assert.equal(edit.statusCode, 200, edit.body); assert.equal((await f.externalServices.wait(edit.json().invocation_id)).status, 'succeeded');
  assert.equal(f.requests.length, 3, 'Only the explicitly permitted synthetic image requests were sent');
  const replacement = await f.page('/external-services/harness-grant', grantInput);
  assert.equal(replacement.statusCode, 200, replacement.body);
  assert.equal((await f.mcp('list_external_services', {}, token)).statusCode, 401, 'Reissuing the bridge file revokes its old token');
});

test('revoking credentials preserves the configured route and scopes, rejects stale versions, and clears only stored secrets', async t => {
  const f = await routeFixture(t), secret = 'fixture-revoke-key-' + crypto.randomUUID();
  const c = await f.save({name: '测试撤销连接', region: 'global', model: 'fixture-model-custom', timeout_ms: 42000, profile: 'fixture-profile', daily_call_limit: 7, allowed_project_ids: ['P-workbench', f.other.id], allowed_agent_ids: ['manager', 'codex'], secrets: {apiKey: secret}});
  const stale = await f.page('/external-services/save', {id: c.id, version: c.version + 1, wipe_secrets: true});
  assert.equal(stale.statusCode, 409);
  const saved = await f.page('/external-services/save', {id: c.id, version: c.version, enabled: false, wipe_secrets: true});
  assert.equal(saved.statusCode, 200, saved.body);
  const next = saved.json();
  for (const key of ['name', 'preset_id', 'base_url', 'model', 'region', 'timeout_ms', 'profile', 'daily_call_limit', 'allowed_project_ids', 'allowed_agent_ids', 'allow_paid']) assert.deepEqual(next[key], c[key], key);
  assert.equal(next.enabled, false); assert.equal(next.credential_configured, false); assert.deepEqual(next.credential_fields, []);
  assert.equal(next.version, c.version + 1);
  const row = f.wb.db.prepare('SELECT secret_cipher FROM external_connections WHERE id=?').get(c.id) as any;
  assert.equal(row.secret_cipher, null);
  for (const reply of [saved, await f.page('/external-services'), await f.page(`/external-services/${c.id}/calling`)]) assert(!reply.body.includes(secret));
  assert.equal(f.requests.length, 0);
});
