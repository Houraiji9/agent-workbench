import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
const {webLink,trustedPage,installExternalLinks}=createRequire(import.meta.url)('../desktop/external-links.cjs');

test('desktop external links only accept HTTP(S) without embedded credentials',()=>{
 for(const url of ['https://www.workbuddy.ai/','http://127.0.0.1:8080/sessions/123','https://example.com/中文?q=a#b'])assert(webLink(url));
 for(const url of ['file:///C:/Windows/system32/calc.exe','javascript:alert(1)','data:text/html,test','ms-settings:','\\\\host\\share','https://user:secret@example.com/','not a url',null,{},'https://example.com/'+ 'a'.repeat(8192)])assert.equal(webLink(url),null);
});

test('only the current main workbench page can ask to open a link',()=>{
 const main={url:'http://127.0.0.1:4317/#/team?tab=presets'},wc={mainFrame:main},event={sender:wc,senderFrame:main},base='http://127.0.0.1:4317';
 assert(trustedPage(event,wc,base));
 for(const frame of [null,{url:main.url},{url:'https://example.com/'},{url:base+'/api/artifacts/preview'}])assert.equal(trustedPage({...event,senderFrame:frame},wc,base),false);
 assert.equal(trustedPage({...event,sender:{}},wc,base),false);
 main.url=base+'/api/artifacts/preview';assert.equal(trustedPage(event,wc,base),false);
});

test('desktop hands permitted links to browser, keeps popups blocked and reports launch failure',async()=>{
 let handler:any,popup:any,destroyed=false;const opened:string[]=[],messages:any[]=[];
 const main={url:'http://127.0.0.1:4317/'},wc={mainFrame:main,setWindowOpenHandler:(h:any)=>popup=h},win={webContents:wc,isDestroyed:()=>destroyed};
 const shell={openExternal:async(url:string)=>{opened.push(url)}},dialog={showMessageBox:(_w:any,options:any)=>messages.push(options)};
 installExternalLinks({win,ipcMain:{handle:(_name:any,h:any)=>handler=h},shell,dialog,base:'http://127.0.0.1:4317'});
 const event={sender:wc,senderFrame:main};
 assert.equal(await handler(event,'https://example.com'),true);assert.deepEqual(opened,['https://example.com/']);
 assert.equal(await handler(event,'file:///C:/test.exe'),false);assert.equal(await handler({...event,senderFrame:{url:main.url}},'https://example.com'),false);
 destroyed=true;assert.equal(await handler(event,'https://example.com'),false);destroyed=false;
 assert.deepEqual(popup({url:'https://example.com'}),{action:'deny'});assert.equal(opened.length,1);
 shell.openExternal=async()=>{throw Error('test browser unavailable')};assert.equal(await handler(event,'https://example.com'),false);assert.equal(messages.length,1);
});
