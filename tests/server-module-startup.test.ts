import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';

test('production server modules load in a fresh process without fixture import ordering',()=>{
  const entry=new URL('../src/server/app.ts',import.meta.url).href;
  const result=spawnSync(process.execPath,['--import',import.meta.resolve('tsx'),'--input-type=module','-e',`await import(${JSON.stringify(entry)});console.log('server-module-ready')`],{
    env:process.env,encoding:'utf8',windowsHide:true,timeout:30000,
  });
  assert.equal(result.error,undefined);
  assert.equal(result.status,0,result.stderr);
  assert.match(result.stdout,/server-module-ready/);
});
