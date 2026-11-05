import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {randomUUID, createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {acquireCursorReviewPermission as acquire, releaseCursorReviewPermission as release, listCursorReviewPermissions as list, assertCursorReviewPermission as check} from '../src/core/cursor-review-permissions.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '.test-tmp', 'cursor-review-permissions');
const job = () => 'AJ-' + randomUUID();
const token = (id: string) => `Shell(node:.workbench-review-checks/${id}/verify.mjs)`;
function fixture(original?: string) {
  fs.mkdirSync(root, {recursive: true});
  const base = fs.mkdtempSync(path.join(root, 'fixture-')), workspace = path.join(base, '中文 项目'), stateDir = path.join(base, 'private-state'), retentionDir = path.join(workspace, '.workbench-review-checks', 'retained-permissions');
  fs.mkdirSync(workspace); const configFile = path.join(workspace, '.cursor', 'cli.json');
  if (original !== undefined) {fs.mkdirSync(path.dirname(configFile)); fs.writeFileSync(configFile, original);}
  const options = (jobId: string) => ({workspace, stateDir, retentionDir, jobId, token: token(jobId)});
  const hash = createHash('sha256').update(process.platform === 'win32' ? workspace.toLowerCase() : workspace).digest('hex');
  return {base, workspace, stateDir, retentionDir, configFile, options, registryFile: path.join(stateDir, hash, 'registry.json'), lockFile: path.join(stateDir, hash, 'lease.lock')};
}
function read(file: string) {return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));}
function writeConfig(file: string, value: unknown) {fs.writeFileSync(file, JSON.stringify(value, null, 4) + '\r\n');}

test('existing BOM/CRLF project JSON, deny rules and unrelated fields survive a lease and return byte-for-byte', () => {
  const original = '\uFEFF{\r\n\t"name" : "合成项目",\r\n\t"privateFixture" : "synthetic-not-for-output",\r\n\t"permissions" : {"deny": ["Shell(rm)", "Write(**/*.key)"], "allow" : [ "Shell(ls)" ]},\r\n\t"nested": {"keep": [1, true, null]}\r\n}\r\n';
  const f = fixture(original), id = job(), result = acquire(f.options(id));
  assert.equal(result.added, true); assert.equal(result.leaseCount, 1);
  const configured = read(f.configFile);
  assert.deepEqual(configured.permissions.allow, ['Shell(ls)', token(id)]);
  assert.deepEqual(configured.permissions.deny, ['Shell(rm)', 'Write(**/*.key)']);
  assert.deepEqual(configured.nested, {keep: [1, true, null]});
  assert(fs.readFileSync(f.configFile, 'utf8').includes('"privateFixture" : "synthetic-not-for-output"'));
  assert(!JSON.stringify([result, list(f)]).includes('synthetic-not-for-output'));
  check(f.options(id)); const released = release(f.options(id));
  assert.equal(released.restoredOriginal, true); assert.equal(fs.readFileSync(f.configFile, 'utf8'), original);
  assert.deepEqual(list(f), []); assert.equal(release(f.options(id)).released, false);
});

test('an originally absent config is moved to retention after the last lease; the .cursor directory remains', () => {
  const f = fixture(), id = job(); acquire(f.options(id));
  assert.deepEqual(read(f.configFile).permissions, {allow: [token(id)], deny: []});
  const result = release(f.options(id));
  assert.equal(result.restoredOriginal, true); assert(!fs.existsSync(f.configFile)); assert(fs.statSync(path.dirname(f.configFile)).isDirectory());
  assert(result.retainedConfigPath?.startsWith(f.retentionDir + path.sep));
  assert.deepEqual(read(result.retainedConfigPath!).permissions, {allow: [token(id)], deny: []});
  assert.equal(release(f.options(id)).released, false);
});

