import fs from 'node:fs';
import path from 'node:path';
import {createHash, randomUUID} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';
import {isMap, isScalar, isSeq, parseDocument} from 'yaml';
import {windowsExternalVault} from './external-vault.ts';

export const HARNESS_IMAGE_ENTRY = 'workbench-image-tools';
export const HARNESS_IMAGE_SERVER = 'workbench_images';
const BEGIN = '# BEGIN agent-workbench managed image tools v1';
const END = '# END agent-workbench managed image tools v1';
const BACKUPS = '.workbench-image-backups';
const sha256 = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const localAbsolute = (value: string) => path.isAbsolute(value) && !/^(?:\\\\|\/\/)/.test(value) && !/[\x00-\x1f]/.test(value);
const samePath = (left: string, right: string) => process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right;
function requireAbsolute(value: string) { if (!localAbsolute(value)) throw Error('需要本机绝对路径'); return path.resolve(value); }
function ordinaryPath(value: string, kind: 'file' | 'directory') {
  const full = requireAbsolute(value), stat = fs.lstatSync(full);
  if (stat.isSymbolicLink() || !samePath(fs.realpathSync.native(full), full) || !(kind === 'file' ? stat.isFile() : stat.isDirectory())) throw Error('路径必须是普通本机文件或目录，不能经过链接');
  return full;
}

export type HarnessImageLaunch = {nodePath: string; scriptPath: string; loaderPath: string; credentialFile: string; cwd: string};
/** The only persisted credential value is its file path. No model/provider settings are changed. */
export function harnessImagePatch(options: HarnessImageLaunch) {
  for (const value of [options.nodePath, options.scriptPath, options.loaderPath, options.credentialFile, options.cwd]) requireAbsolute(value);
  return [{insert: [{id: HARNESS_IMAGE_ENTRY, name: '@deepseek-ai/dsh-mcp-client', config: {
    serverName: HARNESS_IMAGE_SERVER, transport: 'stdio', command: options.nodePath,
    args: ['--import', pathToFileURL(options.loaderPath).href, options.scriptPath],
    env: {WORKBENCH_EXTERNAL_TOOLS_CREDENTIAL_FILE: options.credentialFile}, cwd: options.cwd,
    toolCallTimeoutMs: 120000, failOnStartupError: true,
  }}]}];
}

