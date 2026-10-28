import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createHash, randomUUID} from 'node:crypto';
import {execFile} from 'node:child_process';

export type ClientKind = 'dsh' | 'claude' | 'cursor' | 'grok';
export type ClientStatus = 'verified' | 'missing' | 'unverified';
export type ClientRecord = {
  kind: ClientKind; label: string; status: ClientStatus; reason: string; checkedAt: string;
  authentication: 'unknown'; quota: 'unknown'; invocation: 'unknown';
  version?: string; executable?: string; prefixArgs?: string[]; env?: Record<string, string>;
  candidatePath?: string; supportedFlags?: string[]; help?: string;
  fingerprints?: Array<{path: string; value: string}>;
};
export type ClientCapability = Pick<ClientRecord, 'kind' | 'label' | 'status' | 'reason' | 'checkedAt' | 'version' | 'authentication' | 'quota' | 'invocation'> & {available: boolean; supportsResume: boolean; executionSupported: boolean; reviewSupported: boolean};
export type DiscoveryCandidate = {path: string; source: 'path' | 'registration' | 'shortcut' | 'common'};
type Probe = (command: string, args: string[], env?: Record<string, string>) => Promise<string>;
export type DiscoveryOptions = {dataDir: string; force?: boolean; /** Dependency injection for isolated tests; never populated from HTTP input. */ testHooks?: {candidates?: DiscoveryCandidate[]; processPath?: string; persistedPathValues?: string[]; machineId?: string; now?: number; probe?: Probe}};
const KINDS: ClientKind[] = ['dsh', 'claude', 'cursor', 'grok'];
const LABELS: Record<ClientKind, string> = {dsh: 'DeepSeek Harness', claude: 'Claude Code', cursor: 'Cursor Agent CLI', grok: 'Grok Build'};
const CACHE_FILE = 'local-agent-clients.json';
const OVERRIDE_FILE = 'local-agent-client-overrides.json';
const CACHE_VERSION = 2;
const CACHE_TTL = 5 * 60_000;
const MAX_OUTPUT = 128 * 1024;
const MAX_PATH_VALUE_CHARS = 64 * 1024;
const MAX_PATH_ENTRIES = 512;
const MAX_CURSOR_SCRIPT_BYTES = 32_768;
const names = ['dsh', 'claude', 'cursor-agent', 'agent', 'grok', 'grok-build'];
const unknownState = {authentication: 'unknown', quota: 'unknown', invocation: 'unknown'} as const;
const CURSOR_VERSION_RULE = String.raw`^\d{4}\.\d{1,2}\.\d{1,2}(-\d{2}-\d{2}-\d{2})?-[a-f0-9]+$`;
const CURSOR_VERSION_NAME = /^(\d{4})\.(\d{1,2})\.(\d{1,2})(?:-(\d{2})-(\d{2})-(\d{2}))?-([a-f0-9]+)$/i;
const CURSOR_PS1_TEMPLATE_SHA256 = 'aaec1a0192ce3661dc65b5d5ee38155f1692d0c94ccc481257e0e6d15f46fe96';

