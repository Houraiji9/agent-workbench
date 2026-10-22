import React, {useState} from 'react';
import type {R} from '../../lib/flow.js';
import {Dialog,Field,Notice} from '../../ui/kit.js';
import {api} from '../../api.js';
import {useSubmit} from './useSubmit.js';
import {antigravityGroup,defaultAntigravityWindows} from '../../../shared/quota-groups.js';

function localTime(value:string|null){if(!value)return '';const d=new Date(value);if(!Number.isFinite(d.getTime()))return '';return new Date(d.getTime()-d.getTimezoneOffset()*60000).toISOString().slice(0,16)}
export function WorkBuddyPointsDialog({pool,onClose}:{pool:R;onClose():void}){
  const [p]=useState(pool),[points,setPoints]=useState<string>(pool.points_amount==null?'':String(pool.points_amount));
  const [monthly,setMonthly]=useState(!!pool.points_monthly),[allowance,setAllowance]=useState(String(pool.points_monthly?.allowance??'')),[remaining,setRemaining]=useState(String(pool.points_monthly?.remaining??'')),[resets,setResets]=useState(localTime(pool.points_resets_at));
  const {error,saving,run}=useSubmit();
  const save=(total:number|null)=>run(()=>api('/manual-points/workbuddy',{version:p.points_version,remaining:total,monthly:total===null||!monthly?null:{allowance:Number(allowance),remaining:remaining===''?null:Number(remaining)},resets_at:total===null||!monthly||!resets?null:new Date(resets).toISOString()}),total===null?'积分记录已清空':'积分已保存');
  return <Dialog title="WorkBuddy 积分" onClose={onClose}>
    <form className="form" onSubmit={e=>{e.preventDefault();if(points.trim()!=='')void save(Number(points))}}>
      <Field label="总剩余积分"><input data-autofocus required type="number" min="0" max="1000000000" step="0.001" placeholder="包含月度基础积分" value={points} onChange={e=>setPoints(e.target.value)} /></Field>
      <label className="check"><input type="checkbox" checked={monthly} onChange={e=>setMonthly(e.target.checked)}/>包含每月刷新的基础积分</label>
      {monthly&&<><div className="grid-2"><Field label="每月基础积分"><input required type="number" min="0.001" max="1000000000" step="0.001" value={allowance} onChange={e=>setAllowance(e.target.value)}/></Field><Field label="本月剩余积分"><input type="number" min="0" max={allowance||1000000000} step="0.001" placeholder="暂不清楚可留空" value={remaining} onChange={e=>setRemaining(e.target.value)}/></Field></div><Field label="下次月度刷新（选填）"><input type="datetime-local" value={resets} onChange={e=>setResets(e.target.value)}/></Field></>}
      {error&&<Notice tone="error">{error}</Notice>}
      <footer className="dialog-foot inline">{p.points_amount!==null&&<button type="button" className="btn ghost" disabled={saving} onClick={()=>void save(null)}>清空记录</button>}<button type="button" className="btn ghost" onClick={onClose}>取消</button><button type="submit" className="btn primary" disabled={saving}>{saving?'正在保存…':'保存'}</button></footer>
    </form>
  </Dialog>;
}
export function QuotaDialog({pool,windows,onClose}:{pool:R;windows:R[];onClose():void}){
  const [p]=useState(pool);
  const [items,setItems]=useState(()=> {
    const source = windows.length ? [...windows] : p.provider==='claude' ? [{kind:'session',label:'5 小时'},{kind:'weekly',label:'每周'}] : [...defaultAntigravityWindows];
    if(p.quota_group&&!source.some(w=>antigravityGroup(w)===p.quota_group))source.push(...defaultAntigravityWindows.filter(w=>antigravityGroup(w)===p.quota_group));
    return source.map((w:R)=>({kind:w.kind,label:w.label||w.kind,remaining:w.remaining_percent??'',resets:localTime(w.resets_at),original:w,edited:false}));
  });
  const {error,saving,run}=useSubmit();
  const set=(i:number,key:string,value:string)=>setItems(items.map((w,j)=>j===i?{...w,[key]:value,edited:true}:w));
  return <Dialog title={`编辑 ${p.name} 额度`} sub="保存后持续显示；Token Monitor 取得新数据时自动更新。" onClose={onClose}>
    <form className="form subscription-form" onSubmit={e=>{e.preventDefault();void run(()=>api('/quota-cache/'+p.provider,{version:p.cache_version,...(p.quota_group?{group:p.quota_group}:{}),windows:items.filter(w=>!p.quota_group||antigravityGroup(w)===p.quota_group).map(w=>({label:w.label,kind:w.kind,remaining_percent:w.remaining===''?null:Number(w.remaining),resets_at:w.edited?(w.resets?new Date(w.resets).toISOString():null):w.original.resets_at||null}))}),'额度已保存')}}>
      {items.map((w,i)=>(!p.quota_group||antigravityGroup(w)===p.quota_group)&&<fieldset className="quota-edit-window" key={i}><legend>{w.label}</legend>
        <div className="grid-2"><Field label="剩余（%）"><input type="number" min="0" max="100" step="0.001" placeholder="0—100" value={w.remaining} onChange={e=>set(i,'remaining',e.target.value)} /></Field>
        <Field label="重置时间（可选）"><input type="datetime-local" value={w.resets} onChange={e=>set(i,'resets',e.target.value)} /></Field></div>
      </fieldset>)}
      {error&&<Notice tone="error">{error}</Notice>}
      <footer className="dialog-foot inline"><button type="button" className="btn ghost" onClick={onClose}>取消</button><button type="submit" className="btn primary" disabled={saving}>{saving?'正在保存…':'保存'}</button></footer>
    </form>
  </Dialog>;
}
