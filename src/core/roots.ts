// 授权文件夹：由页面用户显式添加，写入项目 config/local.json。只扩大登记范围，不授予读取受保护目录的权限。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { type Config } from './config.ts';
import { assert, atomicWrite, inside, protectedName } from './security.ts';

const systemNames = /^(windows|program files|program files \(x86\)|programdata|\$recycle\.bin|system volume information|appdata|recovery|boot|perflogs)$/i;

function authorize<T>(config: Config, input: unknown, create: boolean, commit: (real: string) => T) {
  assert(typeof input === 'string' && input.trim().length > 0 && input.length < 1000, '请输入文件夹的完整路径');
  const raw = input.trim().replace(/^"(.*)"$/, '$1');
  assert(path.isAbsolute(raw) && !raw.startsWith('\\\\') && !raw.startsWith('//'), '需要本机文件夹的完整路径，例如 E:\\项目\\记账APP');
  assert(!/[\x00-\x1f]/.test(raw) && !raw.slice(2).includes(':'), '路径里有不能使用的字符');
  const target = path.resolve(raw), parent = path.dirname(target);
  if (create) {
    assert(!fs.existsSync(target), '新项目目录已存在，请选择登记已有文件夹');
    assert(fs.existsSync(parent) && fs.statSync(parent).isDirectory(), '上一级文件夹不存在，请先创建上一级文件夹');
  } else assert(fs.existsSync(target), '找不到这个文件夹，请确认路径是否正确');
  const real = create ? path.join(fs.realpathSync.native(parent), path.basename(target)) : fs.realpathSync.native(target);
  // Windows 会折叠尾随点/空格；拒绝这种歧义，避免 .ssh. 等名称绕过创建前检查。
  if (create && process.platform === 'win32') assert(!/[. ]$/.test(path.basename(real)), '文件夹名称不能以点或空格结尾');
  if (!create) assert(fs.statSync(real).isDirectory(), '这里需要一个文件夹，不是文件');
  assert(path.parse(real).root !== real && path.dirname(real) !== real, '不能授权整个磁盘，请选择具体的项目文件夹');
  assert(!protectedName(real), '这个位置包含凭据或内部存储，不能授权');
  const parts = path.relative(path.parse(real).root, real).split(path.sep).filter(Boolean);
  assert(!parts.some(p => systemNames.test(p)), '不能授权系统或程序目录');
  const home = fs.realpathSync.native(os.homedir());
  assert(!inside(real, home), '不能授权整个用户主目录或包含它的上级目录，请选择具体的项目文件夹');
  if (process.platform === 'win32') assert(parts.length >= 1, '不能授权整个磁盘');
  const data = fs.existsSync(config.dataDir) ? fs.realpathSync.native(config.dataDir) : path.resolve(config.dataDir);
  assert(!inside(data, real), '工作台自己的数据目录不能作为项目文件夹');
  const covering = config.authorizedRoots.find(r => fs.existsSync(r) && inside(fs.realpathSync.native(r), real));
  const file = path.join(config.root, 'config', 'local.json');
  const previous = fs.existsSync(file) ? fs.readFileSync(file) : null;
  const current = previous ? JSON.parse(previous.toString('utf8')) : {};
  const roots: string[] = Array.isArray(current.authorizedRoots) ? current.authorizedRoots : [...config.authorizedRoots];
  const next = { ...current, authorizedRoots: [...new Set([...roots, real])] };
  const rootsBefore = [...config.authorizedRoots];
  let created: fs.Stats | undefined, wrote = false;
  try {
    // 所有位置校验先于创建。只新建准确目录；不暗中创建或授权父目录。
    if (create) { fs.mkdirSync(real); created = fs.lstatSync(real); }
    if (!covering) {
      atomicWrite(file, JSON.stringify(next, null, 2) + '\n');
      wrote = true; config.authorizedRoots.push(real);
    }
    const value = commit(real);
    return { roots: [...config.authorizedRoots], added: covering ? null : real, covered_by: covering || null, value };
  } catch (error) {
    config.authorizedRoots.splice(0, config.authorizedRoots.length, ...rootsBefore);
    if (wrote) { if (previous) atomicWrite(file, previous); else fs.unlinkSync(file); }
    if (created) {
      // 只删除本次创建、身份未变且仍为空的目录，不递归触碰用户文件。
      try { const cur = fs.lstatSync(real); if (cur.ino === created.ino && cur.dev === created.dev && !cur.isSymbolicLink()) fs.rmdirSync(real); } catch { /* 已有内容时保留 */ }
    }
    throw error;
  }
}

export function addAuthorizedRoot(config: Config, input: unknown) {
  const { value: _value, ...result } = authorize(config, input, false, () => undefined);
  return result;
}

export function authorizeProject<T>(config: Config, input: { path?: unknown; create?: unknown }, register: (real: string) => T) {
  assert(input.create === undefined || typeof input.create === 'boolean', '新建文件夹选项无效');
  return authorize(config, input.path, input.create === true, register);
}