function digest(value: string) { return createHash('sha256').update(value).digest('hex'); }
async function fingerprint(file: string) {
  const s = await fs.stat(file);
  return `${s.size}:${s.mtimeMs}:${s.ctimeMs}`;
}
async function exists(file: string) { try {return (await fs.stat(file)).isFile();} catch {return false;} }
function localAbsolute(file: string) {return path.isAbsolute(file) && !/^(?:\\\\|\/\/)/.test(file) && !/[\x00-\x1f]/.test(file);}
function inside(root: string, target: string) {
  const relative = path.relative(root, target);
  return relative === '' || (relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative));
}
function samePath(a: string, b: string) {return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;}
function assertCursorCmdWrapper(script: string) {
  const lines = script.replace(/^\uFEFF/, '').replace(/\r/g, '').split('\n').map(s => s.trim()).filter(s => s && !/^(?:rem(?:\s|$)|::)/i.test(s));
  const common = [
    '@echo off', 'setlocal enabledelayedexpansion', 'set "CURSOR_INVOKED_AS=%~nx0"',
    'set "SCRIPT_DIR=%~dp0"', 'if "%SCRIPT_DIR:~-1%"=="\\" set "SCRIPT_DIR=%SCRIPT_DIR:~0,-1%"',
    '%SystemRoot%\\System32\\WindowsPowerShell\\v1.0\\powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%SCRIPT_DIR%\\cursor-agent.ps1" %*',
  ];
  const direct = ['@echo off', ...common.slice(1)];
  const staged = ['@echo off', 'if exist "%~dp0versions\\promote-staged.cmd" call "%~dp0versions\\promote-staged.cmd"', 'if errorlevel 1 exit /b 1', ...common];
  const normalized = lines.map(s => s.toLowerCase());
  if (![direct, staged].some(expected => expected.length === normalized.length && expected.every((line, i) => line.toLowerCase() === normalized[i]))) throw new Error('Cursor CLI Windows 包装器格式不受支持');
}
function parseCursorVersionName(value: string) {
  const m = CURSOR_VERSION_NAME.exec(value);
  if (!m) return null;
  const year = Number(m[1]), month = Number(m[2]), day = Number(m[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  return {value, date: year * 10_000 + month * 100 + day};
}
async function rejectLinksUnder(root: string, target: string) {
  if (!inside(root, target)) throw new Error('Cursor CLI 路径越出本机安装目录');
  let current = root;
  const rootStat = await fs.lstat(current);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error('Cursor CLI 安装目录不能是链接');
  const relative = path.relative(root, target);
  for (const part of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    const stat = await fs.lstat(current);
    if (stat.isSymbolicLink()) throw new Error('Cursor CLI 包含不受支持的链接');
    const real = await fs.realpath(current);
    if (!inside(root, real) || !samePath(real, current)) throw new Error('Cursor CLI 链接越出本机安装目录');
  }
}
async function rejectLinkedAncestors(target: string) {
  const absolute = path.resolve(target);
  if (!localAbsolute(absolute)) throw new Error('客户端入口必须位于本机');
  const root = path.parse(absolute).root;
  let current = root;
  for (const part of path.relative(root, absolute).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    const stat = await fs.lstat(current);
    if (stat.isSymbolicLink()) throw new Error('Cursor CLI 入口路径不能经过链接');
    const real = await fs.realpath(current);
    if (!samePath(real, current)) throw new Error('Cursor CLI 入口路径不能经过链接');
  }
}
async function resolveCursorAgentLauncher(candidate: string): Promise<Launch> {
  await rejectLinkedAncestors(candidate);
  const realCandidate = await fs.realpath(candidate);
  if (!localAbsolute(realCandidate) || !['cursor-agent.cmd', 'agent.cmd'].includes(path.basename(realCandidate).toLowerCase())) throw new Error('Cursor CLI 入口名称无效');
  const root = path.dirname(realCandidate);
  const rootReal = await fs.realpath(root);
  if (!localAbsolute(rootReal)) throw new Error('Cursor CLI 安装目录必须位于本机');
  await rejectLinksUnder(rootReal, realCandidate);
  const cmdStat = await fs.stat(realCandidate);
  if (!cmdStat.isFile() || cmdStat.size > MAX_CURSOR_SCRIPT_BYTES) throw new Error('Cursor CLI 包装器无效或超过大小限制');
  assertCursorCmdWrapper(await fs.readFile(realCandidate, 'utf8'));

  const ps1 = path.join(rootReal, 'cursor-agent.ps1');
  await rejectLinkedAncestors(ps1);
  await rejectLinksUnder(rootReal, ps1);
  const ps1Real = await fs.realpath(ps1);
  if (!samePath(ps1Real, ps1)) throw new Error('Cursor CLI PowerShell 包装器不能是链接');
  const ps1Stat = await fs.stat(ps1Real);
  if (!ps1Stat.isFile() || ps1Stat.size > MAX_CURSOR_SCRIPT_BYTES) throw new Error('Cursor CLI PowerShell 包装器无效或超过大小限制');
  const ps1Text = await fs.readFile(ps1Real, 'utf8');
  const normalizedPs1 = ps1Text.replace(/^\uFEFF/, '').replace(/\r/g, '').split('\n').map(line => line.trim()).filter(line => line && !line.startsWith('#')).join('\n');
  const versionRule = ps1Text.match(/^\s*\$name\s+-match\s+'([^']+)'\s*$/m)?.[1];
  if (!ps1Text.includes('# cursor-agent-promote-staged') || versionRule !== CURSOR_VERSION_RULE || digest(normalizedPs1) !== CURSOR_PS1_TEMPLATE_SHA256) throw new Error('Cursor CLI PowerShell 包装器格式不受支持');

  const versions = path.join(rootReal, 'versions');
  await rejectLinksUnder(rootReal, versions);
  const versionsReal = await fs.realpath(versions);
  if (!inside(rootReal, versionsReal)) throw new Error('Cursor CLI 版本目录链接越出安装目录');
  const entries = await fs.readdir(versionsReal, {withFileTypes: true});
  const matches: Array<{name: string; date: number}> = [];
  for (const entry of entries) {
    const parsed = entry.isDirectory() && !entry.isSymbolicLink() ? parseCursorVersionName(entry.name) : null;
    if (!parsed) continue;
    const dir = path.join(versionsReal, entry.name);
    await rejectLinksUnder(rootReal, dir);
    const realDir = await fs.realpath(dir);
    if (!inside(rootReal, realDir)) throw new Error('Cursor CLI 版本链接越出安装目录');
    matches.push({name: parsed.value, date: parsed.date});
  }
  if (!matches.length) throw new Error('Cursor CLI 没有受支持的版本目录');
  matches.sort((a, b) => b.date - a.date || a.name.localeCompare(b.name));
  if (matches.length > 1 && matches[0].date === matches[1].date) throw new Error('Cursor CLI 同日有多个版本，无法安全选择');
  const versionDir = path.join(versionsReal, matches[0].name);
  const packageFile = path.join(versionDir, 'package.json');
  const nodeFile = path.join(versionDir, 'node.exe');
  const entryFile = path.join(versionDir, 'index.js');
  const files: string[] = [];
  for (const file of [packageFile, nodeFile, entryFile]) {
    await rejectLinksUnder(rootReal, file);
    const real = await fs.realpath(file);
    if (!inside(rootReal, real)) throw new Error('Cursor CLI 文件链接越出安装目录');
    if (!(await fs.stat(real)).isFile()) throw new Error('Cursor CLI 版本文件缺失');
    files.push(real);
  }
  const [packageReal, nodeReal, entryReal] = files;
  const pkgStat = await fs.stat(packageReal);
  if (pkgStat.size > 16_384) throw new Error('Cursor CLI 包信息过大');
  const pkg = JSON.parse(await fs.readFile(packageReal, 'utf8'));
  if (pkg.name !== '@anysphere/agent-cli-runtime') throw new Error('Cursor CLI 包身份不匹配');
  return {executable: nodeReal, prefixArgs: [entryReal], env: {CURSOR_INVOKED_AS: path.basename(realCandidate)}, files: [realCandidate, ps1Real, ...files]};
}

// These are fixed, read-only metadata queries. No command contains a discovered path.
const WINDOWS_METADATA = String.raw`
$ErrorActionPreference='SilentlyContinue'
$out=@()
$paths=@([Environment]::GetEnvironmentVariable('Path','User'),[Environment]::GetEnvironmentVariable('Path','Machine')) | Where-Object {$_}
$keys=@('HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*','HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*','HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*')
Get-ItemProperty -Path $keys | Where-Object {$_.DisplayName -match 'DeepSeek Harness|Claude|Cursor|Grok Build'} | ForEach-Object {
  if ($_.InstallLocation) {$out+=@{root=$_.InstallLocation;source='registration'}}
  elseif ($_.DisplayIcon) {$icon=$_.DisplayIcon -replace ',\d+$','';$icon=$icon.Trim('"');if([IO.Path]::IsPathRooted($icon)){$out+=@{root=[IO.Path]::GetDirectoryName($icon);source='registration'}}}
}
$shell=New-Object -ComObject WScript.Shell
$roots=@([Environment]::GetFolderPath('StartMenu'),[Environment]::GetFolderPath('CommonStartMenu'),[Environment]::GetFolderPath('DesktopDirectory'),[Environment]::GetFolderPath('CommonDesktopDirectory'))
foreach($root in $roots){if($root -and (Test-Path -LiteralPath $root)){
  Get-ChildItem -LiteralPath $root -File -Filter '*.lnk' -Recurse -Depth 3 | Select-Object -First 1000 | Where-Object {$_.BaseName -match 'DeepSeek|Claude|Cursor|Grok'} | ForEach-Object {
    $target=$shell.CreateShortcut($_.FullName).TargetPath
    if($target -and [IO.Path]::IsPathRooted($target)){$out+=@{root=[IO.Path]::GetDirectoryName($target);source='shortcut'}}
  }
}}
ConvertTo-Json -Compress -InputObject @{roots=@($out);paths=@($paths)}
`;

const probe: Probe = (command, args, env) => new Promise((resolve, reject) => {
  execFile(command, args, {windowsHide: true, timeout: 8000, maxBuffer: MAX_OUTPUT, encoding: 'utf8', env: {...process.env, ...env}}, (error, stdout, stderr) => {
    if (error) reject(new Error('客户端只读检查失败或超时'));
    else resolve((stdout + '\n' + stderr).slice(0, MAX_OUTPUT));
  });
});

async function gatherCandidates(testHooks?: NonNullable<DiscoveryOptions['testHooks']>): Promise<DiscoveryCandidate[]> {
  const result: DiscoveryCandidate[] = [];
  const extensions = process.platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : [''];
  const add = (dir: string, source: DiscoveryCandidate['source'], suffixes: string[]) => {
    if (dir && localAbsolute(dir)) for (const suffix of suffixes) result.push({path: path.resolve(dir, suffix), source});
  };
  const pathSuffixes = names.flatMap(n => extensions.map(e => n + e));
  for (const dir of pathEntries([testHooks?.processPath ?? process.env.PATH ?? ''])) add(dir, 'path', pathSuffixes);
  if (testHooks) {
    for (const dir of pathEntries(testHooks.persistedPathValues ?? [])) add(dir, 'path', pathSuffixes);
  } else {
    const user = os.homedir();
    const common = [path.join(user, '.local', 'bin'), path.join(user, '.cursor', 'bin')];
    if (process.env.APPDATA) common.push(path.join(process.env.APPDATA, 'npm'));
    if (process.env.LOCALAPPDATA) common.push(path.join(process.env.LOCALAPPDATA, 'Programs', 'claude'), path.join(process.env.LOCALAPPDATA, 'cursor-agent'));
    for (const dir of common) add(dir, 'common', pathSuffixes);
  }
  if (!testHooks && process.platform === 'win32') {
    const installBases = [process.env.ProgramFiles, process.env['ProgramFiles(x86)'], process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Programs') : undefined].filter((p): p is string => !!p);
    for (const base of installBases) {
      add(path.join(base, 'DeepSeek Harness'), 'common', ['resources/runtime/cli/bin/dsh.cmd']);
      for (const product of ['Claude', 'Grok Build', 'Cursor']) add(path.join(base, product), 'common', names.flatMap(n => ['.exe', '.cmd'].map(e => n + e)));
    }
    try {
      const ps = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
      const metadata = JSON.parse(await probe(ps, ['-NoProfile', '-NonInteractive', '-Command', WINDOWS_METADATA]));
      const rows = Array.isArray(metadata) ? metadata : metadata.roots;
      for (const dir of pathEntries(Array.isArray(metadata?.paths) ? metadata.paths : [])) add(dir, 'path', pathSuffixes);
      const installedSuffixes = ['resources/runtime/cli/bin/dsh.cmd', 'dsh.exe', 'claude.exe', 'bin/claude.exe', 'agent.exe', 'grok.exe', 'grok-build.exe', 'cursor-agent.exe', 'bin/cursor-agent.exe', 'resources/app/bin/cursor-agent.exe'];
      for (const row of Array.isArray(rows) ? rows.slice(0, 200) : []) {
        if (typeof row.root === 'string' && (row.source === 'registration' || row.source === 'shortcut')) add(row.root, row.source, installedSuffixes);
      }
    } catch { /* PATH and common locations remain usable when Windows metadata is unavailable. */ }
  }
  const unique = [...new Map(result.map(c => [process.platform === 'win32' ? c.path.toLowerCase() : c.path, c])).values()];
  const present = await Promise.all(unique.map(async c => await exists(c.path) ? c : null));
  return present.filter((c): c is DiscoveryCandidate => c !== null);
}

/** Split a bounded PATH value and expand only environment references already present in this process.
 * Unknown variables and network roots are ignored; path entries are data, never commands. */
export function pathEntries(values: string[], env: NodeJS.ProcessEnv = process.env): string[] {
  const variables = new Map(Object.entries(env).filter((entry): entry is [string, string] => typeof entry[1] === 'string').map(([name, value]) => [name.toLowerCase(), value]));
  variables.delete('path');
  const result: string[] = [];
  let total = 0;
  for (const value of values.slice(0, 2)) {
    if (typeof value !== 'string' || !value || total + value.length > MAX_PATH_VALUE_CHARS) continue;
    total += value.length;
    const delimiter = process.platform === 'win32' ? ';' : path.delimiter;
    for (const raw of value.split(delimiter).slice(0, MAX_PATH_ENTRIES - result.length)) {
      let dir = raw.trim().replace(/^"(.*)"$/, '$1');
      dir = dir.replace(/%([^%]+)%/g, (whole, name: string) => variables.get(name.toLowerCase()) ?? whole);
      if (dir.includes('%') || !localAbsolute(dir)) continue;
      result.push(path.resolve(dir));
    }
    if (result.length >= MAX_PATH_ENTRIES) break;
  }
  return [...new Map(result.map(dir => [process.platform === 'win32' ? dir.toLowerCase() : dir, dir])).values()];
}

type Launch = {executable: string; prefixArgs: string[]; env?: Record<string, string>; files: string[]};
/** Resolve only recognized, data-only launcher forms. Never feed a .cmd/.bat or prompt to a shell. */
export async function resolveClientLauncher(candidatePath: string): Promise<Launch> {
  if (!localAbsolute(candidatePath)) throw new Error('客户端必须位于本机绝对路径');
  const file = path.resolve(candidatePath);
  if (/\.cmd$/i.test(file)) {
    const name = path.basename(file).toLowerCase();
    const hasCursorScript = await exists(path.join(path.dirname(file), 'cursor-agent.ps1'));
    if (name === 'cursor-agent.cmd' && hasCursorScript) return resolveCursorAgentLauncher(file);
    if (name === 'agent.cmd' && hasCursorScript) {
      try {return await resolveCursorAgentLauncher(file)} catch { /* A non-Cursor npm shim may share the generic agent name. */ }
    }
  }
  const realFile = await fs.realpath(file);
  if (!localAbsolute(realFile)) throw new Error('客户端不能链接到网络路径');
  if (!/\.(?:cmd|bat)$/i.test(file)) return {executable: file, prefixArgs: [], files: [file]};
  const stat = await fs.stat(file);
  if (stat.size > MAX_CURSOR_SCRIPT_BYTES) throw new Error('无法安全识别客户端启动脚本');
  const script = await fs.readFile(file, 'utf8');
  const base = path.dirname(file);
  // Official DeepSeek desktop launcher: bypass cmd.exe, preserve Electron's Node mode.
  const desktop = script.match(/^\s*"%~dp0([^"\r\n]+DeepSeek Harness\.exe)"\s+--expose-internals\s+"%~dp0([^"\r\n]+@deepseek-ai[\\/]dsh-desktop-host[\\/]lib[\\/]cli\.js)"\s+%\*\s*$/mi);
  if (desktop) {
    const exe = path.resolve(base, desktop[1]);
    const entry = path.resolve(base, desktop[2]);
    const archive = entry.match(/^(.*[\\/]app\.asar)(?:[\\/]|$)/i)?.[1];
    if (!await exists(exe) || !archive || !await exists(archive)) throw new Error('客户端安装文件不完整');
    return {executable: exe, prefixArgs: ['--expose-internals', entry], env: {ELECTRON_RUN_AS_NODE: '1'}, files: [file, exe, archive]};
  }
  // npm's generated shim has a literal node_modules entry. Interpret only that path;
  // package identity and CLI help are independently checked below.
  const entryMatch = script.match(/"%(?:dp0|~dp0)%?[\\/]?(node_modules[\\/][^"\r\n]+\.(?:[cm]?js))"\s+%\*/i);
  if (entryMatch) {
    const entry = path.resolve(base, entryMatch[1]);
    const relative = path.relative(base, entry);
    if (relative.startsWith('..') || path.isAbsolute(relative) || !await exists(entry)) throw new Error('客户端启动脚本路径无效');
    const localNode = path.join(base, 'node.exe');
    const exe = await exists(localNode) ? localNode : process.execPath;
    return {executable: exe, prefixArgs: [entry], files: [file, exe, entry]};
  }
  throw new Error('不支持的启动脚本；请使用官方 CLI 原生入口');
}

function identify(help: string): ClientKind | null {
  // Grok may be installed as agent.exe; product identity wins over file names.
  if (/Grok Build\b|Usage:\s*grok\b/i.test(help)) return 'grok';
  if (/DeepSeek Harness/i.test(help)) return 'dsh';
  if (/Claude Code/i.test(help)) return 'claude';
  if (/Cursor Agent|Cursor CLI/i.test(help) && !/Visual Studio Code/i.test(help)) return 'cursor';
  return null;
}
function expectedKinds(file: string): ClientKind[] {
  const name = path.basename(file).toLowerCase();
  if (name.startsWith('dsh')) return ['dsh'];
  if (name.startsWith('claude')) return ['claude'];
  if (name.startsWith('cursor-agent')) return ['cursor'];
  if (name.startsWith('grok')) return ['grok'];
  return [];
}
function flags(help: string) {return [...new Set(help.match(/--[a-z][a-z0-9-]*/g) ?? [])];}
export function supportsCursorPlanMode(help: string | undefined) {
  const mode = help?.match(/--mode\s+<mode>([\s\S]{0,768})/i)?.[1] ?? '';
  return /\bplan:\s*read-only\/planning\b[\s\S]{0,384}?\(choices:\s*"plan"/i.test(mode);
}
function emptyRecord(kind: ClientKind, checkedAt: string): ClientRecord {
  return {kind, label: LABELS[kind], status: 'missing', reason: '未发现可验证的官方 CLI；登录与额度尚未检查', checkedAt, ...unknownState};
}
function machineKey(options: DiscoveryOptions) {
  return options.testHooks?.machineId ?? digest([os.hostname(), os.platform(), os.arch(), os.homedir(), process.env.PATH ?? '', process.execPath].join('\n'));
}
function machineIdentity() {return digest([os.hostname(), os.platform(), os.arch(), os.homedir()].join('\n'));}
async function readOverrides(dataDir: string): Promise<Partial<Record<ClientKind, string>>> {
  try {
    const saved = JSON.parse(await fs.readFile(path.join(dataDir, OVERRIDE_FILE), 'utf8'));
    if (saved.schema !== 1 || saved.machine !== machineIdentity() || !saved.paths || typeof saved.paths !== 'object') return {};
    return Object.fromEntries(KINDS.filter(k => typeof saved.paths[k] === 'string' && localAbsolute(saved.paths[k])).map(k => [k, saved.paths[k]]));
  } catch {return {};}
}
async function inspectCandidate(candidatePath: string, run: Probe, checkedAt: string): Promise<ClientRecord> {
  const launch = await resolveClientLauncher(candidatePath);
  const help = await run(launch.executable, [...launch.prefixArgs, '--help'], launch.env);
  const kind = identify(help);
  if (!kind) throw new Error('产品身份不匹配');
  const versionText = await run(launch.executable, [...launch.prefixArgs, '--version'], launch.env);
  const cursorVersion = kind === 'cursor' ? versionText.trim().split(/\r?\n/, 1)[0]?.trim() : undefined;
  const version = cursorVersion ? (parseCursorVersionName(cursorVersion) ? cursorVersion : undefined) : versionText.match(/\b\d+\.\d+\.\d+(?:[-+][a-zA-Z0-9.-]+)?\b/)?.[0];
  if (!version) throw new Error('无法验证客户端版本');
  const fullHelp = kind === 'dsh' ? help + '\n' + await run(launch.executable, [...launch.prefixArgs, '--profile', 'headless', '--help'], launch.env) : help;
  return {...emptyRecord(kind, checkedAt), status: 'verified', reason: kind === 'cursor' ? 'CLI 已验证；当前安全调用仅支持审查与建议，未启用自动修改权限' : 'CLI 身份和版本已验证；登录、额度和实际调用尚未检查', version, executable: launch.executable, prefixArgs: launch.prefixArgs, env: launch.env, candidatePath, help: fullHelp, supportedFlags: flags(fullHelp), fingerprints: await Promise.all(launch.files.map(async file => ({path: file, value: await fingerprint(file)})))};
}
async function readValidCache(options: DiscoveryOptions, machine: string, now: number): Promise<ClientRecord[] | null> {
  try {
    const cached = JSON.parse(await fs.readFile(path.join(options.dataDir, CACHE_FILE), 'utf8'));
    if (cached.schema !== CACHE_VERSION || cached.machine !== machine || !Number.isFinite(cached.createdAt) || now < cached.createdAt || now - cached.createdAt >= CACHE_TTL || !Array.isArray(cached.records) || cached.records.length !== KINDS.length) return null;
    for (const kind of KINDS) {
      const record = cached.records.find((r: ClientRecord) => r.kind === kind);
      if (!record || !['verified', 'missing', 'unverified'].includes(record.status)) return null;
      if (record.status === 'verified') {
        if (!record.executable || !path.isAbsolute(record.executable) || !Array.isArray(record.fingerprints) || !record.fingerprints.length || !Array.isArray(record.prefixArgs) || !record.version || !record.help || identify(record.help) !== record.kind) return null;
        if (typeof record.candidatePath !== 'string') return null;
        const launch = await resolveClientLauncher(record.candidatePath);
        if (launch.executable !== record.executable || JSON.stringify(launch.prefixArgs) !== JSON.stringify(record.prefixArgs) || JSON.stringify(launch.env ?? {}) !== JSON.stringify(record.env ?? {}) || launch.files.length !== record.fingerprints.length) return null;
        for (const file of launch.files) {
          const item = record.fingerprints.find((f: {path: string; value: string}) => f.path === file);
          if (!item || await fingerprint(file) !== item.value) return null;
        }
        record.supportedFlags = flags(record.help);
      }
    }
    return cached.records;
  } catch {return null;}
}

export async function discoverAgentClients(options: DiscoveryOptions): Promise<ClientRecord[]> {
  const now = options.testHooks?.now ?? Date.now();
  const machine = machineKey(options);
  if (!options.force) {const cached = await readValidCache(options, machine, now); if (cached) return cached;}
  const checkedAt = new Date(now).toISOString();
  const records = KINDS.map(kind => emptyRecord(kind, checkedAt));
  const overrides: Partial<Record<ClientKind, string>> = options.testHooks ? {} : await readOverrides(options.dataDir);
  const overrideCandidates = Object.values(overrides).map(file => ({path: file, source: 'common' as const}));
  const candidates = [...overrideCandidates, ...(options.testHooks?.candidates ?? await gatherCandidates(options.testHooks))];
  const run = options.testHooks?.probe ?? probe;
  for (const candidate of candidates) {
    try {
      const verified = await inspectCandidate(candidate.path, run, checkedAt);
      const designated = KINDS.find(k => overrides[k] === candidate.path);
      if (designated && designated !== verified.kind) throw new Error('手动入口产品身份已变化');
      const target = records.find(r => r.kind === verified.kind)!;
      if (target.status === 'verified') continue;
      Object.assign(target, verified);
    } catch {
      for (const kind of expectedKinds(candidate.path)) {
        const target = records.find(r => r.kind === kind)!;
        if (target.status !== 'verified') Object.assign(target, {status: 'unverified', reason: '发现候选入口，但产品身份、版本或安全启动方式未通过验证'});
      }
    }
  }
  await fs.mkdir(options.dataDir, {recursive: true});
  const cachePath = path.join(options.dataDir, CACHE_FILE);
  const temporary = `${cachePath}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporary, JSON.stringify({schema: CACHE_VERSION, machine, createdAt: now, records}, null, 2), {encoding: 'utf8', mode: 0o600, flag: 'wx'});
    await fs.rename(temporary, cachePath);
  } finally {await fs.rm(temporary, {force: true}).catch(() => {});}
  return records;
}

export function publicClientCapabilities(records: ClientRecord[]): ClientCapability[] {
  const requiredFlags: Record<ClientKind, string[]> = {
    dsh: ['--profile', '--patch', '--json'],
    claude: ['--print', '--output-format', '--verbose', '--model', '--permission-mode'],
    cursor: ['--print', '--mode', '--output-format', '--model', '--workspace'],
    grok: ['--prompt-file', '--cwd', '--model', '--output-format', '--permission-mode'],
  };
  return records.map(({kind, label, status, reason, checkedAt, version, supportedFlags, help}) => {
    const planMode = kind !== 'cursor' || supportsCursorPlanMode(help);
    const headless = status === 'verified' && requiredFlags[kind].every(f => supportedFlags?.includes(f)) && planMode;
    return {kind, label:LABELS[kind], status, reason: status === 'verified' && !headless ? 'CLI 身份已验证，但当前版本缺少本程序需要的安全调用参数' : reason, checkedAt, version, ...unknownState, available: status === 'verified', supportsResume: headless && !!supportedFlags?.includes(kind === 'dsh' ? '--session-id' : '--resume'), executionSupported: headless && kind !== 'cursor', reviewSupported: headless};
  });
}
export async function readClientCapabilities(dataDir: string): Promise<ClientCapability[]> {return publicClientCapabilities(await discoverAgentClients({dataDir}));}
export async function resolveAgentClient(dataDir: string, kind: ClientKind): Promise<ClientRecord> {
  const record = (await discoverAgentClients({dataDir})).find(r => r.kind === kind);
  if (!record || record.status !== 'verified') throw new Error(`${LABELS[kind] ?? kind} 未发现可用且身份已验证的 CLI`);
  return record;
}

export async function setClientOverride(options: {dataDir: string; kind: ClientKind; executable: string; /** Isolated tests only. */ testHooks?: DiscoveryOptions['testHooks']}): Promise<ClientRecord[]> {
  if (!KINDS.includes(options.kind) || !localAbsolute(options.executable)) throw new Error('请选择本机 CLI 的绝对文件路径');
  const executable = await fs.realpath(options.executable);
  if (!(await fs.stat(executable)).isFile()) throw new Error('CLI 路径必须是文件');
  const verified = await inspectCandidate(executable, options.testHooks?.probe ?? probe, new Date().toISOString());
  if (verified.kind !== options.kind) throw new Error(`所选入口实际属于 ${verified.label}，与指定客户端不匹配`);
  const paths = await readOverrides(options.dataDir);
  paths[options.kind] = executable;
  await fs.mkdir(options.dataDir, {recursive: true});
  const target = path.join(options.dataDir, OVERRIDE_FILE);
  const temporary = `${target}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporary, JSON.stringify({schema: 1, machine: machineIdentity(), paths}, null, 2), {encoding: 'utf8', mode: 0o600, flag: 'wx'});
    await fs.rename(temporary, target);
  } finally {await fs.rm(temporary, {force: true}).catch(() => {});}
  return discoverAgentClients({dataDir: options.dataDir, force: true, ...(options.testHooks ? {testHooks: {...options.testHooks, candidates: [{path: executable, source: 'common'}, ...(options.testHooks.candidates ?? [])]}} : {})});
}
