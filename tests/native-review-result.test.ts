import {test} from 'node:test';import assert from 'node:assert/strict';
import {nativeReviewResult,reviewReportFile} from '../src/core/native-review-result.ts';
const report={review_id:'synthetic-review',verdict:'changes_requested',findings:['literal braces {and} and escaped "quotes"'],report_markdown:'# Synthetic\nOnly parser evidence.'};
test('native terminal report accepts exact JSON and one trailing object after narration or fencing',()=>{for(const text of [JSON.stringify(report),'我先核对审查范围。'+JSON.stringify(report),'完成检查。\n```json\n'+JSON.stringify(report)+'\n```'])assert.deepEqual(nativeReviewResult(text),report);});
test('native terminal report refuses ambiguity, truncation and nonterminal suffix without repairing content',()=>{for(const text of [JSON.stringify(report)+'\n'+JSON.stringify({...report,verdict:'passed'}),'example '+JSON.stringify(report)+'\n最终没有结论','开始{broken}\n'+JSON.stringify(report),'准备 '+JSON.stringify(report).slice(0,-1),'prefix ['+JSON.stringify(report)+']'])assert.throws(()=>nativeReviewResult(text));});
test('reviewer can submit the original successful Cursor envelope without cleaning narration',()=>{
 const envelope={type:'result',subtype:'success',is_error:false,session_id:'synthetic-original-session',result:'核对完成。\n'+JSON.stringify(report)};
 for(const text of [JSON.stringify(report),'\uFEFF'+JSON.stringify(envelope),'完成。\n'+JSON.stringify(report)])assert.deepEqual(reviewReportFile(text),report);
 for(const changed of [{is_error:true},{subtype:'error'},{session_id:null},{type:'tool_result'},{result:JSON.stringify(report)+' additional text'}])assert.throws(()=>reviewReportFile(JSON.stringify({...envelope,...changed})));
});
