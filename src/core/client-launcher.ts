import {createHash} from 'node:crypto';
// Exact normalized templates. Comments/blank lines and CRLF may differ; executable code may not.
// The native template is the installed Cursor 2026.10.22-27dcf5f Windows launcher.
const CURSOR_PS1_TEMPLATES = new Set([
  'aaec1a0192ce3661dc65b5d5ee38155f1692d0c94ccc481257e0e6d15f46fe96',
  '3a1f947d3795d580eb919ab0d372ac0620151287c5673f29554c18ff63767aea',
]);
const CURSOR_VERSION_RULE=String.raw`^\d{4}\.\d{1,2}\.\d{1,2}(-\d{2}-\d{2}-\d{2})?-[a-f0-9]+$`;
export function assertCursorPowerShellWrapper(script:string){
  const normalized=script.replace(/^\uFEFF/,'').replace(/\r/g,'').split('\n').map(line=>line.trim()).filter(line=>line&&!line.startsWith('#')).join('\n');
  const rule=script.match(/^\s*\$name\s+-match\s+'([^']+)'\s*$/m)?.[1];
  const hash=createHash('sha256').update(normalized).digest('hex');
  if(rule!==CURSOR_VERSION_RULE||!CURSOR_PS1_TEMPLATES.has(hash))throw Error('Cursor CLI PowerShell 包装器格式不受支持');
}
