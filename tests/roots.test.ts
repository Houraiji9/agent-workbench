// 授权文件夹：只能由页面会话（带 CSRF）添加；拒绝整盘、主目录、数据目录、凭据位置；写入项目配置并立即生效。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { ROOT } from '../src/core/config.ts';
import { createApp } from '../src/server/app.ts';

async function setup() {
  const base = path.join(ROOT, '.test-tmp', '授权测试-' + crypto.randomUUID());
  const root = path.join(base, 'app'), inside = path.join(root, '已授权'), outside = path.join(base, '新项目');
  for (const d of [root, inside, outside, path.join(base, '.git')]) fs.mkdirSync(d, { recursive: true });
  fs.mkdirSync(path.join(root, 'config'), { recursive: true });
  fs.writeFileSync(path.join(root, 'config', 'local.json'), JSON.stringify({ port: 14399, timezone: 'UTC', authorizedRoots: [root], custom: 'keep' }));
  const config = { root, dataDir: path.join(root, 'data'), port: 14399, timezone: 'UTC', authorizedRoots: [root], integrations: { tokenMonitor: { baseUrl: '' }, agentsView: { baseUrl: '' } } };
  const { app, wb } = await createApp(config, { background: false });
  const boot = await app.inject({ method: 'GET', url: '/api/bootstrap', headers: { host: '127.0.0.1:14399' } });
  const cookie = String(boot.headers['set-cookie']).split(';')[0], csrf = boot.json().csrf;
  const post = (url: string, payload: unknown, withCsrf = true) => app.inject({ method: 'POST', url, payload: payload as object, headers: { host: '127.0.0.1:14399', cookie, ...(withCsrf ? { 'x-workbench-csrf': csrf } : {}) } });
  return { app, wb, config, root, inside, outside, base, post };
}

test('添加授权文件夹后可以登记项目；配置文件保留其他字段；重复授权不重复写入', async () => {
  const t = await setup();
  try {
    const before = await t.post('/api/projects', { name: '外部项目', path: t.outside });
    assert.equal(before.statusCode, 403);
    assert.match(before.json().error, /超出授权/);
    const add = await t.post('/api/settings/roots', { path: t.outside });
    assert.equal(add.statusCode, 200, add.body);
    assert.equal(add.json().added, fs.realpathSync.native(t.outside));
    const saved = JSON.parse(fs.readFileSync(path.join(t.root, 'config', 'local.json'), 'utf8'));
    assert.equal(saved.custom, 'keep');
    assert.equal(saved.authorizedRoots.length, 2);
    const project = await t.post('/api/projects', { name: '外部项目', path: t.outside });
    assert.equal(project.statusCode, 200, project.body);
    const again = await t.post('/api/settings/roots', { path: t.outside });
    assert.equal(again.json().added, null);
    const covered = await t.post('/api/settings/roots', { path: t.inside });
    assert.equal(covered.json().added, null);
    assert.ok(covered.json().covered_by);
    assert.equal(JSON.parse(fs.readFileSync(path.join(t.root, 'config', 'local.json'), 'utf8')).authorizedRoots.length, 2);
    const state = await t.app.inject({ method: 'GET', url: '/api/state', headers: { host: '127.0.0.1:14399', cookie: '' } });
    assert.equal(state.statusCode, 401, '没有页面会话不能读取');
  } finally { await t.app.close(); }
});

test('拒绝：无 CSRF、相对路径、不存在、整盘、主目录、数据目录、凭据目录、文件', async () => {
  const t = await setup();
  try {
    assert.equal((await t.post('/api/settings/roots', { path: t.outside }, false)).statusCode, 403);
    const bad = [
      ['relative/dir', /完整路径/],
      [path.join(t.base, '不存在'), /找不到/],
      [path.parse(t.base).root, /整个磁盘/],
      [os.homedir(), /主目录|系统/],
      [path.dirname(os.homedir()), /主目录|系统/],
      [path.join(t.root, 'data'), /数据目录/],
      [path.join(t.base, '.git'), /凭据|内部/],
      [path.join(t.root, 'config', 'local.json'), /文件夹/],
      ['', /完整路径/],
    ] as const;
    fs.mkdirSync(path.join(t.root, 'data'), { recursive: true });
    for (const [p, msg] of bad) {
      const r = await t.post('/api/settings/roots', { path: p });
      assert.equal(r.statusCode, 400, p + ' 应被拒绝：' + r.body);
      assert.match(r.json().error, msg, p);
    }
    assert.equal(JSON.parse(fs.readFileSync(path.join(t.root, 'config', 'local.json'), 'utf8')).authorizedRoots.length, 1);
    assert.equal(t.config.authorizedRoots.length, 1);
  } finally { await t.app.close(); }
});

test('F11/F12：精确创建和授权；拒绝凭据、父级范围、缺少 CSRF；失败不遗留配置或空目录', async () => {
 const t=await setup();try{
  const before=fs.readFileSync(path.join(t.root,'config/local.json'),'utf8');
  const denied=path.join(t.base,'未授权新目录');
  assert.equal((await t.post('/api/projects/authorize',{name:'测试',path:denied,create:true},false)).statusCode,403);assert.equal(fs.existsSync(denied),false);
  for(const name of ['.ssh','.aws','.gnupg','.kube']){
    const p=path.join(t.base,name);const r=await t.post('/api/projects/authorize',{name:'测试保护',path:p,create:true});assert.equal(r.statusCode,400,r.body);assert.equal(fs.existsSync(p),false);
  }
  if(process.platform==='win32')for(const name of ['.ssh.','.aws ']){
    const p=path.join(t.base,name);const r=await t.post('/api/projects/authorize',{name:'测试歧义目录',path:p,create:true});assert.equal(r.statusCode,400,r.body);assert.equal(fs.existsSync(p),false);
  }
  const failed=await t.post('/api/projects/authorize',{name:'',path:denied,create:true});assert.equal(failed.statusCode,400);assert.equal(fs.existsSync(denied),false);assert.equal(fs.readFileSync(path.join(t.root,'config/local.json'),'utf8'),before);
  const child=path.join(t.base,'准确新项目');const r=await t.post('/api/projects/authorize',{name:'准确范围测试',path:child,create:true});assert.equal(r.statusCode,200,r.body);
  assert.ok(fs.statSync(child).isDirectory());assert.ok(t.config.authorizedRoots.includes(child));assert.ok(!t.config.authorizedRoots.includes(t.base));
  assert.equal((await t.post('/api/projects',{name:'同级未授权',path:t.outside})).statusCode,403);
  const saved=JSON.parse(fs.readFileSync(path.join(t.root,'config/local.json'),'utf8'));assert.equal(saved.custom,'keep');assert.deepEqual(saved.authorizedRoots,t.config.authorizedRoots);
 }finally{await t.app.close()}
});
