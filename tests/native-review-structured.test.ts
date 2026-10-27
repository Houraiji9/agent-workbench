import test from 'node:test';
import assert from 'node:assert/strict';
import {nativeReviewResult,reviewReportFile} from '../src/core/native-review-result.ts';
import {reviewResultInput} from '../src/core/review-workflow.ts';
test('原生结构化审查意见可登记，保留所有字段及真实结论',()=>{
 const finding={severity:'low',title:'可读性建议',paths:['src/example.ts'],detail:'不影响使用',extra:{line:12}};
 for(const verdict of ['passed','changes_requested']){
  const raw={verdict,findings:[finding,'另一条文字意见'],limitations:['未运行测试'],evidence:['只读源码'],report_markdown:'完整独立报告：结论、意见和未验证项目保持审查者原文。'};
  for(const input of [JSON.stringify(raw),'检查完成。\n```json\n'+JSON.stringify(raw)+'\n```']){
   const result=nativeReviewResult(input) as any;assert.equal(result.verdict,verdict);assert.deepEqual(JSON.parse(result.findings[0]),finding);assert.equal(result.findings[1],raw.findings[1]);assert.equal(result.report_markdown,raw.report_markdown);
   assert.doesNotThrow(()=>reviewResultInput.parse({...result,task_id:'T-00000000-0000-0000-0000-000000000001',run_id:'R-00000000-0000-0000-0000-000000000002',review_id:'RA-00000000-0000-0000-0000-000000000003',review_digest:'a'.repeat(64)}));
   assert.deepEqual(reviewReportFile(input),result);
  }
 }
});
test('结构兼容不从过程工具输出猜测结论，也不拼接多个报告',()=>{
 assert.throws(()=>nativeReviewResult('{"verdict":"passed"}\n{"verdict":"changes_requested"}'));
 const value=nativeReviewResult('{"findings":[false,null,["nested"]]}') as any;assert.deepEqual(value.findings,[false,null,['nested']]);
});
