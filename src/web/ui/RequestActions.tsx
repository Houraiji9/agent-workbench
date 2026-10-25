import React from 'react';
import {PencilLine} from 'lucide-react';
import {useStore} from '../app/store.js';
import type {R} from '../lib/flow.js';
import {deliverySummary} from './DeliveryProfileFields.js';
import {deliveryForView} from '../../shared/delivery-view.js';

/** 需求在今天、需求箱、项目页使用同一名称。 */
export const requestStatusText:Record<string,string>={draft:'待开始',awaiting_planning:'待规划',planned:'已生成计划'};

/** 一行需求属性：重要程度与交付目标。 */
export function requestMeta(q:R,project:R){
  return `重要程度：${(q.importance||project.importance)==='critical'?'重点':'普通'} · ${deliverySummary(deliveryForView(q,project))}`;
}

/** 编辑、暂时不做、删除：低调的次要操作，主操作由各页面按场景给出。 */
export function RequestMoreActions({q,editable=true}:{q:R;editable?:boolean}){
  const s=useStore(),recall=q.status==='awaiting_planning';
  if(!editable&&!recall)return null;
  return <div className="turn-more" role="group" aria-label="其他操作">
    {editable&&<button onClick={()=>s.openDialog('request',{request:q})}><PencilLine size={13}/>{q.status==='draft'?'继续编辑':'编辑需求'}</button>}
    {recall&&<button title="移回待开始，需求内容保留" onClick={()=>s.openDialog('request-action',{request:q,action:'recall'})}>暂时不做</button>}
    {editable&&<button className="danger" onClick={()=>s.openDialog('request-action',{request:q,action:'delete'})}>删除</button>}
  </div>;
}
