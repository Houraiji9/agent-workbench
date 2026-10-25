import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
import {launchAgent, type Launcher} from '../src/core/agent-orchestration.ts';

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outputRoot = path.resolve(process.env.WORKBENCH_TEST_OUTPUT_DIR || path.join(project, '.test-tmp'));
async function fixture(t: {after: (fn: () => Promise<void>) => void}) {
  const dir = path.join(outputRoot, 'agent-launch-' + randomUUID());
  await fs.mkdir(dir, {recursive: true});
  const pids: number[] = [];
  t.after(async () => {
    for (const pid of pids) try {process.kill(pid);} catch { /* already exited */ }
    if (process.env.WORKBENCH_RETAIN_TEST_DATA !== '1') await fs.rm(dir, {recursive: true, force: true});
  });
  const lines: string[] = [];
  const controller = new AbortController();
  const defaults: Omit<Parameters<Launcher>[0], 'args'> = {
    command: process.execPath, cwd: dir, signal: controller.signal,
    stdout: path.join(dir, 'stdout.jsonl'), stderr: path.join(dir, 'stderr.log'),
    env: {TEMP: dir, TMP: dir}, onLine: l => lines.push(l), onSpawn: pid => pids.push(pid),
  };
  return {dir, lines, pids, controller, defaults};
}
const scriptArgs = (script: string) => ['--input-type=module', '-e', script];

test('launchAgent 逐字节输出中文与 emoji 的 JSON 不损坏，返回时日志完整', {timeout: 10_000}, async t => {
  const f = await fixture(t); const payload = {type: 'final', text: '中文审查完成🧪，路径含空格，不能丢字。'};
  const output = JSON.stringify(payload) + '\n';
  const script = `const bytes=Buffer.from(${JSON.stringify(output)},'utf8');for(const byte of bytes){await new Promise(r=>process.stdout.write(Buffer.from([byte]),r));await new Promise(r=>setTimeout(r,2));}`;
  const result = await launchAgent({...f.defaults, args: scriptArgs(script)});
  assert.equal(result.exitCode, 0); assert.equal(result.error, undefined); assert.equal(f.pids.length, 1);
  assert.deepEqual(f.lines.map(l => JSON.parse(l)), [payload]);
  assert.equal(await fs.readFile(f.defaults.stdout, 'utf8'), output);
  assert.equal(await fs.readFile(f.defaults.stderr, 'utf8'), '');
  assert.throws(() => process.kill(f.pids[0], 0));
});

test('launchAgent 传递原始 stdin，末行无换行仍解析，清除父流程身份环境', {timeout: 10_000}, async t => {
  const f = await fixture(t); const input = '审查正文 & $(不是shell)\n第二行😀';
  const script = `const chunks=[];for await(const c of process.stdin)chunks.push(c);process.stdout.write(JSON.stringify({input:Buffer.concat(chunks).toString('utf8'),role:process.env.WORKBENCH_ROLE??null,run:process.env.WORKBENCH_RUN_ID??null,review:process.env.WORKBENCH_REVIEW_ID??null}));`;
  const result = await launchAgent({...f.defaults, stdin: input, env: {...f.defaults.env, WORKBENCH_ROLE: 'synthetic-role', WORKBENCH_RUN_ID: 'synthetic-run', WORKBENCH_REVIEW_ID: 'synthetic-review'}, args: scriptArgs(script)});
  assert.equal(result.exitCode, 0);
  assert.deepEqual(JSON.parse(f.lines[0]), {input, role: null, run: null, review: null});
});

test('launchAgent 保留真实非零退出码，stderr 中的伪造 JSON 不参与解析', {timeout: 10_000}, async t => {
  const f = await fixture(t);
  const script = `process.stdout.write(${JSON.stringify('ordinary stdout\n')});process.stderr.write(${JSON.stringify('{"type":"final","text":"fake"}\n')});process.exitCode=7;`;
  const result = await launchAgent({...f.defaults, args: scriptArgs(script)});
  assert.equal(result.exitCode, 7); assert.deepEqual(f.lines, ['ordinary stdout']);
  assert.match(await fs.readFile(f.defaults.stderr, 'utf8'), /fake/);
});