test('missing allow or deny arrays are supplied for the Cursor schema while original metadata and bytes are restored', () => {
  const id = job();
  for (const permission of [
    {metadata: {keep: 'empty permissions'}},
    {metadata: {keep: 'allow only'}, allow: ['Shell(ls)']},
    {metadata: {keep: 'deny only'}, deny: ['Shell(rm)', 'Write(**/*.key)']},
    {metadata: {keep: 'user token'}, allow: [token(id)]},
  ]) {
    const original = '\uFEFF' + JSON.stringify({name: '已有项目', permissions: permission, keep: {enabled: false}}, null, '\t').replace(/\n/g, '\r\n') + '\r\n';
    const f = fixture(original), result = acquire(f.options(id)), configured = read(f.configFile);
    assert.deepEqual(configured.permissions.allow, [...(permission.allow || []), ...(permission.allow?.includes(token(id)) ? [] : [token(id)])]);
    assert.deepEqual(configured.permissions.deny, permission.deny || []);
    assert.deepEqual(configured.permissions.metadata, permission.metadata);
    assert.equal(configured.name, '已有项目'); assert.deepEqual(configured.keep, {enabled: false});
    assert.equal(result.added, !permission.allow?.includes(token(id)));
    check(f.options(id));
    assert.equal(release(f.options(id)).restoredOriginal, true);
    assert.equal(fs.readFileSync(f.configFile, 'utf8'), original);
  }
});

test('multiple jobs have independent exact tokens; reacquire is idempotent and releasing one leaves the other usable', () => {
  const f = fixture('{"existing":true}\n'), first = job(), second = job();
  acquire(f.options(first)); acquire(f.options(second));
  assert.equal(acquire(f.options(first)).leaseCount, 2);
  assert.deepEqual(read(f.configFile).permissions.allow, [token(first), token(second)]);
  assert.equal(list(f).length, 2);
  release(f.options(first)); check(f.options(second)); assert.deepEqual(read(f.configFile).permissions.allow, [token(second)]);
  assert.throws(() => check(f.options(first)), /没有有效权限租约/);
  release(f.options(second)); assert.equal(fs.readFileSync(f.configFile, 'utf8'), '{"existing":true}\n');
});

test('a token already present belongs to the user and is never revoked, including duplicate occurrences', () => {
  const id = job(), original = JSON.stringify({permissions: {allow: [token(id), token(id), 'Shell(ls)'], deny: []}}), f = fixture(original);
  assert.equal(acquire(f.options(id)).added, false); check(f.options(id));
  assert.equal(fs.readFileSync(f.configFile, 'utf8'), original);
  release(f.options(id)); assert.equal(fs.readFileSync(f.configFile, 'utf8'), original);
});

test('concurrent user changes and a duplicate user token survive removal of only the workbench-owned occurrence', () => {
  const f = fixture(), first = job(), second = job(); acquire(f.options(first)); acquire(f.options(second));
  const changed = read(f.configFile); changed.userSetting = {keep: 'user-edited'}; changed.permissions.allow.push(token(first), 'Shell(git:status)'); changed.permissions.deny = ['Shell(node:other-script.mjs)']; writeConfig(f.configFile, changed);
  release(f.options(first));
  assert.deepEqual(read(f.configFile).permissions.allow, [token(second), token(first), 'Shell(git:status)']);
  release(f.options(second));
  const final = read(f.configFile); assert.deepEqual(final.permissions.allow, [token(first), 'Shell(git:status)']);
  assert.deepEqual(final.permissions.deny, changed.permissions.deny); assert.deepEqual(final.userSetting, changed.userSetting);
  assert(fs.readFileSync(f.configFile, 'utf8').includes('    "userSetting"')); assert.deepEqual(list(f), []);
});

test('pre-spawn checks respect user revocation and new deny rules without granting again', () => {
  const f = fixture(), id = job(); acquire(f.options(id));
  writeConfig(f.configFile, {permissions: {allow: [], deny: []}, edited: true});
  const removed = fs.readFileSync(f.configFile, 'utf8');
  assert.throws(() => check(f.options(id)), /已被用户撤销/);
  assert.throws(() => acquire(f.options(id)), /未自动重新授权/);
  assert.equal(fs.readFileSync(f.configFile, 'utf8'), removed);
  release(f.options(id)); assert.deepEqual(read(f.configFile), {permissions: {allow: [], deny: []}, edited: true});
  const next = job(); acquire(f.options(next)); const cfg = read(f.configFile); cfg.permissions.deny = ['Shell(node)']; writeConfig(f.configFile, cfg);
  assert.throws(() => check(f.options(next)), /deny/); release(f.options(next));
  assert.deepEqual(read(f.configFile).permissions, {allow: [], deny: ['Shell(node)']});
});

