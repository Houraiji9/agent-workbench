import type {Row} from './schema.ts';
import {runTask} from './workflow-policy.ts';

/** A limited review is a real independent review of an explicitly selected subset. */
export function reviewScope(task:Row,run:Row){
  const frozen=runTask(task,run),policy=frozen.review_policy||{mode:'required'};
  if(policy.mode==='light')return {mode:'light',label:'有限审查',focus:policy.focus||[],
    acceptance:policy.focus?.length?policy.focus:['核对用户指定的有限审查范围'],tests:['围绕上述范围选择必要检查，明确报告实际检查及未验证项。'],
    limitation:'本轮只审查用户指定范围，不代表其他功能或全部验收标准通过。'};
  return {mode:'required',label:'完整独立审查',focus:'',acceptance:frozen.acceptance||[],tests:frozen.tests||[],limitation:''};
}
