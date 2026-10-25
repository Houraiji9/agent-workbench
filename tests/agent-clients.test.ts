import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {buildAgentInvocation, discoverAgentClients, publicClientCapabilities, setClientOverride, type DiscoveryOptions} from '../src/core/agent-clients.ts';
import {pathEntries, resolveClientLauncher} from '../src/core/client-discovery.ts';

const root = path.resolve(process.env.WORKBENCH_TEST_OUTPUT_DIR || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '.test-tmp'));
const helps = {
  grok: 'Grok Build TUI\nUsage: grok [OPTIONS]\n--prompt-file --cwd --model --output-format streaming-json --permission-mode default --resume',
  dsh: 'DeepSeek Harness\n--profile --patch --json --session-id',
  claude: 'Claude Code\n--print --output-format stream-json --verbose --model --permission-mode --resume',
  cursor: 'Cursor Agent CLI\n--print --mode <mode> --output-format json --model --workspace --resume\nplan: read-only/planning; ask: read-only Q&A (choices: "plan", "ask")',
};
async function fixture(t: {after: (fn: () => Promise<void>) => void}) {
  const dir = path.join(root, 'agent-clients-' + randomUUID());
  await fs.mkdir(dir, {recursive: true});
  t.after(async () => {if (process.env.WORKBENCH_RETAIN_TEST_DATA !== '1') await fs.rm(dir, {recursive: true, force: true});});
  const promptFile = path.join(dir, '任务 " ; & 提示.txt'.replace(/"/g, ''));
  await fs.writeFile(promptFile, '审查真实任务。\n保留中文与路径 C:\\a b\\代码。\n$(不会被 shell 执行) & echo secret');
  return {dir, promptFile};
}
async function candidate(dir: string, name: string) {const p = path.join(dir, name); await fs.writeFile(p, 'synthetic executable'); return p;}
function hooks(file: string, kind: keyof typeof helps, counter = {count: 0}, machineId = 'machine-a'): NonNullable<DiscoveryOptions['testHooks']> {
  return {candidates: [{path: file, source: 'path'}], machineId, now: 1000, probe: async (_exe, args) => {counter.count++; return args.at(-1) === '--version' ? kind === 'cursor' ? '2026.10.22-27dcf5f' : '1.2.3' : helps[kind];}};
}
async function record(dir: string, kind: keyof typeof helps) {
  const file = await candidate(dir, kind + '.exe');
  return (await discoverAgentClients({dataDir: path.join(dir, 'cache-' + kind), testHooks: hooks(file, kind)})).find(r => r.kind === kind)!;
}
const options = (dir: string, promptFile: string) => ({role: 'review' as const, cwd: dir, artifactDir: path.join(dir, '中文 产物 & 目录'), model: 'model-exact', promptFile, sessionId: 'session-123'});

test('agent.exe 的真实 Grok 身份不被误认为 Cursor，公开状态无本机路径', async t => {
  const {dir} = await fixture(t); const file = await candidate(dir, 'agent.exe');
  const records = await discoverAgentClients({dataDir: path.join(dir, 'data'), testHooks: hooks(file, 'grok')});
  assert.equal(records.find(r => r.kind === 'grok')?.status, 'verified');
  assert.equal(records.find(r => r.kind === 'cursor')?.status, 'missing');
  const safe = publicClientCapabilities(records);
  assert(!JSON.stringify(safe).includes(dir));
  assert(safe.every(r => r.authentication === 'unknown' && r.quota === 'unknown' && r.invocation === 'unknown'));
});

test('同机缓存复用，迁移机器、修改文件、删除入口后重新验证', async t => {
  const {dir} = await fixture(t); const file = await candidate(dir, 'grok.exe'); const dataDir = path.join(dir, 'data');
  const counter = {count: 0}; const injected = hooks(file, 'grok', counter);
  await discoverAgentClients({dataDir, testHooks: injected}); assert.equal(counter.count, 2);
  await discoverAgentClients({dataDir, testHooks: injected}); assert.equal(counter.count, 2);
  await discoverAgentClients({dataDir, testHooks: {...injected, machineId: 'machine-b'}}); assert.equal(counter.count, 4);
  await fs.appendFile(file, 'new-version');
  await discoverAgentClients({dataDir, testHooks: {...injected, machineId: 'machine-b'}}); assert.equal(counter.count, 6);
  await fs.rename(file, file + '.moved-away');
  const deleted = await discoverAgentClients({dataDir, testHooks: {...injected, machineId: 'machine-b', candidates: []}});
  assert.equal(deleted.find(r => r.kind === 'grok')?.status, 'missing');
});

test('过期、损坏及旧结构缓存不会接受历史客户端身份', async t => {
  const {dir} = await fixture(t); const file = await candidate(dir, 'grok.exe'); const dataDir = path.join(dir, 'data');
  const counter = {count: 0}; const injected = hooks(file, 'grok', counter);
  await discoverAgentClients({dataDir, testHooks: injected});
  await discoverAgentClients({dataDir, testHooks: {...injected, now: 301_001}}); assert.equal(counter.count, 4);
  await fs.writeFile(path.join(dataDir, 'local-agent-clients.json'), '{');
  await discoverAgentClients({dataDir, testHooks: injected}); assert.equal(counter.count, 6);
  await fs.writeFile(path.join(dataDir, 'local-agent-clients.json'), JSON.stringify({schema: 0, machine: 'machine-a', records: []}));
  await discoverAgentClients({dataDir, testHooks: injected}); assert.equal(counter.count, 8);
});

test('伪装的产品名称、无版本与不可识别脚本都不能被标为已验证', async t => {
  const {dir} = await fixture(t); const file = await candidate(dir, 'claude.exe');
  for (const output of ['unknown tool', helps.claude]) {
    const records = await discoverAgentClients({dataDir: path.join(dir, 'data'), force: true, testHooks: {...hooks(file, 'claude'), probe: async () => output}});
    assert.equal(records.find(r => r.kind === 'claude')?.status, 'unverified');
  }
  const cmd = await candidate(dir, 'claude.cmd');
  await fs.writeFile(cmd, '@echo off\necho pretend & dangerous-command %*');
  await assert.rejects(resolveClientLauncher(cmd), /不支持/);
});

test('DSH 官方桌面 cmd 只解析入口，直接启动 Electron Node，不使用 shell', async t => {
  const {dir} = await fixture(t);
  const bin = path.join(dir, 'resources', 'runtime', 'cli', 'bin'); await fs.mkdir(bin, {recursive: true});
  const exe = await candidate(dir, 'DeepSeek Harness.exe'); await candidate(path.join(dir, 'resources'), 'app.asar');
  const shim = path.join(bin, 'dsh.cmd');
  await fs.writeFile(shim, '@echo off\r\n"%~dp0..\\..\\..\\..\\DeepSeek Harness.exe" --expose-internals "%~dp0..\\..\\..\\app.asar\\dsh\\node_modules\\@deepseek-ai\\dsh-desktop-host\\lib\\cli.js" %*\r\n');
  const launch = await resolveClientLauncher(shim);
  assert.equal(launch.executable, exe); assert.equal(launch.env?.ELECTRON_RUN_AS_NODE, '1');
  assert.equal(launch.prefixArgs[0], '--expose-internals'); assert.equal(launch.files.length, 3);
});

test('DSH 任务级 overlay 启用账号服务、精确模型与续作，提示走 stdin', async t => {
  const {dir, promptFile} = await fixture(t); const client = await record(dir, 'dsh');
  const invoke = await buildAgentInvocation(client, {...options(dir, promptFile), model: 'deepseek-flash'});
  assert.deepEqual(invoke.args.slice(0, 2), ['--profile', 'headless']);
  assert.equal(invoke.args[invoke.args.indexOf('--session-id') + 1], 'session-123');
  assert.equal(invoke.stdin, await fs.readFile(promptFile, 'utf8'));
  const overlayPath = invoke.args[invoke.args.indexOf('--patch') + 1];
  assert.equal(path.dirname(overlayPath), options(dir, promptFile).artifactDir);
  const overlay = JSON.parse(await fs.readFile(overlayPath, 'utf8'));
  assert(overlay.some((p: {id: string}) => p.id === 'deepseek-account'));
  assert.deepEqual(overlay.at(-1).config, {provider: 'deepseek-account', model: 'deepseek-flash'});
  assert(!JSON.stringify(invoke).match(/always-approve|yolo|bypassPermissions/));
});

test('DSH 的 GLM provider 单独选择，overlay 值不能注入 YAML', async t => {
  const {dir, promptFile} = await fixture(t); const client = await record(dir, 'dsh');
  const invoke = await buildAgentInvocation(client, {...options(dir, promptFile), model: 'glm-5.3'});
  const patches = JSON.parse(await fs.readFile(invoke.args[invoke.args.indexOf('--patch') + 1], 'utf8'));
  assert.deepEqual(patches.at(-1).config, {provider: 'zai-coding-cn', model: 'glm-5.3'});
  assert(!patches.some((p: {id: string}) => p.id === 'deepseek-account'));
  await assert.rejects(buildAgentInvocation(client, {...options(dir, promptFile), provider: 'x\n- id: injected'}), /provider 无效/);
});

test('Grok 传真实 prompt 文件、模型、cwd 和 resume，空格中文符号保持 argv 边界', async t => {
  const {dir, promptFile} = await fixture(t); const client = await record(dir, 'grok');
  const invoke = await buildAgentInvocation(client, options(dir, promptFile));
  assert.equal(invoke.args[invoke.args.indexOf('--prompt-file') + 1], promptFile);
  assert.equal(invoke.args[invoke.args.indexOf('--cwd') + 1], dir);
  assert.equal(invoke.args[invoke.args.indexOf('--model') + 1], 'model-exact');
  assert.equal(invoke.args[invoke.args.indexOf('--resume') + 1], 'session-123');
  assert.equal(invoke.args[invoke.args.indexOf('--permission-mode') + 1], 'default');
  assert(!invoke.args.includes('--session-id')); assert.equal(invoke.stdin, undefined);
});

test('Claude 使用 stdin 与订阅兼容模式，不注入 --bare 或权限绕过', async t => {
  const {dir, promptFile} = await fixture(t); const client = await record(dir, 'claude');
  const invoke = await buildAgentInvocation(client, options(dir, promptFile));
  assert(invoke.args.includes('--print')); assert(invoke.args.includes('--verbose'));
  assert.equal(invoke.args[invoke.args.indexOf('--output-format') + 1], 'stream-json');
  assert.equal(invoke.stdin, await fs.readFile(promptFile, 'utf8')); assert(!invoke.args.includes('--bare'));
});

test('Cursor 只读审查引用任务文件，执行不得静默打开 force', async t => {
  const {dir, promptFile} = await fixture(t); const client = await record(dir, 'cursor');
  const invoke = await buildAgentInvocation(client, options(dir, promptFile));
  assert.equal(invoke.args[invoke.args.indexOf('--mode') + 1], 'plan');
  assert.equal(invoke.args[invoke.args.indexOf('--workspace') + 1], dir);
  assert(invoke.args.at(-1)?.includes(JSON.stringify(promptFile)));
  assert(!invoke.args.includes('--force')); assert(!invoke.args.includes('--yolo'));
  const capability = publicClientCapabilities([client])[0];
  assert.equal(capability.executionSupported, false); assert.equal(capability.reviewSupported, true);
  const noPlanMode = {...client, supportedFlags: client.supportedFlags?.filter(flag => flag !== '--mode')};
  assert.equal(publicClientCapabilities([noPlanMode])[0].reviewSupported, false);
  await assert.rejects(buildAgentInvocation(noPlanMode, options(dir, promptFile)), /未确认支持/);
  const planNotDocumented = {...client, help: 'Cursor Agent CLI\n--mode <mode> ask: Q&A (choices: "ask")'};
  assert.equal(publicClientCapabilities([planNotDocumented])[0].reviewSupported, false);
  await assert.rejects(buildAgentInvocation(planNotDocumented, options(dir, promptFile)), /未确认支持只读 plan 模式/);
  await assert.rejects(buildAgentInvocation(client, {...options(dir, promptFile), role: 'execution'}), /仅支持审查/);
});

test('缺失、未知参数支持、相对路径与空提示在启动前明确失败', async t => {
  const {dir, promptFile} = await fixture(t); const client = await record(dir, 'grok');
  await assert.rejects(buildAgentInvocation({...client, status: 'missing'}, options(dir, promptFile)), /未验证/);
  await assert.rejects(buildAgentInvocation({...client, supportedFlags: []}, options(dir, promptFile)), /未确认支持/);
  await assert.rejects(buildAgentInvocation(client, {...options(dir, promptFile), cwd: 'relative'}), /绝对路径/);
  await fs.writeFile(promptFile, '');
  await assert.rejects(buildAgentInvocation(client, options(dir, promptFile)), /不能为空/);
});

test('手动指定位置必须验证对应产品，身份冲突不持久化', async t => {
  const {dir} = await fixture(t); const file = await candidate(dir, 'agent.exe'); const dataDir = path.join(dir, 'data');
  await assert.rejects(setClientOverride({dataDir, kind: 'cursor', executable: file, testHooks: hooks(file, 'grok')}), /实际属于 Grok Build/);
  await assert.rejects(fs.stat(path.join(dataDir, 'local-agent-client-overrides.json')), /ENOENT/);
  const records = await setClientOverride({dataDir, kind: 'grok', executable: file, testHooks: hooks(file, 'grok')});
  assert.equal(records.find(r => r.kind === 'grok')?.status, 'verified');
  const persisted = JSON.parse(await fs.readFile(path.join(dataDir, 'local-agent-client-overrides.json'), 'utf8'));
  assert.equal(persisted.paths.grok, await fs.realpath(file));
  await assert.rejects(setClientOverride({dataDir, kind: 'grok', executable: 'grok --always-approve'}), /绝对/);
  await assert.rejects(setClientOverride({dataDir, kind: 'grok', executable: '\\\\server\\share\\grok.exe'}), /本机/);
});

test('产品与版本正确仍需有安全 headless 参数才声明角色支持', async t => {
  const {dir} = await fixture(t); const client = await record(dir, 'claude');
  const [capability] = publicClientCapabilities([{...client, supportedFlags: ['--model']}]);
  assert.equal(capability.available, true); assert.equal(capability.executionSupported, false); assert.equal(capability.reviewSupported, false);
  assert.match(capability.reason, /缺少/);
});

test('缓存不能注入额外启动参数或权限环境变量', async t => {
  const {dir} = await fixture(t); const file = await candidate(dir, 'grok.exe'); const dataDir = path.join(dir, 'data');
  const counter = {count: 0}; const injected = hooks(file, 'grok', counter);
  await discoverAgentClients({dataDir, testHooks: injected});
  const cacheFile = path.join(dataDir, 'local-agent-clients.json');
  const cache = JSON.parse(await fs.readFile(cacheFile, 'utf8'));
  cache.records.find((r: {kind: string}) => r.kind === 'grok').prefixArgs = ['--always-approve'];
  await fs.writeFile(cacheFile, JSON.stringify(cache));
  const records = await discoverAgentClients({dataDir, testHooks: injected});
  assert.equal(counter.count, 4); assert.deepEqual(records.find(r => r.kind === 'grok')?.prefixArgs, []);
});

test('npm shim 解析固定脚本入口，拒绝目录穿越且不把参数送到 cmd', async t => {
  const {dir} = await fixture(t); const moduleDir = path.join(dir, 'node_modules', 'client');
  await fs.mkdir(moduleDir, {recursive: true}); const entry = await candidate(moduleDir, 'cli.js');
  const shim = path.join(dir, 'claude.cmd');
  await fs.writeFile(shim, '@echo off\n"%_prog%" "%dp0%\\node_modules\\client\\cli.js" %*');
  const launch = await resolveClientLauncher(shim);
  assert.equal(launch.executable, process.execPath); assert.deepEqual(launch.prefixArgs, [entry]);
  await fs.writeFile(shim, '@echo off\n"%_prog%" "%dp0%\\node_modules\\..\\..\\outside.js" %*');
  await assert.rejects(resolveClientLauncher(shim), /路径无效/);

  const agentModule = path.join(dir, 'node_modules', 'grok-agent'); await fs.mkdir(agentModule, {recursive: true});
  const agentEntry = await candidate(agentModule, 'cli.js'), agentShim = path.join(dir, 'agent.cmd');
  await fs.writeFile(agentShim, '@echo off\n"%_prog%" "%dp0%\\node_modules\\grok-agent\\cli.js" %*');
  const agentLaunch = await resolveClientLauncher(agentShim);
  assert.equal(agentLaunch.executable, process.execPath); assert.deepEqual(agentLaunch.prefixArgs, [agentEntry]);

  const cursorModule = path.join(dir, 'node_modules', 'cursor-agent'); await fs.mkdir(cursorModule, {recursive: true});
  const cursorEntry = await candidate(cursorModule, 'cli.js'), cursorShim = path.join(dir, 'cursor-agent.cmd');
  await fs.writeFile(cursorShim, '@echo off\n"%_prog%" "%dp0%\\node_modules\\cursor-agent\\cli.js" %*');
  const cursorLaunch = await resolveClientLauncher(cursorShim);
  assert.equal(cursorLaunch.executable, process.execPath); assert.deepEqual(cursorLaunch.prefixArgs, [cursorEntry]);
});

test('persistent PATH entries are bounded data and expand known variables without commands', async t => {
  const {dir} = await fixture(t);
  const entries = pathEntries([`"${dir}"; %LOCALAPPDATA%\\Programs\\Cursor;\\\\server\\share\\bin`, 'C:\\tools\\%UNKNOWN%'], {LOCALAPPDATA: dir, PATH: 'must-not-expand'});
  assert(entries.includes(dir));
  assert(entries.includes(path.join(dir, 'Programs', 'Cursor')));
  assert(!entries.some(entry => entry.startsWith('\\\\')));
  assert(!entries.some(entry => entry.includes('%')));
  assert(!entries.includes('must-not-expand'));
});

async function cursorLayout(dir: string, version = '2026.10.22-27dcf5f', additionalVersions: string[] = []) {
  const rootDir = path.join(dir, 'cursor-cli'), versionDir = path.join(rootDir, 'versions', version);
  await fs.mkdir(path.join(rootDir, 'versions'), {recursive: true});
  const wrapper = path.join(rootDir, 'cursor-agent.cmd'), ps1 = path.join(rootDir, 'cursor-agent.ps1');
  const entry = path.join(versionDir, 'index.js'), node = path.join(versionDir, 'node.exe'), metadata = path.join(versionDir, 'package.json');
  await fs.writeFile(wrapper, [
    '@echo off', 'rem cursor-agent-promote-staged',
    'if exist "%~dp0versions\\promote-staged.cmd" call "%~dp0versions\\promote-staged.cmd"',
    'if errorlevel 1 exit /b 1', '@echo off', 'setlocal enabledelayedexpansion',
    'set "CURSOR_INVOKED_AS=%~nx0"', 'set "SCRIPT_DIR=%~dp0"',
    'if "%SCRIPT_DIR:~-1%"=="\\" set "SCRIPT_DIR=%SCRIPT_DIR:~0,-1%"',
    '%SystemRoot%\\System32\\WindowsPowerShell\\v1.0\\powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%SCRIPT_DIR%\\cursor-agent.ps1" %*', '',
  ].join('\r\n'));
  await fs.writeFile(ps1, cursorPs1Template);
  for (const versionName of [version, ...additionalVersions]) {
    const current = path.join(rootDir, 'versions', versionName);
    await fs.mkdir(current, {recursive: true});
    await fs.writeFile(path.join(current, 'package.json'), JSON.stringify({name: '@anysphere/agent-cli-runtime'}));
    await fs.writeFile(path.join(current, 'node.exe'), 'synthetic Node runtime ' + versionName);
    await fs.writeFile(path.join(current, 'index.js'), 'synthetic Cursor entry ' + versionName);
  }
  return {rootDir, wrapper, ps1, versionDir, entry, node, metadata};
}

const cursorPs1Template = String.raw`# cursor-agent-promote-staged
$promoteStaged = Join-Path (Split-Path -Parent $MyInvocation.MyCommand.Definition) "versions\promote-staged.cmd"
if (Test-Path -LiteralPath $promoteStaged) {
  & $promoteStaged
  if ($null -ne $LASTEXITCODE -and $LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
}
if (-not $env:CURSOR_INVOKED_AS) {
    $env:CURSOR_INVOKED_AS = Split-Path -leaf $MyInvocation.MyCommand.Name
}
$scriptPath = Split-Path -parent $MyInvocation.MyCommand.Definition
function Parse-VersionString {
    param (
        [string]$versionString
    )
    $datePart = $versionString.Split('-')[0]
    $parts = $datePart.Split('.')
    if ($parts.Length -ne 3) {
        throw "Invalid version format. Expected format: YYYY.MM.DD-commit"
    }
    $year = $parts[0]
    $month = $parts[1].PadLeft(2, '0')
    $day = $parts[2].PadLeft(2, '0')
    return [int]($year + $month + $day)
}
if (-not $env:NODE_COMPILE_CACHE) {
    $env:NODE_COMPILE_CACHE = "$env:LOCALAPPDATA\cursor-compile-cache"
}
if (Test-Path "$scriptPath\node.exe") {
    & "$scriptPath\node.exe" "$scriptPath\index.js" $args
    exit $LASTEXITCODE
}
$versionDir = Get-ChildItem -Path "$scriptPath\versions" -Directory |
    Where-Object {
        $name = $_.Name
        $name -match '^\d{4}\.\d{1,2}\.\d{1,2}(-\d{2}-\d{2}-\d{2})?-[a-f0-9]+$'
    } |
    Sort-Object { Parse-VersionString $_.Name } -Descending |
    Select-Object -First 1
if (-not $versionDir) {
    Write-Error "No version directories found in $scriptPath"
    exit 1
}
$versionName = $versionDir.Name
$nodePath = "$scriptPath\versions\$versionName\node.exe"
& "$nodePath" "$scriptPath\versions\$versionName\index.js" $args
exit $LASTEXITCODE
`;

test('Cursor Windows wrapper is parsed as data and resolves directly to a pinned Node entry', async t => {
  const {dir} = await fixture(t), layout = await cursorLayout(dir);
  const launch = await resolveClientLauncher(layout.wrapper);
  assert.equal(launch.executable, layout.node);
  assert.deepEqual(launch.prefixArgs, [layout.entry]);
  assert.equal(launch.env?.CURSOR_INVOKED_AS, 'cursor-agent.cmd');
  assert.deepEqual(launch.files, [layout.wrapper, layout.ps1, layout.metadata, layout.node, layout.entry]);
});

test('Cursor discovery probes only the validated Node entry and retains the full date-hash version', async t => {
  const {dir} = await fixture(t), layout = await cursorLayout(dir), calls: string[][] = [];
  const records = await discoverAgentClients({
    dataDir: path.join(dir, 'data'), force: true,
    testHooks: {candidates: [{path: layout.wrapper, source: 'path'}], machineId: 'cursor-machine', now: 1000,
      probe: async (exe, args) => {assert.equal(exe, layout.node); calls.push(args); return args.at(-1) === '--version' ? '2026.10.22-27dcf5f' : helps.cursor;}},
  });
  const client = records.find(r => r.kind === 'cursor')!;
  assert.equal(client.status, 'verified'); assert.equal(client.version, '2026.10.22-27dcf5f');
  const capability = publicClientCapabilities([client])[0];
  assert.equal(capability.reviewSupported, true); assert.equal(capability.executionSupported, false);
  assert.deepEqual(calls, [[layout.entry, '--help'], [layout.entry, '--version']]);
  assert(client.fingerprints?.some(f => f.path === layout.wrapper));
  assert(client.fingerprints?.some(f => f.path === layout.ps1));
  const testHooks = {candidates: [{path: layout.wrapper, source: 'path' as const}], machineId: 'cursor-machine', now: 1000,
    probe: async (exe: string, args: string[]) => {assert.equal(exe, layout.node); calls.push(args); return args.at(-1) === '--version' ? '2026.10.22-27dcf5f' : helps.cursor;}};
  await discoverAgentClients({dataDir: path.join(dir, 'data'), testHooks});
  assert.equal(calls.length, 2, 'verified Cursor cache should avoid repeat probes');
  await fs.appendFile(layout.entry, '\nentry update');
  const refreshed = await discoverAgentClients({dataDir: path.join(dir, 'data'), testHooks});
  assert.equal(refreshed.find(r => r.kind === 'cursor')?.status, 'verified');
  assert.equal(calls.length, 4, 'changed Cursor entry must invalidate the cached fingerprint');
});

test('Cursor wrapper rejects extra commands, wrong version rules, and version-directory links', async t => {
  const {dir} = await fixture(t), layout = await cursorLayout(dir);
  await fs.appendFile(layout.wrapper, '\r\ndel dangerous.flag\r\n');
  await assert.rejects(resolveClientLauncher(layout.wrapper), /支持/);

  const badRule = await cursorLayout(path.join(dir, 'bad-rule'));
  const cursorRule = String.raw`^\d{4}\.\d{1,2}\.\d{1,2}(-\d{2}-\d{2}-\d{2})?-[a-f0-9]+$`;
  await fs.writeFile(badRule.ps1, (await fs.readFile(badRule.ps1, 'utf8')).replace(`'${cursorRule}'`, "'bad-rule'"));
  await assert.rejects(resolveClientLauncher(badRule.wrapper), /支持/);

  const extraCommand = await cursorLayout(path.join(dir, 'extra-command'));
  await fs.appendFile(extraCommand.ps1, '\r\nRemove-Item -Force dangerous.flag\r\n');
  await assert.rejects(resolveClientLauncher(extraCommand.wrapper), /支持/);

  const outside = path.join(dir, 'outside-version'); await fs.mkdir(outside, {recursive: true});
  const linked = await cursorLayout(path.join(dir, 'linked-version'));
  await fs.rename(linked.versionDir, linked.versionDir + '.held');
  await fs.symlink(outside, linked.versionDir, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(resolveClientLauncher(linked.wrapper));
});

test('Cursor selects the newest date version and rejects ambiguous same-day builds', async t => {
  const {dir} = await fixture(t);
  const layout = await cursorLayout(dir, '2026.10.21-1111111', ['2026.10.23-3333333']);
  const selected = await resolveClientLauncher(layout.wrapper);
  assert.equal(selected.executable, path.join(layout.rootDir, 'versions', '2026.10.23-3333333', 'node.exe'));
  assert.deepEqual(selected.prefixArgs, [path.join(layout.rootDir, 'versions', '2026.10.23-3333333', 'index.js')]);

  const sameDay = await cursorLayout(path.join(dir, 'same-day'), '2026.10.23-aaaaaaaa', ['2026.10.23-bbbbbbbb']);
  await assert.rejects(resolveClientLauncher(sameDay.wrapper), /同日/);
});

test('gatherCandidates discovers User and Machine PATH entries when process PATH omits them', async t => {
  const {dir} = await fixture(t), processPath = path.join(dir, 'process-path'), machinePath = path.join(dir, 'machine-path');
  const cursor = await cursorLayout(path.join(dir, 'user-cli'));
  await fs.mkdir(processPath, {recursive: true}); await fs.mkdir(machinePath, {recursive: true});
  const claude = path.join(machinePath, 'claude.exe'); await candidate(machinePath, 'claude.exe');
  const records = await discoverAgentClients({
    dataDir: path.join(dir, 'data'), force: true,
    testHooks: {processPath, persistedPathValues: [path.dirname(cursor.wrapper), machinePath], machineId: 'persisted-path-machine', now: 1000,
      probe: async (exe, args) => {
        if (exe === claude) return args.at(-1) === '--version' ? '2.1.310' : helps.claude;
        assert.equal(exe, cursor.node);
        return args.at(-1) === '--version' ? '2026.10.22-27dcf5f' : helps.cursor;
      }},
  });
  assert.notEqual(processPath, path.dirname(cursor.wrapper));
  assert.equal(records.find(r => r.kind === 'cursor')?.status, 'verified');
  assert.equal(records.find(r => r.kind === 'cursor')?.candidatePath, cursor.wrapper);
  assert.equal(records.find(r => r.kind === 'claude')?.status, 'verified');
  assert.equal(records.find(r => r.kind === 'claude')?.candidatePath, claude);
});

test('Cursor entry ancestors and same-root PowerShell symlinks are rejected', async t => {
  const {dir} = await fixture(t), layout = await cursorLayout(dir);
  const alias = path.join(dir, 'cursor-cli-alias');
  await fs.symlink(layout.rootDir, alias, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(resolveClientLauncher(path.join(alias, 'cursor-agent.cmd')));

  const lstat = fs.lstat;
  const injected = async (...args: Parameters<typeof fs.lstat>) => {
    const stat = await lstat(...args);
    if (path.resolve(String(args[0])).toLowerCase() !== path.resolve(layout.ps1).toLowerCase()) return stat;
    const linked = Object.create(stat); linked.isSymbolicLink = () => true; return linked;
  };
  Object.assign(fs, {lstat: injected as typeof fs.lstat});
  try {await assert.rejects(resolveClientLauncher(layout.wrapper));}
  finally {Object.assign(fs, {lstat});}
});
