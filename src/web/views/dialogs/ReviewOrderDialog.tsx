import React,{useEffect,useState} from 'react';
import {Copy} from 'lucide-react';
import {api} from '../../api.js';
import {useStore} from '../../app/store.js';
import {Dialog,Field,Notice} from '../../ui/kit.js';
import type {R} from '../../lib/flow.js';
import {useSubmit,parseJson} from './useSubmit.js';

export function ReviewOrderDialog({detail,onClose}:{detail:R;onClose():void}){
  const s=useStore(),[task]=useState(detail.task),[candidates,setCandidates]=useState<R|null>(null),[reviewer,setReviewer]=useState(''),[reason,setReason]=useState(''),[saved,setSaved]=useState<R|null>(null);
  const {error,setError,saving,run}=useSubmit();
  useEffect(()=>{let active=true;api('/tasks/'+task.id+'/review-candidates').then(c=>{if(active){setCandidates(c);setReviewer(c.candidates.some((a:R)=>a.agent_id===task.reviewer_id&&a.assignable)?task.reviewer_id:'')}}).catch(e=>active&&setError(e.message));return()=>{active=false}},[task.id]);
  if(saved)return <Dialog label="审查单已准备好" title="审查单已准备好" sub={`交给 ${s.name(saved.reviewer_id)}`} onClose={onClose} footer={<button className="btn ghost" onClick={onClose}>关闭</button>}>
    <p>发给审查者后，它会按单接单并提交报告。</p><button className="btn primary" onClick={()=>void s.copy(saved.entry,'审查单已复制')}><Copy size={16}/>复制审查单</button><details className="fold"><summary>查看复制内容</summary><textarea className="mono" readOnly rows={7} value={saved.entry}/></details>
  </Dialog>;
  return <Dialog label="安排独立审查" title="安排独立审查" sub={task.title} onClose={onClose}><form className="form" onSubmit={e=>{e.preventDefault();void run(async()=>{
    const r=await api('/review-orders',{run_id:task.current_run_id,reviewer_id:reviewer,expected_revision:candidates?.revision,reason:reason.trim()||'用户在工作台选择独立审查者',delivery_mode:'manual',new_review:['in_review','changes_requested','awaiting_closeout','closing','closeout_waiting_input','closeout_blocked','awaiting_confirmation'].includes(task.status)});setSaved(r);await s.copy(r.entry,`审查单已复制，发给 ${s.name(reviewer)}`);return r;
  },undefined,false)}}>
    <Field label="审查者"><select required value={reviewer} onChange={e=>setReviewer(e.target.value)}><option value="">请选择审查者</option>{candidates?.candidates.map((a:R)=><option key={a.agent_id} value={a.agent_id} disabled={!a.assignable}>{a.name} · {a.reason}</option>)}</select></Field>
    <Field label="安排说明（可选）"><input value={reason} onChange={e=>setReason(e.target.value)} maxLength={2000} placeholder="例如：Grok 额度不足，这次交给 Claude"/></Field>
    {candidates&&!candidates.candidates.some((a:R)=>a.assignable)&&<Notice>当前没有可用的独立审查者，请更新团队或额度后再安排。</Notice>}
    {error&&<Notice tone="error">{error}</Notice>}
    <footer className="dialog-foot inline"><button type="button" className="btn ghost" onClick={onClose}>取消</button><button className="btn primary" disabled={saving||!reviewer}>生成并复制审查单</button></footer>
  </form></Dialog>;
}

export function ReviewReceiptDialog({detail,onClose}:{detail:R;onClose():void}){
  const [text,setText]=useState('');const {error,saving,run}=useSubmit();
  return <Dialog label="导入审查回执" title="导入审查回执" sub={detail.task.title} onClose={onClose}><form className="form" onSubmit={e=>{e.preventDefault();void run(async()=>{
    const value=parseJson(text) as R;if(value.task_id!==detail.task.id||value.run_id!==detail.task.current_run_id)throw Error('这份回执属于其他任务，请核对后再导入');return api('/review-receipts',value);
  },'报告已附上，审查状态已更新')}}>
    <Field label="粘贴审查者返回的完整回执"><textarea className="mono" required rows={12} value={text} onChange={e=>setText(e.target.value)}/></Field>
    {error&&<Notice tone="error">{error}</Notice>}<footer className="dialog-foot inline"><button type="button" className="btn ghost" onClick={onClose}>取消</button><button className="btn primary" disabled={saving||!text.trim()}>导入并附上报告</button></footer>
  </form></Dialog>;
}
