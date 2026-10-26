// Local self-host upgrade repair: only a recorded job ID, never an author-supplied report.
import {loadConfig} from '../src/core/config.ts';
import {Workbench} from '../src/core/workbench.ts';
import {recoverNativeReview,nativeReviewRecoveryInput} from '../src/core/native-review-recovery.ts';
const [run_id,job_id,...extra]=process.argv.slice(2);
if(extra.length)throw Error('用法：recover-native-review <Run ID> <Job ID>');
const input=nativeReviewRecoveryInput.parse({run_id,job_id}),wb=new Workbench(loadConfig());
try{console.log(JSON.stringify(recoverNativeReview(wb,input),null,2));}finally{wb.close();}
