import fs from 'node:fs';
import path from 'node:path';
import {createHash, randomUUID} from 'node:crypto';

export interface CursorReviewPermissionOptions {workspace: string; jobId: string; stateDir: string; retentionDir: string}
export interface CursorReviewPermissionLease {workspace: string; workspaceHash: string; jobId: string; token: string; added: boolean; phase: 'prepared' | 'active' | 'releasing'}
export interface CursorReviewPermissionIssue {workspaceHash: string; reason: 'workspace_unavailable_or_registry_invalid'}
type Lease = {jobId: string; token: string; added: boolean};
type Snapshot = string | null;
type Pending = {id: string; action: 'acquire' | 'release'; jobId: string; before: Snapshot; after: Snapshot; next: Lease[]; restoredOriginal: boolean};
type Registry = {schema: 1; workspace: string; retentionDir: string; original: Snapshot; expected: Snapshot; diverged: boolean; leases: Lease[]; pending: Pending | null};
type Context = {workspace: string; workspaceHash: string; jobId: string; stateDir: string; retentionDir: string; directory: string; registryFile: string; configFile: string};
const JOB = /^AJ-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const MAX_CONFIG = 1024 * 1024;
const samePath = (a: string, b: string) => process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
const sha = (value: string) => createHash('sha256').update(value).digest('hex');
const expectedToken = (jobId: string) => `Shell(node:.workbench-review-checks/${jobId}/verify.mjs)`;
function assert(value: unknown, code: string): asserts value {if (!value) throw Error(`Cursor 审查权限租约：${code}`);}
function absolute(value: string) {
  assert(typeof value === 'string' && path.isAbsolute(value) && !/^(?:\\\\|\/\/)/.test(value) && !/[\x00-\x1f]/.test(value), '需要本机绝对路径');
  assert(!value.split(/[\\/]/).some(part => part === '..' || part === '.'), '路径不能包含越界片段');
  return path.resolve(value);
}
/** Walk every ancestor before creating or reading anything, rejecting junctions as well as leaf links. */
function directory(value: string, create = false) {
  const full = absolute(value), root = path.parse(full).root;
  let current = root;
  for (const part of [null, ...full.slice(root.length).split(path.sep).filter(Boolean)]) {
    if (part !== null) current = path.join(current, part);
    if (!fs.existsSync(current)) {assert(create, '目录不存在'); fs.mkdirSync(current, {mode: 0o700});}
    const stat = fs.lstatSync(current);
    assert(stat.isDirectory() && !stat.isSymbolicLink() && samePath(fs.realpathSync.native(current), current), '目录不能经过符号链接或重解析点');
  }
  return full;
}
function readFile(file: string, limit = MAX_CONFIG): Buffer | null {
  directory(path.dirname(file));
  let stat: fs.Stats;
  try {stat = fs.lstatSync(file);} catch (e) {if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null; throw e;}
  assert(stat.isFile() && !stat.isSymbolicLink() && samePath(fs.realpathSync.native(file), file) && stat.size <= limit, '配置必须是大小受限的普通文件');
  return fs.readFileSync(file);
}
function snapshot(bytes: Buffer | null): Snapshot {return bytes === null ? null : bytes.toString('base64');}
function decode(value: Snapshot) {return value === null ? null : Buffer.from(value, 'base64');}
function validSnapshot(value: unknown): value is Snapshot {
  return value === null || (typeof value === 'string' && value.length <= MAX_CONFIG * 1.4 && Buffer.from(value, 'base64').toString('base64') === value);
}
function current(c: Context): Snapshot {
  const dir = path.dirname(c.configFile);
  if (!fs.existsSync(dir)) {directory(c.workspace); return null;}
  return snapshot(readFile(c.configFile));
}
function writeNew(file: string, bytes: Buffer) {
  directory(path.dirname(file));
  const fd = fs.openSync(file, 'wx', 0o600);
  try {fs.writeFileSync(fd, bytes); fs.fsyncSync(fd);} finally {fs.closeSync(fd);}
}
function context(options: CursorReviewPermissionOptions): Context {
  assert(JOB.test(options.jobId), 'jobId 格式无效');
  const workspace = directory(options.workspace), stateDir = absolute(options.stateDir), retentionDir = absolute(options.retentionDir);
  assert(samePath(path.parse(workspace).root, path.parse(retentionDir).root), '保留目录必须与项目同卷，以移动代替删除');
  const configDir = path.join(workspace, '.cursor');
  for (const target of [stateDir, retentionDir]) {const rel = path.relative(configDir, target); assert(rel !== '' && (rel.startsWith('..' + path.sep) || rel === '..' || path.isAbsolute(rel)), '状态与保留目录不能放在 .cursor 中');}
  directory(stateDir, true); directory(retentionDir, true);
  const workspaceHash = sha(process.platform === 'win32' ? workspace.toLowerCase() : workspace), dir = directory(path.join(stateDir, workspaceHash), true);
  return {workspace, workspaceHash, jobId: options.jobId, stateDir, retentionDir, directory: dir, registryFile: path.join(dir, 'registry.json'), configFile: path.join(configDir, 'cli.json')};
}
function readRegistry(c: Pick<Context, 'registryFile' | 'workspace' | 'retentionDir'>): Registry | null {
  const bytes = readFile(c.registryFile, 12 * MAX_CONFIG); if (!bytes) return null;
  let value: Registry;
  try {value = JSON.parse(bytes.toString('utf8'));} catch {throw Error('Cursor 审查权限租约：状态记录损坏');}
  const leaseValid = (lease: Lease) => lease && JOB.test(lease.jobId) && lease.token === expectedToken(lease.jobId) && typeof lease.added === 'boolean';
  assert(value?.schema === 1 && samePath(value.workspace, c.workspace) && samePath(value.retentionDir, c.retentionDir) && validSnapshot(value.original) && validSnapshot(value.expected) && typeof value.diverged === 'boolean' && Array.isArray(value.leases) && value.leases.every(leaseValid) && new Set(value.leases.map(l => l.jobId)).size === value.leases.length, '状态记录无效');
  if (value.pending) {
    const p = value.pending;
    assert(UUID.test(p.id) && ['acquire', 'release'].includes(p.action) && JOB.test(p.jobId) && validSnapshot(p.before) && validSnapshot(p.after) && Array.isArray(p.next) && p.next.every(leaseValid) && new Set(p.next.map(l => l.jobId)).size === p.next.length && typeof p.restoredOriginal === 'boolean', '待完成状态记录无效');
  }
  return value;
}
function persist(c: Context, state: Registry) {
  const staged = path.join(c.directory, `registry-${randomUUID()}.next`);
  writeNew(staged, Buffer.from(JSON.stringify(state)));
  // Private state is replaced atomically. It is never returned in a user-facing result.
  readFile(c.registryFile, 12 * MAX_CONFIG);
  fs.renameSync(staged, c.registryFile);
}
function withLock<T>(c: Context, action: () => T): T {
  const lock = path.join(c.directory, 'lease.lock');
  const take = () => writeNew(lock, Buffer.from(JSON.stringify({pid: process.pid, nonce: randomUUID()})));
  try {take();} catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    let owner: {pid: number}; try {owner = JSON.parse(readFile(lock, 4096)!.toString('utf8'));} catch {throw Error('Cursor 审查权限租约：锁记录无效');}
    assert(Number.isSafeInteger(owner.pid) && owner.pid > 0, '锁记录无效');
    let ended = false; try {process.kill(owner.pid, 0);} catch (e) {ended = (e as NodeJS.ErrnoException).code === 'ESRCH';}
    assert(ended, '同一项目的权限正在更新，请稍后重试');
    fs.renameSync(lock, path.join(c.directory, `expired-lock-${randomUUID()}.json`)); take();
  }
  try {return action();} finally {fs.renameSync(lock, path.join(c.directory, `closed-lock-${randomUUID()}.json`));}
}

