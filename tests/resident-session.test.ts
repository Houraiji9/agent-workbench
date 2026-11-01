import test from 'node:test';
import assert from 'node:assert/strict';
import {createPageApi} from '../src/web/api.ts';
import {createApp} from '../src/server/app.ts';
import {fixture} from './helpers.ts';

test('真实 Fastify 会话超过 12 小时：401 在写入前拒绝，页面自动续期后只保存一份需求', async t => {
  const f = fixture(); f.wb.close();
  const {app, wb} = await createApp(f.config, {background: false});
  const host = '127.0.0.1:' + f.config.port;
  let cookie = '', bootstraps = 0;
  const statuses: number[] = [];
  const client = createPageApi(async (url, options) => {
    if (url === '/api/bootstrap') bootstraps++;
    const response = await app.inject({url: String(url), method: options?.method === 'POST' ? 'POST' : 'GET', headers: {
      host, cookie, ...Object.fromEntries(new Headers(options?.headers)),
    }, payload: options?.body as string | undefined});
    if (response.headers['set-cookie']) cookie = String(response.headers['set-cookie']).split(';')[0];
    statuses.push(response.statusCode);
    return new Response(response.body, {status: response.statusCode});
  });
  try {
    await client.api('/bootstrap');
    const before = wb.all('requests').length;
    const now = Date.now(); t.mock.method(Date, 'now', () => now + 13 * 3600000);
    const rejected = await app.inject({url: '/api/requests', method: 'POST', headers: {host, cookie}, payload: {project_id: 'P-workbench', text: '过期会话不能写入'}});
    assert.equal(rejected.statusCode, 401); assert.equal(wb.all('requests').length, before);
    await Promise.all([client.api('/state'), client.api('/requests', {project_id: 'P-workbench', text: '驻留后续期保存'})]);
    assert.equal(bootstraps, 2); assert.equal(wb.all('requests').length, before + 1);
    assert.equal(wb.all('requests').filter(q => q.text === '驻留后续期保存').length, 1);
    assert.ok(statuses.includes(401)); assert.equal((await client.api('/state')).requests.length, before + 1);
  } finally { t.mock.restoreAll(); await app.close(); }
});

test('403、业务失败及已续期后仍 401 都不循环重放', async () => {
  for (const status of [403, 409, 401]) {
    let writes = 0, boots = 0;
    const client = createPageApi(async url => {
      if (url === '/api/bootstrap') { boots++; return Response.json({csrf: 'renewed'}); }
      writes++; return Response.json({error: '保留后台错误'}, {status});
    });
    await assert.rejects(client.api('/requests', {text: 'synthetic'}), /保留后台错误/);
    assert.equal(writes, status === 401 ? 2 : 1); assert.equal(boots, status === 401 ? 1 : 0);
  }
});

test('续期永久挂起也有界并允许再次恢复；旧响应不得替换新 CSRF', async () => {
  let calls = 0, late!: (value: Response) => void;
  const client = createPageApi(async (url, options) => {
    if (url === '/api/bootstrap') {
      if (++calls === 1) return new Promise<Response>(resolve => { late = resolve; });
      return Response.json({csrf: 'new-token'});
    }
    assert.equal(new Headers(options?.headers).get('x-workbench-csrf'), 'new-token');
    return Response.json({saved: true});
  }, 25);
  await assert.rejects(client.api('/bootstrap'), /超时/);
  await client.api('/bootstrap'); late(Response.json({csrf: 'late-old-token'}));
  await new Promise<void>(r => setImmediate(r));
  assert.equal((await client.api('/requests', {})).saved, true);
});

test('迟到的旧 401 复用已经更新的凭据；主动取消的写入不重放', async () => {
  let release!: () => void, renewals = 0, writes = 0;
  const delayed = new Promise<void>(resolve => { release = resolve; });
  const controller = new AbortController();
  const client = createPageApi(async (url, options) => {
    if (url === '/api/bootstrap') { renewals++; return Response.json({csrf: 'fresh'}); }
    const token = new Headers(options?.headers).get('x-workbench-csrf');
    if (url === '/api/slow' && token !== 'fresh') { await delayed; return Response.json({}, {status: 401}); }
    if (url === '/api/cancel') { writes++; controller.abort(); return Response.json({}, {status: 401}); }
    return Response.json({}, {status: token === 'fresh' ? 200 : 401});
  });
  const slow = client.api('/slow', {});
  await client.api('/fast', {}); release(); await slow;
  assert.equal(renewals, 1);
  await assert.rejects(client.api('/cancel', {}, controller.signal), {name: 'AbortError'});
  assert.equal(writes, 1);
});
