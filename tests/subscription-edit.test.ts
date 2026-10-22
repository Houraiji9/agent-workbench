import {test} from 'node:test';
import assert from 'node:assert/strict';
import {fixture} from './helpers.ts';
import {Workbench} from '../src/core/workbench.ts';

test('订阅编辑：金额/周期/零积分/续费意愿持久化；不变更购买、共享池与实际权益',()=>{
  const {wb,config}=fixture();
  const before=wb.all('quota_pools');
  const s=wb.updateBaseline('subscriptions','test-plan-price',{amount:120,currency:'CNY',interval:'year',auto_renew:false,estimated_points:0},1);
  assert.equal(s.status,'planned');assert.equal(s.confirmed_at,null);assert.equal(s.version,2);
  assert.deepEqual(wb.all('quota_pools'),before);
  const audit=wb.db.prepare("SELECT data FROM audit WHERE action='edit_baseline' AND entity_id=? ORDER BY id DESC LIMIT 1").get(s.id) as any;
  const changes=JSON.parse(audit.data);assert.equal(changes.before.amount,12.5);assert.equal(changes.after.amount,120);
  wb.close();const reopened=new Workbench(config);
  try{const saved=reopened.get('subscriptions',s.id);assert.equal(saved.amount,120);assert.equal(saved.interval,'year');assert.equal(saved.auto_renew,false);assert.equal(saved.estimated_points,0);assert.equal(reopened.get('subscriptions','test-plan-shared').planned_date,'2035-04-15');}finally{reopened.close();}
});

test('订阅编辑：版本冲突、外部事实、身份与状态注入、无效金额日期均不能覆盖原记录',()=>{
  const {wb}=fixture();try{
    const original=wb.get('subscriptions','test-plan-price');
    for(const patch of [{amount:-1},{amount:Infinity},{currency:'usd'},{interval:'week'},{auto_renew:'false'},{estimated_points:1.5},{planned_date:'2026-02-30'},{status:'user_confirmed_active'},{confirmed_at:new Date().toISOString()},{account_id:'x'},{id:'other'}]){
      assert.throws(()=>wb.updateBaseline('subscriptions',original.id,patch,1));assert.deepEqual(wb.get('subscriptions',original.id),original);
    }
    assert.throws(()=>wb.updateBaseline('subscriptions','test-active-kimi',{amount:12},1),/币种/);
    wb.put('subscriptions',{...original,id:'external',source:'token_monitor'},{account_id:original.account_id});
    assert.throws(()=>wb.updateBaseline('subscriptions','external',{amount:12},1),/外部事实/);
    wb.updateBaseline('subscriptions',original.id,{note:'其他窗口先保存'},1);
    assert.throws(()=>wb.updateBaseline('subscriptions',original.id,{note:'过期窗口覆盖'},1),/版本冲突/);
    assert.equal(wb.get('subscriptions',original.id).note,'其他窗口先保存');
    const s=wb.updateBaseline('subscriptions',original.id,{amount:null,currency:null,interval:null,auto_renew:null,estimated_points:null},2);
    assert.equal(s.amount,null);assert.equal(s.status,'planned');
  }finally{wb.close();}
});