type Node = {start: number; end: number; value: any; members?: Array<{key: string; keyStart: number; value: Node}>; items?: Node[]};
/** JSON locations let us change only the allow list, keeping unrelated formatting and fields. */
function json(source: string): Node {
  let at = source.charCodeAt(0) === 0xfeff ? 1 : 0;
  const ws = () => {while (/\s/.test(source[at] || '') && at < source.length) at++;};
  const string = () => {const start = at++; while (at < source.length) {if (source[at] === '\\') at += 2; else if (source[at++] === '"') return JSON.parse(source.slice(start, at));} throw Error();};
  function parse(): Node {
    ws(); const start = at, first = source[at];
    if (first === '{') {
      at++; ws(); const members: NonNullable<Node['members']> = [], value: Record<string, unknown> = Object.create(null), seen = new Set<string>();
      while (source[at] !== '}') {ws(); const keyStart = at; if (source[at] !== '"') throw Error(); const key = string(); if (seen.has(key)) throw Error(); seen.add(key); ws(); if (source[at++] !== ':') throw Error(); const item = parse(); members.push({key, keyStart, value: item}); value[key] = item.value; ws(); if (source[at] === '}') break; if (source[at++] !== ',') throw Error(); ws(); if (source[at] === '}') throw Error();}
      if (source[at++] !== '}') throw Error(); return {start, end: at, value, members};
    }
    if (first === '[') {at++; ws(); const items: Node[] = []; while (source[at] !== ']') {items.push(parse()); ws(); if (source[at] === ']') break; if (source[at++] !== ',') throw Error(); ws(); if (source[at] === ']') throw Error();} if (source[at++] !== ']') throw Error(); return {start, end: at, value: items.map(v => v.value), items};}
    if (first === '"') return {start, end: (string(), at), value: JSON.parse(source.slice(start, at))};
    const match = source.slice(at).match(/^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/); if (!match) throw Error(); at += match[0].length; return {start, end: at, value: JSON.parse(match[0])};
  }
  try {const root = parse(); ws(); if (at !== source.length || !root.members) throw Error(); return root;} catch {throw Error('Cursor 审查权限租约：项目配置必须是有效且无重复键的 JSON 对象');}
}
function config(value: Snapshot) {
  const source = value === null ? '{}\n' : new TextDecoder('utf-8', {fatal: true, ignoreBOM: true}).decode(decode(value)!);
  const root = json(source), permission = root.members!.find(m => m.key === 'permissions')?.value;
  assert(!permission || permission.members, 'permissions 必须是对象');
  const allow = permission?.members?.find(m => m.key === 'allow')?.value, deny = permission?.members?.find(m => m.key === 'deny')?.value;
  for (const list of [allow, deny]) assert(!list || (list.items && list.items.every(i => typeof i.value === 'string')), 'allow/deny 必须是字符串数组');
  return {source, root, permission, allow, deny, allowed: (allow?.value || []) as string[]};
}
function glob(pattern: string, value: string) {return new RegExp('^' + pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$', 'i').test(value);}
function denied(deny: Node | undefined, jobId: string) {
  const argument = `.workbench-review-checks/${jobId}/verify.mjs`;
  return deny?.items?.some(item => {const shell = /^Shell\((.*)\)$/i.exec(item.value); if (!shell) return false; const split = shell[1].indexOf(':'); return split < 0 ? glob(shell[1], 'node') : glob(shell[1].slice(0, split), 'node') && glob(shell[1].slice(split + 1), argument);}) || false;
}
function insert(source: string, parent: Node, text: string, entries: Array<{start: number; end: number}>) {
  const last = entries.at(-1), from = last?.end ?? parent.start + 1, tail = source.slice(from, parent.end - 1), multiline = source.slice(parent.start, parent.end).includes('\n');
  let addition: string;
  if (multiline) {
    const newline = source.includes('\r\n') ? '\r\n' : '\n', first = entries[0]?.start;
    const indent = first === undefined ? (source.slice(source.lastIndexOf('\n', parent.start) + 1, parent.start).match(/^\s*/)?.[0] || '') + '  ' : source.slice(source.lastIndexOf('\n', first) + 1, first);
    addition = (last ? ',' : '') + newline + indent + text;
  } else addition = (last ? ',' + (/^\s/.test(tail) ? ' ' : '') : '') + text;
  return source.slice(0, from) + addition + tail + source.slice(parent.end - 1);
}
function addToken(value: Snapshot, token: string): Snapshot {
  let c = config(value), source = c.source;
  if (!c.permission) {
    source = insert(source, c.root, `"permissions": {"allow": [${JSON.stringify(token)}], "deny": []}`, c.root.members!.map(m => ({start: m.keyStart, end: m.value.end})));
  } else {
    // Cursor requires both arrays even when the pre-lease project config omitted one.
    // Add only missing fields; the captured original bytes still govern restoration.
    if (!c.allow) source = insert(source, c.permission, `"allow": [${JSON.stringify(token)}]`, c.permission.members!.map(m => ({start: m.keyStart, end: m.value.end})));
    else if (!c.allowed.includes(token)) source = insert(source, c.allow, JSON.stringify(token), c.allow.items!);
    c = config(snapshot(Buffer.from(source)));
    if (!c.deny) source = insert(source, c.permission!, '"deny": []', c.permission!.members!.map(m => ({start: m.keyStart, end: m.value.end})));
  }
  config(snapshot(Buffer.from(source))); return snapshot(Buffer.from(source));
}
function removeToken(value: Snapshot, token: string): Snapshot {
  if (value === null) return null;
  const c = config(value), items = c.allow?.items, index = items?.findIndex(i => i.value === token) ?? -1;
  if (!items || index < 0) return value;
  const item = items[index]; let start = item.start, end = item.end;
  if (index < items.length - 1) end = items[index + 1].start;
  else if (index > 0) start = items[index - 1].end;
  const source = c.source.slice(0, start) + c.source.slice(end); config(snapshot(Buffer.from(source))); return snapshot(Buffer.from(source));
}
function transactionPaths(c: Context, p: Pending) {return {stage: path.join(c.retentionDir, `${c.workspaceHash}-${p.id}-next.json`), backup: path.join(c.retentionDir, `${c.workspaceHash}-${p.id}-previous.json`)};}
function copyExclusive(source: string, target: string) {
  assert(readFile(source) !== null, '事务快照缺失'); directory(path.dirname(target));
  fs.copyFileSync(source, target, fs.constants.COPYFILE_EXCL);
  const fd = fs.openSync(target, 'r+'); try {fs.fsyncSync(fd);} finally {fs.closeSync(fd);}
}
/** Resolve an interrupted mutation without granting a permission that was never written. */
function settle(c: Context, state: Registry) {
  const p = state.pending; if (!p) return;
  const now = current(c), files = transactionPaths(c, p), moved = snapshot(readFile(files.backup));
  if (now === null && p.before !== null && moved !== null && moved !== p.before) {
    // A concurrent save may have been moved just before the process died. Restore
    // those user bytes even when the planned final state was an absent config.
    config(moved); directory(path.dirname(c.configFile), true); copyExclusive(files.backup, c.configFile);
    state.diverged = true; state.expected = p.before;
  } else if (now === p.after) {state.leases = p.next; state.expected = p.after;}
  else if (now === p.before) {state.expected = p.before;}
  else if (now === null && p.before !== null && moved === p.before) {
    directory(path.dirname(c.configFile), true); copyExclusive(files.backup, c.configFile); state.expected = p.before;
  } else {
    // A user edited the file after our write (or while the operation was interrupted).
    // Keep that document and only track the exact token we might have appended.
    state.diverged = true;
    if (p.action === 'acquire') state.leases = p.next;
  }
  state.pending = null; persist(c, state);
}
function mutate(c: Context, state: Registry, p: Pending) {
  state.pending = p; persist(c, state); // Durable intent always precedes the project grant.
  const files = transactionPaths(c, p);
  if (p.before !== p.after) {
    if (p.after !== null) writeNew(files.stage, decode(p.after)!);
    assert(current(c) === p.before, '项目配置已被并发修改，未覆盖');
    directory(path.dirname(c.configFile), true);
    if (p.before !== null) {
      fs.renameSync(c.configFile, files.backup);
      if (snapshot(readFile(files.backup)) !== p.before) {
        if (current(c) === null) copyExclusive(files.backup, c.configFile);
        throw Error('Cursor 审查权限租约：移动前配置发生变化，用户原文已恢复或保留');
      }
    }
    if (p.after !== null) copyExclusive(files.stage, c.configFile);
    assert(current(c) === p.after, '项目配置在写入期间发生变化，需重新撤销租约');
  }
  state.leases = p.next; state.expected = p.after; state.pending = null; persist(c, state);
  return p.after === null && p.before !== null ? files.backup : undefined;
}

export function acquireCursorReviewPermission(options: CursorReviewPermissionOptions & {token: string}) {
  assert(JOB.test(options.jobId) && options.token === expectedToken(options.jobId), '只允许本次任务的固定无参数核验命令');
  const c = context(options);
  return withLock(c, () => {
    let state = readRegistry(c); if (state) settle(c, state);
    const before = current(c), parsed = config(before);
    assert(!denied(parsed.deny, options.jobId), '项目 deny 已禁止本次命令，不能以租约覆盖');
    if (!state || !state.leases.length) state = {schema: 1, workspace: c.workspace, retentionDir: c.retentionDir, original: before, expected: before, diverged: false, leases: [], pending: null};
    if (before !== state.expected) state.diverged = true;
    const existing = state.leases.find(l => l.jobId === c.jobId);
    if (existing) {assert(parsed.allowed.includes(existing.token), '本次权限已被外部移除，未自动重新授权'); return {workspaceHash: c.workspaceHash, jobId: c.jobId, token: existing.token, acquired: true as const, added: existing.added, leaseCount: state.leases.length};}
    const lease: Lease = {jobId: c.jobId, token: options.token, added: !parsed.allowed.includes(options.token)};
    const next = [...state.leases, lease];
    mutate(c, state, {id: randomUUID(), action: 'acquire', jobId: c.jobId, before, after: addToken(before, options.token), next, restoredOriginal: false});
    return {workspaceHash: c.workspaceHash, jobId: c.jobId, token: options.token, acquired: true as const, added: lease.added, leaseCount: next.length};
  });
}

/** Caller must establish that this job's process has ended before releasing its lease. */
export function releaseCursorReviewPermission(options: CursorReviewPermissionOptions) {
  const c = context(options);
  return withLock(c, () => {
    const state = readRegistry(c); if (!state) return {released: false, leaseCount: 0, restoredOriginal: false};
    settle(c, state);
    const lease = state.leases.find(l => l.jobId === c.jobId); if (!lease) return {released: false, leaseCount: state.leases.length, restoredOriginal: false};
    const before = current(c); config(before);
    if (before !== state.expected) state.diverged = true;
    const next = state.leases.filter(l => l.jobId !== c.jobId);
    let after = before, restoredOriginal = false;
    if (!state.diverged) {
      after = state.original;
      for (const remaining of next) if (remaining.added) after = addToken(after, remaining.token);
      restoredOriginal = !next.length;
    } else if (lease.added) after = removeToken(before, lease.token);
    const retainedConfigPath = mutate(c, state, {id: randomUUID(), action: 'release', jobId: c.jobId, before, after, next, restoredOriginal});
    return {released: true, leaseCount: next.length, restoredOriginal, ...(retainedConfigPath ? {retainedConfigPath} : {})};
  });
}

/** Metadata only: no original JSON, permission arrays, or file contents leave this module. */
export function listCursorReviewPermissions({stateDir, onIssue}: {stateDir: string; onIssue?: (issue: CursorReviewPermissionIssue) => void}): CursorReviewPermissionLease[] {
  const root = absolute(stateDir); if (!fs.existsSync(root)) return []; directory(root);
  const result: CursorReviewPermissionLease[] = [];
  for (const name of fs.readdirSync(root).filter(n => /^[a-f0-9]{64}$/.test(n))) {
    try {
      const dir = directory(path.join(root, name)), file = path.join(dir, 'registry.json'), bytes = readFile(file, 12 * MAX_CONFIG); if (!bytes) continue;
      let metadata: Registry; try {metadata = JSON.parse(bytes.toString('utf8'));} catch {throw Error('Cursor 审查权限租约：状态记录损坏');}
      assert(typeof metadata.workspace === 'string' && typeof metadata.retentionDir === 'string', '状态路径无效');
      const workspace = directory(metadata.workspace), retentionDir = directory(metadata.retentionDir);
      assert(sha(process.platform === 'win32' ? workspace.toLowerCase() : workspace) === name, '状态目录与项目不匹配');
      const state = readRegistry({registryFile: file, workspace, retentionDir})!;
      const leases = new Map(state.leases.map(l => [l.jobId, {...l, phase: 'active' as CursorReviewPermissionLease['phase']}]));
      if (state.pending?.action === 'acquire') {const l = state.pending.next.find(l => l.jobId === state.pending!.jobId); if (l) leases.set(l.jobId, {...l, phase: 'prepared'});}
      if (state.pending?.action === 'release') {const l = leases.get(state.pending.jobId); if (l) l.phase = 'releasing';}
      for (const l of leases.values()) result.push({workspace, workspaceHash: name, ...l});
    } catch {onIssue?.({workspaceHash: name, reason: 'workspace_unavailable_or_registry_invalid'});}
  }
  return result;
}

/** Read-only pre-spawn check. A removed/denied permission is never silently re-granted. */
export function assertCursorReviewPermission({workspace: input, jobId, stateDir}: Omit<CursorReviewPermissionOptions, 'retentionDir'>): void {
  assert(JOB.test(jobId), 'jobId 格式无效');
  const workspace = directory(input), root = directory(stateDir), workspaceHash = sha(process.platform === 'win32' ? workspace.toLowerCase() : workspace);
  const dir = directory(path.join(root, workspaceHash)), registryFile = path.join(dir, 'registry.json'), bytes = readFile(registryFile, 12 * MAX_CONFIG);
  assert(bytes, '本次任务没有有效权限租约');
  let metadata: Registry; try {metadata = JSON.parse(bytes.toString('utf8'));} catch {throw Error('Cursor 审查权限租约：状态记录损坏');}
  assert(typeof metadata.retentionDir === 'string', '状态路径无效');
  const retentionDir = directory(metadata.retentionDir), state = readRegistry({registryFile, workspace, retentionDir})!;
  assert(!state.pending, '项目权限事务尚未完成');
  const lease = state.leases.find(l => l.jobId === jobId);
  assert(lease && lease.token === expectedToken(jobId), '本次任务没有有效权限租约');
  const configFile = path.join(workspace, '.cursor', 'cli.json'), value = fs.existsSync(path.dirname(configFile)) ? snapshot(readFile(configFile)) : null, parsed = config(value);
  assert(parsed.allowed.includes(lease.token), '本次权限已被用户撤销');
  assert(!denied(parsed.deny, jobId), '项目 deny 已禁止本次命令');
}