function parsePatch(source: string) {
  const doc = parseDocument(source, {customTags: [{tag: 'tag:yaml.org,2002:js', resolve: (value: string) => value}], uniqueKeys: true});
  // Never expose parse messages: they may quote a provider key or JS credential expression.
  if (doc.errors.length || (doc.contents && !isSeq(doc.contents))) throw Error('Harness patch 必须是有效的单文档 YAML 列表；未修改配置');
  return doc;
}
function containsBinding(node: unknown): boolean {
  if (isMap(node)) return node.items.some(pair => {
    const key = isScalar(pair.key) ? pair.key.value : null, value = isScalar(pair.value) ? pair.value.value : null;
    return (key === 'id' && value === HARNESS_IMAGE_ENTRY) || (key === 'serverName' && value === HARNESS_IMAGE_SERVER) || containsBinding(pair.value);
  });
  if (isSeq(node)) return node.items.some(containsBinding);
  return false;
}
/** Preserve all unrelated YAML, comments, !!js expressions and secrets byte-for-byte. */
export function mergeHarnessImagePatch(original: string, options: HarnessImageLaunch): {content: string; changed: boolean} {
  parsePatch(original);
  const begin = original.indexOf(BEGIN), end = original.indexOf(END);
  if ((begin < 0) !== (end < 0) || (begin >= 0 && (end < begin || original.indexOf(BEGIN, begin + BEGIN.length) >= 0 || original.indexOf(END, end + END.length) >= 0))) throw Error('生图工具管理标记损坏；未修改配置');
  const patch = harnessImagePatch(options)[0], encoded = JSON.stringify(patch);
  if (begin >= 0) {
    const lineStart = original.lastIndexOf('\n', begin - 1) + 1;
    if (lineStart !== begin || (end > 0 && original[end - 1] !== '\n')) throw Error('生图工具管理标记不在独立行；未修改配置');
    const body = original.slice(begin + BEGIN.length, end).trim();
    const previous = body.startsWith('- ') ? body.slice(2) : body.startsWith(', ') ? body.slice(2) : body;
    let previousPatch: {insert?: Array<{id?: string; name?: string; config?: {serverName?: string}}>};
    try { previousPatch = JSON.parse(previous); } catch { throw Error('受管生图工具块已被编辑；请先核对，未覆盖配置'); }
    if (!previousPatch || !Array.isArray(previousPatch.insert) || previousPatch.insert.length !== 1 || previousPatch.insert[0]?.id !== HARNESS_IMAGE_ENTRY || previousPatch.insert[0]?.name !== '@deepseek-ai/dsh-mcp-client' || previousPatch.insert[0]?.config?.serverName !== HARNESS_IMAGE_SERVER) throw Error('受管生图工具块结构已改变；未覆盖配置');
    const after = end + END.length;
    const suffixStart = original.slice(after, after + 2) === '\r\n' ? after + 2 : original[after] === '\n' ? after + 1 : after;
    const stripped = original.slice(0, begin) + original.slice(suffixStart);
    if (containsBinding(parsePatch(stripped).contents)) throw Error('受管块外已有同名 MCP 配置；未覆盖配置');
    if (JSON.stringify(previousPatch) === encoded) return {content: original, changed: false};
    return mergeHarnessImagePatch(stripped, options);
  }
  const doc = parsePatch(original);
  if (containsBinding(doc.contents)) throw Error('已有非工作台管理的同名 MCP 配置；未覆盖配置');
  const newline = original.includes('\r\n') ? '\r\n' : '\n';
  let offset = original.length, prefix = '- ', leader = original && !original.endsWith('\n') ? newline : '';
  if (isSeq(doc.contents) && doc.contents.flow) {
    offset = original.lastIndexOf(']', doc.contents.range![1] - 1);
    if (offset < 0) throw Error('无法定位 YAML 列表结束位置');
    prefix = doc.contents.items.length && !original.slice(0, offset).trimEnd().endsWith(',') ? ', ' : '';
    leader = newline;
  } else {
    const marker = /^\.\.\.(?:[ \t]*(?:#[^\r\n]*)?)\r?$/m.exec(original);
    if (marker) { offset = marker.index; leader = offset && original[offset - 1] !== '\n' ? newline : ''; }
  }
  const block = `${leader}${BEGIN}${newline}${prefix}${encoded}${newline}${END}${newline}`;
  const content = original.slice(0, offset) + block + original.slice(offset);
  parsePatch(content);
  return {content, changed: true};
}

export type HarnessImageInstallReceipt = {schema: 1; profile_path: string; config_path: string; backup_path: string | null; before_sha256: string | null; after_sha256: string; installed_at: string; binding_id: string};
function protectDirectory(directory: string, newlyCreated: boolean) {
  if (newlyCreated) {
    if (fs.readdirSync(directory).length) throw Error('配置备份目录已被其他操作使用；未修改权限或写入备份');
    fs.chmodSync(directory, 0o700);
  }
  if (process.platform !== 'win32') {
    if ((fs.statSync(directory).mode & 0o777) !== 0o700) throw Error('无法保护配置备份目录；未修改权限或写入含配置内容的备份');
    return;
  }
  const system32 = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32');
  const identity = execFileSync(path.join(system32, 'whoami.exe'), ['/user', '/fo', 'csv', '/nh'], {encoding: 'utf8', windowsHide: true});
  const sid = identity.match(/S-1-5-\d+(?:-\d+)+/)?.[0];
  if (!sid) throw Error('无法确认本机用户，未写入含配置内容的备份');
  const icacls = path.join(system32, 'icacls.exe');
  try {
    // Existing directories are inspected only: a failed validation must not alter
    // their DACL or inheritance. ACL writes are restricted to this operation's new empty directory.
    if (newlyCreated) execFileSync(icacls, [directory, '/inheritance:r', '/grant:r', `*${sid}:(OI)(CI)F`, '*S-1-5-18:(OI)(CI)F'], {windowsHide: true, stdio: 'pipe'});
    const check = path.join(directory, `acl-check-${randomUUID()}.txt`);
    execFileSync(icacls, [directory, '/save', check], {windowsHide: true, stdio: 'pipe'});
    const descriptor = fs.readFileSync(check).toString('utf16le');
    // Mandatory-integrity labels live in SACL and must be preserved; they are not
    // additional read grants. Only examine the DACL section for access identities.
    const dacl = descriptor.match(/D:([^\r\n]*?)(?=S:|\r|\n|$)/)?.[1] || '';
    const aces = [...dacl.matchAll(/\(([^()]*)\)/g)].map(match => match[1].split(';'));
    const permitted = new Set([sid, 'SY']);
    if (!/^[^(]*P/.test(dacl) || aces.length !== permitted.size || !aces.every(ace => ace.length === 6 && ace[0] === 'A' && ace[1].includes('OI') && ace[1].includes('CI') && !ace[1].includes('ID') && ['FA', '0x1f01ff'].includes(ace[2]) && permitted.has(ace[5])) || new Set(aces.map(ace => ace[5])).size !== permitted.size) throw Error('unexpected backup ACL');
  }
  catch { throw Error('无法保护配置备份目录；未写入含配置内容的备份'); }
}
export function installHarnessImageTools(options: HarnessImageLaunch & {profilePath: string; dryRun?: boolean}) {
  const profile = ordinaryPath(options.profilePath, 'directory');
  for (const file of [options.nodePath, options.scriptPath, options.loaderPath, options.credentialFile]) ordinaryPath(file, 'file');
  ordinaryPath(options.cwd, 'directory');
  const config = path.join(profile, 'cordis.patch.yml'), existed = fs.existsSync(config);
  if (existed) ordinaryPath(config, 'file');
  const previous = existed ? fs.readFileSync(config) : null;
  if (previous && previous.length > 4 * 1024 * 1024) throw Error('Harness 配置超过读取上限');
  const merged = mergeHarnessImagePatch(previous?.toString('utf8') || '', options);
  const summary = {profile_path: profile, config_path: config, changed: merged.changed, before_sha256: previous ? sha256(previous) : null, after_sha256: sha256(merged.content)};
  if (!merged.changed || options.dryRun) return {...summary, applied: false, dry_run: !!options.dryRun};
  const root = path.join(profile, BACKUPS);
  const rootExisted = fs.existsSync(root);
  if (rootExisted) ordinaryPath(root, 'directory'); else fs.mkdirSync(root, {mode: 0o700});
  protectDirectory(root, !rootExisted);
  const operation = path.join(root, randomUUID()); fs.mkdirSync(operation, {mode: 0o700});
  const backup = previous ? path.join(operation, 'cordis.patch.yml.bak') : null;
  if (backup) fs.writeFileSync(backup, previous!, {flag: 'wx', mode: 0o600});
  const receipt: HarnessImageInstallReceipt = {schema: 1, profile_path: profile, config_path: config, backup_path: backup, before_sha256: summary.before_sha256, after_sha256: summary.after_sha256, installed_at: new Date().toISOString(), binding_id: HARNESS_IMAGE_ENTRY};
  const receiptPath = path.join(operation, 'receipt.json');
  fs.writeFileSync(receiptPath, JSON.stringify(receipt, null, 2), {flag: 'wx', mode: 0o600});
  const candidate = path.join(operation, 'candidate.yml');
  fs.writeFileSync(candidate, merged.content, {flag: 'wx', mode: 0o600});
  const current = fs.existsSync(config) ? fs.readFileSync(ordinaryPath(config, 'file')) : null;
  if ((previous === null) !== (current === null) || (previous && current && !previous.equals(current))) throw Error('Harness 配置在安装准备期间变化；未覆盖，备份和候选保留');
  fs.renameSync(candidate, config);
  return {...summary, applied: true, dry_run: false, receipt_path: receiptPath, backup_path: backup};
}
export function rollbackHarnessImageTools(profilePath: string, receiptPath: string) {
  const profile = ordinaryPath(profilePath, 'directory'), file = ordinaryPath(receiptPath, 'file');
  const backupRoot = path.join(profile, BACKUPS), operation = path.dirname(file);
  ordinaryPath(backupRoot, 'directory'); ordinaryPath(operation, 'directory');
  if (path.dirname(operation) !== backupRoot || path.basename(file) !== 'receipt.json') throw Error('回滚回执不在本 profile 的受管备份目录');
  const receipt = JSON.parse(fs.readFileSync(file, 'utf8')) as HarnessImageInstallReceipt;
  const config = path.join(profile, 'cordis.patch.yml');
  if (receipt.schema !== 1 || receipt.binding_id !== HARNESS_IMAGE_ENTRY || receipt.profile_path !== profile || receipt.config_path !== config || !/^[a-f0-9]{64}$/.test(receipt.after_sha256)) throw Error('回滚回执格式不受支持');
  if (sha256(fs.readFileSync(ordinaryPath(config, 'file'))) !== receipt.after_sha256) throw Error('安装后配置已变化；为保护后续修改，未自动回滚');
  let previous: Buffer | null = null;
  if (receipt.backup_path !== null) {
    if (receipt.backup_path !== path.join(operation, 'cordis.patch.yml.bak')) throw Error('回滚备份路径无效');
    previous = fs.readFileSync(ordinaryPath(receipt.backup_path, 'file'));
    if (sha256(previous) !== receipt.before_sha256) throw Error('回滚备份校验失败');
  } else if (receipt.before_sha256 !== null) throw Error('回滚回执缺少备份');
  // Keep all candidates/backups for the user. Removing the newly created binding means
  // an empty patch, not deleting another file or recursively deleting any directory.
  const restored = previous || Buffer.alloc(0), staged = path.join(operation, `restore-${randomUUID()}.yml`);
  fs.writeFileSync(staged, restored, {flag: 'wx', mode: 0o600});
  if (sha256(fs.readFileSync(ordinaryPath(config, 'file'))) !== receipt.after_sha256) throw Error('回滚准备期间配置已变化；保留当前配置与恢复候选');
  fs.renameSync(staged, config);
  return {rolled_back: true, config_path: config, restored_sha256: sha256(restored), originally_absent: previous === null};
}

export type ExternalImageTool = 'list_external_services' | 'invoke_external_service' | 'get_external_invocation' | 'get_external_artifact';
export type ImageBridgeCredential = {base_url: string; token: string};
export async function readImageBridgeCredential(credentialFile: string, decrypt: (value: string) => Promise<Record<string, string>> = value => windowsExternalVault.decrypt(value)): Promise<ImageBridgeCredential> {
  const file = ordinaryPath(credentialFile, 'file');
  if (fs.statSync(file).size > 16384) throw Error('生图工具凭据文件格式无效');
  let value: unknown;
  try { value = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { throw Error('生图工具凭据文件格式无效'); }
  const stored = value as {base_url?: unknown; protected_token?: unknown; token?: unknown};
  if (!stored || typeof stored.base_url !== 'string' || typeof stored.protected_token !== 'string' || !stored.protected_token.startsWith('dpapi:v1:') || stored.token !== undefined) throw Error('生图工具需要当前用户加密的受限凭据；不接受明文密钥');
  let token: string;
  try { token = (await decrypt(stored.protected_token)).token; } catch { throw Error('无法解锁生图工具凭据，请在本机重新绑定'); }
  const c = {base_url: stored.base_url, token};
  return validateImageBridgeCredential(c);
}
function validateImageBridgeCredential(c: ImageBridgeCredential): ImageBridgeCredential {
  let url: URL;
  try { url = new URL(c.base_url); } catch { throw Error('生图工具后台地址无效'); }
  if (url.protocol !== 'http:' || !['127.0.0.1', '[::1]'].includes(url.hostname) || url.username || url.password || url.pathname !== '/' || url.search || url.hash || typeof c.token !== 'string' || c.token.length < 24 || /\s/.test(c.token)) throw Error('生图工具仅接受本机回环后台与受限凭据');
  return {base_url: url.origin, token: c.token};
}
/** No retries: a lost submission response must be resolved with the same request_id. */
export async function callImageBackend(credential: ImageBridgeCredential, tool: ExternalImageTool, input: unknown, signal?: AbortSignal, fetcher: typeof fetch = fetch): Promise<Record<string, unknown>> {
  credential = validateImageBridgeCredential(credential);
  if (!['list_external_services', 'invoke_external_service', 'get_external_invocation', 'get_external_artifact'].includes(tool)) throw Error('此桥接不允许调用该接口');
  let response: Response;
  try {
    response = await fetcher(`${credential.base_url}/api/mcp/${tool}`, {method: 'POST', redirect: 'error', headers: {'Content-Type': 'application/json', Authorization: `Bearer ${credential.token}`}, body: JSON.stringify(input), signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(115000)]) : AbortSignal.timeout(115000)});
  } catch { throw Error('工作台生图服务不可达或请求已取消；未自动重试'); }
  if (!response.ok) throw Error(`工作台生图服务拒绝请求（HTTP ${response.status}）；未自动重试`);
  const reader = response.body?.getReader();
  if (!reader) throw Error('工作台生图服务返回空响应');
  const chunks: Uint8Array[] = []; let bytes = 0;
  try { while (true) { const next = await reader.read(); if (next.done) break; bytes += next.value.length; if (bytes > 12 * 1024 * 1024) { await reader.cancel(); throw Error('limit'); } chunks.push(next.value); } } catch { throw Error('工作台生图结果超过上限或接收中断'); }
  let data: unknown;
  try { data = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw Error('工作台生图服务返回无效数据'); }
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw Error('工作台生图服务返回无效数据');
  // A backend bug must not turn the bridge into a credential disclosure channel.
  return JSON.parse(JSON.stringify(data).split(credential.token).join('[redacted]'));
}
