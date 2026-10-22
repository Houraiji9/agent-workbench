import test from 'node:test';import assert from 'node:assert/strict';
import {snapshotRefresh} from '../src/web/app/snapshot.ts';
function deferred<T>(){let resolve!:(v:T)=>void,reject!:(e:Error)=>void;const promise=new Promise<T>((a,b)=>{resolve=a;reject=b});return {promise,resolve,reject};}
const tick=()=>new Promise<void>(resolve=>setImmediate(resolve));

test('并发通知合并成下一批，不用通知前启动的旧读取答复新调用者',async()=>{
 const a=deferred<string>(),b=deferred<string>(),reads=[a,b],applied:string[]=[];let calls=0,done=false;
 const refresh=snapshotRefresh(()=>{calls++;return reads.shift()!.promise},v=>applied.push(v),()=>{});
 const first=refresh(),second=refresh(),third=refresh();assert.equal(second,third);void second.then(()=>done=true);
 await tick();assert.equal(calls,1);a.resolve('旧读取');await first;await tick();assert.equal(calls,2);assert.equal(done,false);
 b.resolve('通知后的读取');await second;assert.deepEqual(applied,['旧读取','通知后的读取']);
});

test('三代读取：后来的失败不改变已经完成的成功或旧调用者结论',async()=>{
 const a=deferred<string>(),b=deferred<string>(),c=deferred<string>(),reads=[a,b,c],applied:string[]=[];let stale=0;
 const refresh=snapshotRefresh(()=>reads.shift()!.promise,v=>applied.push(v),()=>stale++);
 const first=refresh(),second=refresh();a.resolve('第一批');await first;const third=refresh();
 b.resolve('第二批成功');await second;const last=assert.rejects(third,/第三批失败/);c.reject(Error('第三批失败'));await last;
 await first;await second;assert.deepEqual(applied,['第一批','第二批成功']);assert.equal(stale,1);
});

test('当前读取失败不会吞掉下一批成功，失败发生时如实标记陈旧',async()=>{
 const a=deferred<string>(),b=deferred<string>(),reads=[a,b],applied:string[]=[];let stale=0;
 const refresh=snapshotRefresh(()=>reads.shift()!.promise,v=>applied.push(v),()=>stale++);
 const first=refresh(),second=refresh(),rejected=assert.rejects(first,/读取失败/);a.reject(Error('读取失败'));await rejected;
 b.resolve('随后恢复');await second;assert.deepEqual(applied,['随后恢复']);assert.equal(stale,1);
});

test('密集通知加永久挂起：每个调用最多等当前和下一批，后来的通知不续期',async()=>{
 const applied:string[]=[],signals:AbortSignal[]=[];let failures=0;
 const refresh=snapshotRefresh<string>(s=>{signals.push(s);return new Promise(()=>{})},v=>applied.push(v),()=>failures++,30);
 const first=refresh(),second=refresh(),results=Promise.allSettled([first,second]);
 for(let i=0;i<50;i++)assert.equal(refresh(),second);
 const later:Promise<void>[]=[];const notifications=setInterval(()=>{const next=refresh();void next.catch(()=>{});later.push(next)},3);
 let watchdog:ReturnType<typeof setTimeout>;
 try{await Promise.race([results,new Promise((_,reject)=>{watchdog=setTimeout(()=>reject(Error('持续通知把等待无限延长')),1000)})]);}
 finally{clearInterval(notifications);clearTimeout(watchdog!)}
 await Promise.allSettled(later);assert.ok(failures>=2&&failures<=3);assert.ok(signals.length<=3);assert.ok(signals.every(s=>s.aborted));assert.deepEqual(applied,[]);
});

test('超时后迟到的旧读取不能覆盖恢复数据，主动中止的错误不改变超时语义',async()=>{
 const stalled=deferred<string>(),applied:string[]=[];let count=0,stale=0;
 const refresh=snapshotRefresh(s=>{if(++count===1){s.addEventListener('abort',()=>stalled.reject(Error('AbortError')));return stalled.promise}return Promise.resolve('恢复后的数据')},v=>applied.push(v),()=>stale++,25);
 await assert.rejects(refresh(),/超时/);assert.equal(stale,1);await refresh();assert.deepEqual(applied,['恢复后的数据']);
});

test('忽略 AbortSignal 的慢读取同样有界，迟到响应不会重新应用',async()=>{
 const stalled=deferred<string>(),applied:string[]=[];let count=0;
 const refresh=snapshotRefresh(()=>++count===1?stalled.promise:Promise.resolve('已恢复'),v=>applied.push(v),()=>{},25);
 await assert.rejects(refresh(),/超时/);await refresh();stalled.resolve('迟到值');await tick();assert.deepEqual(applied,['已恢复']);
});