test('wildcards, extra arguments, another job path and alternate interpreters cannot become permission tokens', () => {
  const f = fixture(), id = job();
  for (const candidate of ['Shell(*)', 'Shell(node)', 'Shell(node:*)', token(job()), token(id).replace('node:', 'powershell:'), token(id).replace('verify.mjs)', 'verify.mjs --apply)'), token(id).replace('verify.mjs)', 'verify.mjs;calc)')]) {
    assert.throws(() => acquire({...f.options(id), token: candidate}), /固定无参数/);
  }
  assert(!fs.existsSync(f.configFile)); assert(!fs.existsSync(f.stateDir));
});

test('project deny patterns win; malformed JSON and permission shapes fail without overwriting user data', () => {
  const id = job();
  for (const deny of ['Shell(node)', 'Shell(*)', 'Shell(n?de:*)', 'Shell(node:.workbench-review-checks/**)', token(id)]) {
    const original = JSON.stringify({permissions: {allow: [], deny: [deny]}}), f = fixture(original);
    assert.throws(() => acquire(f.options(id)), /deny/); assert.equal(fs.readFileSync(f.configFile, 'utf8'), original); assert.deepEqual(list(f), []);
  }
  for (const original of ['{', '{"permissions":null}', '{"permissions":{"allow":"*"}}', '{"permissions":{"deny":[1]}}', '{"permissions":{},"permissions":{}}']) {
    const f = fixture(original); assert.throws(() => acquire(f.options(job()))); assert.equal(fs.readFileSync(f.configFile, 'utf8'), original);
  }
});

test('a failure before a grant remains prepared and can be cleaned without granting or changing the original', () => {
  const original = '{"permissions":{"allow":["Shell(ls)"]}}', f = fixture(original), id = job(), write = fs.writeFileSync;
  fs.writeFileSync = ((file: any, ...args: any[]) => {
    // writeNew opens its destination first; fail only when the next snapshot is written.
    if (typeof file === 'number' && fs.existsSync(f.registryFile)) {
      const state = read(f.registryFile);
      if (state.pending && fs.readdirSync(f.retentionDir).some(name => name.endsWith('-next.json'))) throw Error('synthetic interruption before grant');
    }
    return (write as any)(file, ...args);
  }) as typeof fs.writeFileSync;
  try {assert.throws(() => acquire(f.options(id)), /synthetic interruption/);} finally {fs.writeFileSync = write;}
  assert.equal(fs.readFileSync(f.configFile, 'utf8'), original);
  assert.equal(list(f)[0].phase, 'prepared');
  release(f.options(id)); assert.equal(fs.readFileSync(f.configFile, 'utf8'), original); assert.deepEqual(list(f), []);
});

