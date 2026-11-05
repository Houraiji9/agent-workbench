import path from 'node:path';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import {installHarnessImageTools, rollbackHarnessImageTools} from '../src/core/harness-image-tools.ts';

const usage = '用法：install-harness-image-tools.ts --profile <已授权desktop profile绝对路径> --runtime <已安装工作台绝对路径> --credential-file <受限凭据文件> [--node <受管node.exe>] [--dry-run]\n回滚：install-harness-image-tools.ts --profile <同一profile> --rollback <安装回执绝对路径>\n此入口只增量绑定工具，不改provider、不启动模型、不升级或强制重启Harness。';
export function runHarnessImageInstaller(argv: string[]) {
  if (argv.includes('--help')) return {usage};
  const options: Record<string, string | boolean> = {};
  const values = new Set(['--profile', '--runtime', '--credential-file', '--node', '--rollback']);
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === '--dry-run') { options[flag] = true; continue; }
    if (!values.has(flag) || options[flag] !== undefined || !argv[i + 1] || argv[i + 1].startsWith('--')) throw Error(usage);
    options[flag] = argv[++i];
  }
  if (typeof options['--profile'] !== 'string') throw Error(usage);
  if (typeof options['--rollback'] === 'string') {
    if (options['--dry-run'] || options['--runtime'] || options['--credential-file'] || options['--node']) throw Error('回滚不能与安装参数混用');
    return rollbackHarnessImageTools(options['--profile'], options['--rollback']);
  }
  if (typeof options['--runtime'] !== 'string' || typeof options['--credential-file'] !== 'string' || !path.isAbsolute(options['--runtime'])) throw Error(usage);
  const runtime = options['--runtime'], require = createRequire(path.join(runtime, 'package.json'));
  return installHarnessImageTools({profilePath: options['--profile'], cwd: runtime, credentialFile: options['--credential-file'], nodePath: typeof options['--node'] === 'string' ? options['--node'] : path.join(runtime, '桌面版', '工作台', 'resources', 'runtime', 'node.exe'), scriptPath: path.join(runtime, 'scripts', 'external-image-mcp.ts'), loaderPath: require.resolve('tsx'), dryRun: !!options['--dry-run']});
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { console.log(JSON.stringify(runHarnessImageInstaller(process.argv.slice(2)), null, 2)); }
  catch (error) { console.error(error instanceof Error ? error.message : 'Harness 工具安装失败；未输出配置内容'); process.exitCode = 1; }
}
