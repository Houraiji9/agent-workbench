import {test} from 'node:test';
import assert from 'node:assert/strict';
import {fixture,setup,event} from './helpers.ts';
import {Workbench} from '../src/core/workbench.ts';

test('indexed receipt drain preserves gaps, run isolation, restart and idempotency without scanning event history',()=>{
  const f=fixture();let wb=f.wb;
  try{
    const first=setup(wb,f.root),other=setup(wb,f.root);
    const third=event(f.root,first.tid,first.rid,3,'progress');
    const second=event(f.root,first.tid,first.rid,2,'blocked');
    assert.equal(wb.event(third).disposition,'pending');
    assert.equal(wb.event(second).disposition,'pending');
    wb.event(event(f.root,other.tid,other.rid,1));
    wb.drain(first.rid);
    assert.equal(wb.get('runs',first.rid).seq,0,'missing seq 1 must keep later receipts pending');
    wb.close();wb=new Workbench(f.config);
    let draining=0,eventHistoryScans=0;
    const all=wb.all.bind(wb),drain=wb.drain.bind(wb);
    wb.all=table=>{if(draining&&table==='events')eventHistoryScans++;return all(table)};
    wb.drain=rid=>{draining++;try{return drain(rid)}finally{draining--}};
    const started=event(f.root,first.tid,first.rid,1);
    assert.equal(wb.event(started).disposition,'applied');
    assert.equal(wb.get('events',second.event_id).disposition,'applied');
    assert.equal(wb.get('events',third.event_id).disposition,'applied');
    assert.equal(wb.get('runs',first.rid).seq,3);
    assert.equal(wb.get('runs',first.rid).status,'running');
    assert.equal(wb.get('runs',other.rid).seq,1,'another run with matching seq must remain independent');
    assert.equal(wb.event(started).disposition,'applied');
    wb.drain(first.rid);wb.drain(other.rid);
    assert.equal(wb.get('runs',first.rid).seq,3,'duplicate receipt must not rewind or repeat advancement');
    assert.equal(eventHistoryScans,0,'drain must select the next indexed row rather than decode all events');
    const plan=wb.db.prepare('EXPLAIN QUERY PLAN SELECT data FROM events WHERE run_id=? AND seq=?').all(first.rid,4);
    assert(plan.some(row=>String(row.detail).includes('SEARCH')&&String(row.detail).includes('run_id=')&&String(row.detail).includes('seq=')));
  }finally{wb.close()}
});
