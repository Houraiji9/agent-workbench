import React,{useState} from 'react';
import {api} from '../api.js';
import {useStore} from '../app/store.js';
import {Notice} from './kit.js';
import type {R} from '../lib/flow.js';
import './project-insights.css';
import {reviewProgress,reviewMemberState} from '../../shared/review-progress.js';
import {copyReviewHandoff,dispatchTask} from '../views/actions.js';
const labels:Record<string,string>={awaiting_dispatch:'已安排',running:'正在审查',completed:'已回报',cancelled:'已移除',superseded:'已替代',revoked:'已撤回'};
export function ReviewCollaboration({detail}:{detail:R}){
 const s=useStore(),t=detail.task,summary=detail.review_summary;
 const [arranging,setArranging]=useState(false);
 const [editing,setEditing]=useState(false),[member,setMember]=useState(''),[reviewer,setReviewer]=useState(''),[model,setModel]=useState(''),[reason,setReason]=useState(''),[error,setError]=useState(''),[saving,setSaving]=useState(false);
 if(!t.current_run_id||!summary)return null;
 const run=detail.runs.find((r:R)=>r.id===t.current_run_id),arrangement=run?.review_arrangement;
 const hasDelivery=['submitted','in_review','changes_requested','awaiting_closeout','closing','closeout_waiting_input','closeout_blocked','awaiting_confirmation'].includes(t.status);
 const members:R[]=summary.members||[],closed=['accepted','cancelled','rework_linked'].includes(t.status);
 const progress=reviewProgress(t,summary);
 const agents=s.data.agents.filter((a:R)=>!a.archived&&a.id!==(detail.runs.find((r:R)=>r.id===t.current_run_id)?.agent_id||t.agent_id));
 const models=s.data.model_catalog.find((c:R)=>c.agent_id===reviewer)?.models||[];
 const save=async(action:string,extra:R={})=>{setSaving(true);setError('');try{const result=await s.act(()=>api('/tasks/'+t.id+'/reviews/manage',{run_id:t.current_run_id,expected_revision:t.revision,action,reason:reason.trim(),...(member?{review_id:member}:{}),...(['add','replace','arrange'].includes(action)&&reviewer?{reviewer_id:reviewer}:{}),...(['add','replace','arrange'].includes(action)&&model.trim()?{requested_model:model.trim()}:{}),...extra}),'审查安排已更新，已有报告保留');if(result){setEditing(false);setReason('');setMember('');}else setError('未保存，请查看提示后重试。');}catch(e){setError((e as Error).message)}finally{setSaving(false)}};
 const startArrangement=()=>{setArranging(true);setMember('');setReviewer(arrangement?.reviewer_id||t.reviewer_id||agents[0]?.id||'');setModel(arrangement?.requested_model||run?.execution_contract?.review_route?.model||t.review_route?.model||'');setReason('');setEditing(true)};
 const start=(m?:R)=>{setArranging(false);setMember(m?.id||'');setReviewer(m?.reviewer_id||agents[0]?.id||'');setModel(m?.requested_model||'');setReason('');setEditing(true)};
 return <section className="block" aria-label="独立审查协作"><h2>独立审查 <span className="count">{members.filter(m=>!['cancelled','superseded','revoked'].includes(m.status)).length}</span></h2>
 <button className="btn" disabled={s.busy} onClick={()=>void copyReviewHandoff(s,t)}>复制共同审查交接</button><p className="muted small">{progress.total?progress.count+' · 每位审查者分别回报，可随时增减成员。':'交付后可安排一位或多位审查者。'}</p>
 {!progress.total&&<div className="review-member"><strong>接单后登记实际审查者</strong><p>共同交接不指定接收者或模型；需要同伴时由当前 Agent 安排。</p>{arrangement?.reason&&<p className="muted small">调整原因：{arrangement.reason}</p>}{!closed&&!editing&&<button className="btn small" disabled={saving||s.busy} onClick={startArrangement}>预先安排（可选）</button>}</div>}
 {summary.disagreement&&<Notice tone="warn">审查意见存在分歧，需要负责人写明取舍后再推进。</Notice>}
 <div className="review-member-list">{members.map(m=>{const state=reviewMemberState(m,t),removed=['cancelled','superseded','revoked'].includes(m.status),needsReport=!removed&&state.state!=='reported';return <article key={m.id} className="review-member" aria-label={s.name(m.reviewer_id)+' 审查'}><strong>{s.name(m.reviewer_id)} · {removed?labels[m.status]:state.label}</strong><p>{m.actual_model?'实际回报：'+m.actual_model:'计划模型：'+(m.requested_model||'未指定')}</p>{m.report&&<p>回报：{m.report.revoked_at?'已撤回':m.report.verdict==='passed'?'通过':'需要修改'}{m.report.findings?' · '+m.report.findings:''}</p>}{m.cancellation_reason&&<p className="muted small">移除原因：{m.cancellation_reason}</p>}{needsReport&&state.state==='waiting'&&<p className="muted small">{state.call?.process_may_be_running?'原调用是否结束尚待核对；可手动导入已有报告。':'客户端没有回传正式报告，可继续原会话或手动交接。'}</p>}{needsReport&&state.call?.reason&&<details className="fold"><summary>调用记录</summary><p>{state.call.reason}</p></details>}{!closed&&!removed&&<div className="tool-row">{needsReport&&<>{['waiting','pending'].includes(state.state)&&(m.route||m.reviewer_id===t.reviewer_id&&t.review_route)&&<button className="btn small" disabled={s.busy} onClick={()=>void dispatchTask(s,t,true,false,m.id)}>{state.state==='waiting'?'继续审查':'调用审查者'}</button>}</>}<button className="btn small" disabled={saving||s.busy} onClick={()=>start(m)}>调整此审查者</button></div>}<details className="fold"><summary>审查编号与来源</summary><p>{m.id}</p>{m.report?.report_markdown&&<pre className="pre">{m.report.report_markdown}</pre>}</details></article>})}</div>
 {!members.length&&<p className="muted">{hasDelivery?'尚未发出独立审查单。':'交付后再发出独立审查单；现在可先修改本轮审查者与模型。'}</p>}
 {summary.decision&&<Notice>负责人决定：{({continue:'继续推进',rework:'退回修改',add_review:'追加审查'} as Record<string,string>)[summary.decision.decision]||summary.decision.decision} · {summary.decision.reason}</Notice>}
 {!closed&&!editing&&hasDelivery&&<div className="tool-row"><button className="btn" disabled={s.busy} onClick={()=>start()}>添加审查者</button>{members.some(m=>m.report)&&<button className="btn" onClick={()=>{setArranging(false);setMember('');setReviewer('');setReason('');setEditing(true)}}>记录负责人决定</button>}</div>}
 {editing&&<div className="review-editor"><h3>{arranging?'修改本轮审查安排':member?'调整审查安排':reviewer?'添加审查者':'负责人决定'}</h3>{(reviewer||member)&&<><label>审查者<select aria-label="审查者" value={reviewer} onChange={e=>{setReviewer(e.target.value);setModel('')}}>{agents.map((a:R)=><option key={a.id} value={a.id}>{a.name}</option>)}</select></label><label>审查模型<input aria-label="审查模型" value={model} list={'review-models-'+t.id} onChange={e=>setModel(e.target.value)} placeholder="填写或选择模型"/><datalist id={'review-models-'+t.id}>{models.map((m:any)=><option key={typeof m==='string'?m:m.id} value={typeof m==='string'?m:m.id}/>)}</datalist></label></>}
 <label>调整原因或决定依据<textarea value={reason} onChange={e=>setReason(e.target.value)}/></label>
 {error&&<Notice tone="error">{error}</Notice>}<div className="tool-row">{(reviewer||member)?<><button className="btn primary" disabled={saving||s.busy||reason.trim().length<5||!reviewer} onClick={()=>void save(arranging?'arrange':member?'replace':'add')}>{saving?'正在保存…':'保存安排'}</button>{member&&<button className="btn" disabled={saving||s.busy||!reason.trim()} onClick={()=>void save('remove')}>移除此审查者</button>}</>:['continue','rework','add_review'].map(d=><button key={d} className="btn" disabled={saving||s.busy||!reason.trim()} onClick={()=>void save('decide',{decision:d})}>{({continue:'继续推进',rework:'退回修改',add_review:'追加审查'} as Record<string,string>)[d]}</button>)}<button className="btn ghost" disabled={saving} onClick={()=>setEditing(false)}>取消</button></div></div>}
 </section>;
}
