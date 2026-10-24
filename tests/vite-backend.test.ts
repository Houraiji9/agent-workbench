import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {execFileSync} from 'node:child_process';
import {ROOT} from '../src/core/config.ts';

test('Vite 的 API 代理跟随隔离后端配置和环境覆盖，不连接日常版端口',()=>{
  const dir=path.join(ROOT,'.test-tmp','vite backend 中文 '+crypto.randomUUID());
  fs.mkdirSync(path.join(dir,'config'),{recursive:true});
  try {
    fs.writeFileSync(path.join(dir,'config/local.json'),JSON.stringify({port:14319}));
    const script=`import config from ${JSON.stringify(pathToFileURL(path.join(ROOT,'vite.config.ts')).href)};console.log(JSON.stringify(config.server?.proxy));`;
    const env:NodeJS.ProcessEnv={...process.env,WORKBENCH_ROOT:dir};delete env.WORKBENCH_PORT;
    const read=(extra:NodeJS.ProcessEnv={})=>JSON.parse(execFileSync(process.execPath,
      ['--import',pathToFileURL(path.join(ROOT,'node_modules/tsx/dist/loader.mjs')).href,'--input-type=module','-e',script],
      {cwd:dir,env:{...env,...extra},windowsHide:true,encoding:'utf8'}));
    assert.equal(read()['/api'],'http://127.0.0.1:14319');
    assert.equal(read({WORKBENCH_PORT:'14327'})['/api'],'http://127.0.0.1:14327');
    assert(!fs.existsSync(path.join(dir,'data')));
  } finally {
    assert.equal(path.dirname(dir),path.join(ROOT,'.test-tmp'));
    assert(!fs.lstatSync(dir).isSymbolicLink());
    fs.rmSync(dir,{recursive:true,force:true});
  }
});