test('a crash after the project grant is recovered from disk and revoked by a new Node process', () => {
  const f = fixture(), id = job(), copy = fs.copyFileSync;
  fs.copyFileSync = ((source: fs.PathLike, target: fs.PathLike, mode?: number) => {copy(source, target, mode); if (String(target) === f.configFile) throw Error('synthetic crash after grant');}) as typeof fs.copyFileSync;
  try {assert.throws(() => acquire(f.options(id)), /synthetic crash/);} finally {fs.copyFileSync = copy;}
  assert.deepEqual(read(f.configFile).permissions.allow, [token(id)]); assert.equal(list(f)[0].phase, 'prepared');
  const moduleUrl = pathToFileURL(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src/core/cursor-review-permissions.ts')).href;
  const script = `import {releaseCursorReviewPermission} from ${JSON.stringify(moduleUrl)}; console.log(JSON.stringify(releaseCursorReviewPermission(${JSON.stringify(f.options(id))})));`;
  const child = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], {cwd: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'), env: {...process.env, TEMP: f.base, TMP: f.base}, encoding: 'utf8', windowsHide: true, shell: false});
  assert.equal(child.status, 0, child.stderr); assert.equal(JSON.parse(child.stdout).released, true);
  assert(!fs.existsSync(f.configFile)); assert.deepEqual(list(f), []);
});

test('interruption after moving the original but before granting restores the original during cleanup', () => {
  const original = '{ "user": "keep", "permissions": {"allow": []} }\r\n', f = fixture(original), id = job(), copy = fs.copyFileSync;
  fs.copyFileSync = ((source: fs.PathLike, target: fs.PathLike, mode?: number) => {if (String(target) === f.configFile) throw Error('synthetic copy interruption'); copy(source, target, mode);}) as typeof fs.copyFileSync;
  try {assert.throws(() => acquire(f.options(id)), /synthetic copy interruption/);} finally {fs.copyFileSync = copy;}
  assert(!fs.existsSync(f.configFile)); assert.equal(list(f)[0].phase, 'prepared');
  release(f.options(id)); assert.equal(fs.readFileSync(f.configFile, 'utf8'), original); assert.deepEqual(list(f), []);
});

test('a user save racing the config move is restored and later cleanup preserves that edit', () => {
  const f = fixture('{"user":"before"}'), id = job(), rename = fs.renameSync;
  fs.renameSync = ((from: fs.PathLike, to: fs.PathLike) => {if (String(from) === f.configFile) fs.writeFileSync(f.configFile, '{"user":"concurrent"}'); rename(from, to);}) as typeof fs.renameSync;
  try {assert.throws(() => acquire(f.options(id)), /配置发生变化/);} finally {fs.renameSync = rename;}
  assert.deepEqual(read(f.configFile), {user: 'concurrent'}); release(f.options(id));
  assert.deepEqual(read(f.configFile), {user: 'concurrent'}); assert.deepEqual(list(f), []);
});

test('a failure during release keeps durable releasing intent and repeated cleanup is idempotent', () => {
  const f = fixture(), id = job(); acquire(f.options(id)); const rename = fs.renameSync;
  fs.renameSync = ((from: fs.PathLike, to: fs.PathLike) => {rename(from, to); if (String(from) === f.configFile) throw Error('synthetic crash after revoke move');}) as typeof fs.renameSync;
  try {assert.throws(() => release(f.options(id)), /synthetic crash/);} finally {fs.renameSync = rename;}
  assert(!fs.existsSync(f.configFile)); assert.equal(list(f)[0].phase, 'releasing');
  assert.equal(release(f.options(id)).released, false); assert.deepEqual(list(f), []); assert.equal(release(f.options(id)).released, false);
});

test('a crash immediately after moving concurrent user bytes restores them instead of accepting an absent config', () => {
  const f = fixture(), id = job(); acquire(f.options(id)); const rename = fs.renameSync;
  fs.renameSync = ((from: fs.PathLike, to: fs.PathLike) => {
    if (String(from) === f.configFile) {const latest = read(f.configFile); latest.userSavedAtLastMoment = true; writeConfig(f.configFile, latest); rename(from, to); throw Error('synthetic concurrent move crash');}
    rename(from, to);
  }) as typeof fs.renameSync;
  try {assert.throws(() => release(f.options(id)), /synthetic concurrent move crash/);} finally {fs.renameSync = rename;}
  assert(!fs.existsSync(f.configFile)); release(f.options(id));
  assert.equal(read(f.configFile).userSavedAtLastMoment, true); assert.deepEqual(read(f.configFile).permissions.allow, []); assert.deepEqual(list(f), []);
});

test('a live registry lock rejects concurrent writers; corrupt registry does not authorize or overwrite config', () => {
  const f = fixture(), id = job(); acquire(f.options(id));
  fs.writeFileSync(f.lockFile, JSON.stringify({pid: process.pid, nonce: randomUUID()}));
  assert.throws(() => acquire(f.options(job())), /正在更新/); check(f.options(id));
  fs.renameSync(f.lockFile, path.join(path.dirname(f.lockFile), 'test-held-lock.json'));
  const before = fs.readFileSync(f.configFile, 'utf8'); fs.writeFileSync(f.registryFile, '{');
  assert.throws(() => release(f.options(id)), /状态记录损坏/); assert.equal(fs.readFileSync(f.configFile, 'utf8'), before);
});

test('directory junctions, linked config files and path traversal are rejected without following targets', t => {
  const f = fixture(), outside = path.join(f.base, 'outside'); fs.mkdirSync(outside); fs.writeFileSync(path.join(outside, 'cli.json'), '{"user":"outside"}');
  try {fs.symlinkSync(outside, path.join(f.workspace, '.cursor'), process.platform === 'win32' ? 'junction' : 'dir');}
  catch (e) {if (['EPERM', 'EACCES'].includes((e as NodeJS.ErrnoException).code || '')) {t.skip('This host does not permit synthetic junction creation'); return;} throw e;}
  assert.throws(() => acquire(f.options(job())), /符号链接|重解析/); assert.equal(fs.readFileSync(path.join(outside, 'cli.json'), 'utf8'), '{"user":"outside"}');
  const g = fixture(); assert.throws(() => acquire({...g.options(job()), stateDir: g.base + path.sep + '..' + path.sep + 'elsewhere'}), /越界/);
  const h = fixture('{}'); const lstat = fs.lstatSync;
  Object.assign(fs, {lstatSync: ((file: any, ...args: any[]) => {const stat = (lstat as any)(file, ...args); if (String(file) === h.configFile) {const linked = Object.create(stat); linked.isSymbolicLink = () => true; return linked;} return stat;}) as typeof fs.lstatSync});
  try {assert.throws(() => acquire(h.options(job())), /普通文件/);} finally {Object.assign(fs, {lstatSync: lstat});}
});

test('a confirmed dead lock owner is retained and recovered, while a malformed lock is left untouched', () => {
  const f = fixture(), id = job(); acquire(f.options(id));
  const child = spawnSync(process.execPath, ['-e', ''], {cwd: f.base, env: {...process.env, TEMP: f.base, TMP: f.base}, windowsHide: true, shell: false});
  assert.equal(child.status, 0); assert(child.pid && child.pid > 0);
  fs.writeFileSync(f.lockFile, JSON.stringify({pid: child.pid, nonce: randomUUID()}));
  release(f.options(id)); assert.deepEqual(list(f), []);
  assert(fs.readdirSync(path.dirname(f.lockFile)).some(name => name.startsWith('expired-lock-')));
  fs.writeFileSync(f.lockFile, '{'); assert.throws(() => acquire(f.options(job())), /锁记录无效/);
  assert.equal(fs.readFileSync(f.lockFile, 'utf8'), '{');
});

test('one damaged workspace registry does not hide healthy leases, and listing issues contain no original content', () => {
  const healthy = fixture(), damaged = fixture(), first = job(), second = job();
  acquire(healthy.options(first)); acquire({...damaged.options(second), stateDir: healthy.stateDir});
  const damagedHash = path.basename(path.dirname(damaged.registryFile)), badFile = path.join(healthy.stateDir, damagedHash, 'registry.json');
  fs.writeFileSync(badFile, '{"synthetic-private-marker":');
  const issues: unknown[] = [], leases = list({stateDir: healthy.stateDir, onIssue: issue => issues.push(issue)});
  assert.deepEqual(leases.map(l => l.jobId), [first]);
  assert.deepEqual(issues, [{workspaceHash: damagedHash, reason: 'workspace_unavailable_or_registry_invalid'}]);
  assert(!JSON.stringify(issues).includes('synthetic-private-marker'));
  check(healthy.options(first)); release(healthy.options(first));
  assert(fs.existsSync(damaged.configFile));
});