test('launchAgent 预先取消不创建子进程', {timeout: 10_000}, async t => {
  const f = await fixture(t); f.controller.abort();
  const result = await launchAgent({...f.defaults, args: scriptArgs('throw new Error("must not run")')});
  assert.equal(f.pids.length, 0); assert.equal(result.exitCode, null); assert.match(result.error ?? '', /启动前已停止/);
});

test('launchAgent 取消运行中的合成子进程并返回停止原因', {timeout: 10_000}, async t => {
  const f = await fixture(t);
  const result = await launchAgent({...f.defaults, args: scriptArgs('setInterval(()=>{},1000)'), onSpawn: pid => {f.pids.push(pid); setImmediate(() => f.controller.abort());}});
  assert.equal(f.pids.length, 1); assert.match(result.error ?? '', /停止/); assert.throws(() => process.kill(f.pids[0], 0));
});

test('launchAgent 日志已存在时失败且不覆盖原文件，不遗留直接子进程', {timeout: 10_000}, async t => {
  const f = await fixture(t); await fs.writeFile(f.defaults.stdout, 'existing evidence');
  const result = await launchAgent({...f.defaults, args: scriptArgs('setInterval(()=>{},1000)')});
  assert.match(result.error ?? '', /无法写入项目日志/); assert.equal(await fs.readFile(f.defaults.stdout, 'utf8'), 'existing evidence');
  for (const pid of f.pids) assert.throws(() => process.kill(pid, 0));
});

test('launchAgent 缺失可执行程序时返回失败，日志流正常结束', {timeout: 10_000}, async t => {
  const f = await fixture(t);
  const result = await launchAgent({...f.defaults, command: path.join(f.dir, 'missing-client.exe'), args: []});
  assert.equal(result.exitCode, null); assert.match(result.error ?? '', /ENOENT/); assert.equal(f.pids.length, 0);
  assert.equal(await fs.readFile(f.defaults.stdout, 'utf8'), '');
});

test('launchAgent 输出处理异常被捕获并停止进程', {timeout: 10_000}, async t => {
  const f = await fixture(t);
  const result = await launchAgent({...f.defaults, args: scriptArgs(`process.stdout.write(${JSON.stringify('event\n')});setInterval(()=>{},1000);`), onLine: () => {throw new Error('synthetic-handler-failure');}});
  assert.match(result.error ?? '', /客户端输出处理失败.*synthetic-handler-failure/);
  for (const pid of f.pids) assert.throws(() => process.kill(pid, 0));
});

test('launchAgent Windows 取消时清理本次启动的合成孙进程', {timeout: 10_000, skip: process.platform !== 'win32'}, async t => {
  const f = await fixture(t);
  const script = `import {spawn} from 'node:child_process';const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{windowsHide:true,stdio:'ignore'});process.stdout.write(JSON.stringify({childPid:child.pid})+'\\n');setInterval(()=>{},1000);`;
  const result = await launchAgent({...f.defaults, args: scriptArgs(script), onLine: value => {const event = JSON.parse(value);f.pids.push(event.childPid);f.controller.abort();}});
  assert.equal(f.pids.length, 2); assert.equal(result.processStopped, true); assert.match(result.error ?? '', /停止/);
  for (const pid of f.pids) assert.throws(() => process.kill(pid, 0));
});

test('launchAgent 启动登记回调抛错时停止真实子进程，不假报已停', {timeout: 10_000}, async t => {
  const f = await fixture(t);
  const result = await launchAgent({...f.defaults, args: scriptArgs('setInterval(()=>{},1000)'), onSpawn: pid => {f.pids.push(pid);throw new Error('synthetic-spawn-registration-failure');}});
  assert.match(result.error ?? '', /synthetic-spawn-registration-failure/); assert.equal(f.pids.length, 1);
  assert.throws(() => process.kill(f.pids[0], 0));
});

test('launchAgent 在启动回调内同步取消不会丢失取消信号', {timeout: 10_000}, async t => {
  const f = await fixture(t);
  const result = await launchAgent({...f.defaults, args: scriptArgs('setInterval(()=>{},1000)'), onSpawn: pid => {f.pids.push(pid);f.controller.abort();}});
  assert.match(result.error ?? '', /停止/); assert.equal(f.pids.length, 1);
  assert.throws(() => process.kill(f.pids[0], 0));
});
