// One policy for every source directory copied into a portable release.
// Keep public documentation; omit local execution plans and output regardless of extension.
const fs = require('node:fs');
const path = require('node:path');

const RELEASE_ENTRIES = ['src','dist','desktop','migrations','vendor','licenses','docs','scripts',
  'config/example.json','package.json','package-lock.json','README.md','LICENSE','THIRD_PARTY_NOTICES.md',
  'SECURITY.md','AGENTS.md','启动工作台.ps1','停止工作台.ps1','关闭桌面工作台.ps1','桌面版','连接Token Monitor.cmd'];

const LOCAL_DIRECTORIES = new Set([
  '.git', '.agent-workbench', '.agent-workbench-output', '.codex', '.claude', '.cursor', '.gemini',
  '.test-tmp', '.test-temp', '.tmp', '.project-files-tests', '.local-dev', '.cache', '.workbench-review-checks', '.workbench-workgroups',
  'test-results', 'playwright-report', 'logs', 'runtime-data', 'local-data', '待清理'
]);
// These names also occur in application/library source (for example Hono's cache
// middleware). Treat them as user-profile output only in the portable app tree.
const CHROMIUM_DIRECTORIES = new Set(['cache', 'code cache', 'gpucache', 'dawncache',
  'session storage', 'local storage', 'indexeddb', 'crashpad', 'crash reports']);

// Some Windows reparse directories are reported as ordinary directories by
// lstat/Dirent. Resolve only included entries and reject redirected ancestors too.
function isLinkedPath(file, stat) {
  if (stat.isSymbolicLink()) return true;
  const actual = fs.realpathSync.native(file), expected = path.resolve(file);
  return process.platform === 'win32' ? actual.toLowerCase() !== expected.toLowerCase() : actual !== expected;
}

function normalizedRelative(relativePath) {
  if (typeof relativePath !== 'string' || !relativePath || path.isAbsolute(relativePath) || /^[a-z]:/i.test(relativePath)) throw Error('Invalid release-relative path');
  const parts = relativePath.replaceAll('\\', '/').split('/');
  if (parts.some(part => !part || part === '.' || part === '..' || /[\x00-\x1f]/.test(part))) throw Error('Invalid release-relative path');
  return parts.map(part => part.toLowerCase());
}

function isReleaseExcluded(relativePath) {
  const parts = normalizedRelative(relativePath), name = parts.at(-1);
  if (parts.some(part => LOCAL_DIRECTORIES.has(part) || /^\.review-|^cursor-agent-logs-/.test(part))) return true;
  if (parts[0] === '桌面版' && parts.some(part => CHROMIUM_DIRECTORIES.has(part))) return true;
  // npm dependencies are freshly installed with scripts disabled. Their public data assets
  // are code dependencies, whereas a data directory in the source copy is local app state.
  if (parts[0] !== 'node_modules' && parts.includes('data')) return true;
  if (parts[0] === 'docs' && parts[1] === 'plans') return true;
  if (/\.(?:log(?:\..+)?|jsonl|sqlite(?:3)?(?:-wal|-shm|-journal)?|db(?:-wal|-shm|-journal)?|tmp|bak)$/i.test(name)) return true;
  if (name === '.env' || name.startsWith('.env.') && name !== '.env.example') return true;
  if (parts.includes('config') && (name === 'local.json' || /(?:secret|credential).*\.(?:json|ya?ml|toml|ini)$/i.test(name))) return true;
  return false;
}

function copyReleaseEntries(sourceRoot, destinationRoot, entries = RELEASE_ENTRIES) {
  sourceRoot = path.resolve(sourceRoot); destinationRoot = path.resolve(destinationRoot);
  if (sourceRoot === destinationRoot) throw Error('Release destination must differ from source');
  const copied = [], excluded = [];
  function copy(relativePath) {
    normalizedRelative(relativePath);
    if (isReleaseExcluded(relativePath)) { excluded.push(relativePath.replaceAll('\\', '/')); return; }
    const from = path.join(sourceRoot, relativePath), to = path.join(destinationRoot, relativePath);
    const stat = fs.lstatSync(from);
    if (isLinkedPath(from, stat)) throw Error('No links allowed in release source: ' + relativePath);
    if (stat.isDirectory()) {
      fs.mkdirSync(to, {recursive: true});
      for (const name of fs.readdirSync(from)) copy(path.join(relativePath, name));
    } else if (stat.isFile()) {
      fs.mkdirSync(path.dirname(to), {recursive: true});
      fs.copyFileSync(from, to, fs.constants.COPYFILE_EXCL);
      copied.push(relativePath.replaceAll('\\', '/'));
    } else throw Error('Unsupported release source entry: ' + relativePath);
  }
  for (const entry of entries) copy(entry);
  return {copied, excluded};
}

// Registry packages can themselves contain developer-local settings. Preserve these
// outside the release instead of shipping them or deleting the source/install evidence.
function quarantineExcludedReleaseEntries(root, quarantineRoot) {
  root = path.resolve(root); quarantineRoot = path.resolve(quarantineRoot);
  const inside = (file, directory) => { const relative = path.relative(directory, file); return relative === '' || relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative); };
  if (inside(quarantineRoot, root) || inside(root, quarantineRoot)) throw Error('Release quarantine must be separate from staging');
  for (const target of [root, quarantineRoot]) {
    for (let current = target;; current = path.dirname(current)) {
      if (fs.existsSync(current) && isLinkedPath(current, fs.lstatSync(current))) throw Error('No links allowed in release quarantine roots');
      if (path.dirname(current) === current) break;
    }
  }
  const moved = [];
  function walk(directory) {
    for (const entry of fs.readdirSync(directory, {withFileTypes: true})) {
      const from = path.join(directory, entry.name), relativePath = path.relative(root, from);
      if (isLinkedPath(from, entry)) throw Error('Unexpected release link: ' + relativePath);
      if (isReleaseExcluded(relativePath)) {
        const to = path.resolve(quarantineRoot, relativePath);
        if (!inside(from, root) || !inside(to, quarantineRoot)) throw Error('Release quarantine path escaped its root');
        if (fs.existsSync(to)) throw Error('Release quarantine destination already exists');
        fs.mkdirSync(path.dirname(to), {recursive: true});fs.renameSync(from, to);
        moved.push(relativePath.replaceAll('\\', '/'));
      } else if (entry.isDirectory()) walk(from);
    }
  }
  walk(root);return moved;
}

// Run after dependency installation as well, so a later packaging step cannot add
// local execution output unnoticed before manifests are generated.
function assertReleaseTreeClean(root) {
  function walk(directory) {
    for (const entry of fs.readdirSync(directory, {withFileTypes: true})) {
      const file = path.join(directory, entry.name), relativePath = path.relative(root, file);
      if (isLinkedPath(file, entry)) throw Error('Unexpected release link: ' + relativePath);
      if (isReleaseExcluded(relativePath)) throw Error('Release contains local runtime material: ' + relativePath);
      if (entry.isDirectory()) walk(file);
      else if (!entry.isFile()) throw Error('Unsupported release entry: ' + relativePath);
    }
  }
  walk(root);
}

module.exports = {RELEASE_ENTRIES, isReleaseExcluded, copyReleaseEntries, quarantineExcludedReleaseEntries, assertReleaseTreeClean};
