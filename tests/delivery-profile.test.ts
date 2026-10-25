import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {assertDeliverySelection,assertDeploymentReceipt,bindDeploymentReceipt,deliveryProfileDigest,deliveryProfileSchema,
  deploymentReceiptInput,executorVerificationNote,resolveDeliveryProfile,validatePlannedDelivery,type DeploymentReceiptContext} from '../src/core/delivery-profile.ts';

const A='a'.repeat(64),B='b'.repeat(64);
// 仅用于档案值比较，不创建或访问真实安装目录。
const testRoot=fileURLToPath(new URL('../.test-tmp/delivery-profile/',import.meta.url));
const projectRuntime=path.join(testRoot,'project-runtime'),frozenRuntime=path.join(testRoot,'frozen-runtime');
function remote(){return {schema:1,artifacts:['source','service'],artifact_description:'',deployment:{mode:'remote',target:'生产服务器上的机器人服务',deploy:'更新已审版本后重启服务',health:'查看服务状态并执行已授权的健康检查',rollback:'恢复保留的上一版本',verification:'executor_reported'}}}
function context():DeploymentReceiptContext{return {run_id:'R-current',current_run_id:'R-current',agent_id:'executor',profile:remote(),version:'0.4.2',artifact_hashes:[B,A],review_id:'RA-current',review_skipped:false}}
function receipt(){return {run_id:'R-current',profile_sha256:deliveryProfileDigest(remote()),version:'0.4.2',artifact_hashes:[A,B],review_id:'RA-current',reported_by:'executor',reported_at:'2026-10-25T10:00:00+00:00',deployment_evidence:'执行者记录：已部署 0.4.2',health_evidence:'执行者记录：健康检查通过',rollback_evidence:'执行者记录：上一版本备份已保留',verification:'executor_reported'}}

test('unplanned form settings allow blank methods; a remote planned task needs no local directory',()=>{
  const p=remote();p.deployment.deploy='';p.deployment.health='';p.deployment.rollback='';
  assert.doesNotThrow(()=>deliveryProfileSchema.parse(p));assert.throws(()=>validatePlannedDelivery(p),/补齐/);
  assert.equal(validatePlannedDelivery(remote()).deployment.mode,'remote');
  for(const field of ['target','deploy','health','rollback'] as const){const incomplete=remote();incomplete.deployment[field]='  ';assert.throws(()=>validatePlannedDelivery(incomplete),/补齐/)}
});

test('legacy task selection stays ahead of changed project defaults',()=>{
  const project={delivery_profile:remote(),runtime_root:projectRuntime};
  assert.deepEqual(resolveDeliveryProfile({delivery_target:'source'},project).artifacts,['source']);
  assert.equal(resolveDeliveryProfile({delivery_target:'source'},project).deployment.mode,'none');
  const runtime=resolveDeliveryProfile({delivery_target:'runtime',runtime_root:frozenRuntime},project);
  assert.deepEqual(runtime.artifacts,['source','software']);assert.equal(runtime.deployment.target,frozenRuntime);
  assert.equal(runtime.deployment.verification,'portable_manifest');
  assert.equal(resolveDeliveryProfile({},project).deployment.mode,'remote');
  assert.equal(resolveDeliveryProfile({delivery_profile:remote(),delivery_target:'runtime'},project).deployment.mode,'remote');
  assert.throws(()=>validatePlannedDelivery(resolveDeliveryProfile({delivery_target:'runtime'})),/target/);
});

test('profile strictness rejects duplicate artifacts, extra fields and incompatible verification',()=>{
  assert.throws(()=>deliveryProfileSchema.parse({...remote(),artifacts:[]}));
  assert.throws(()=>deliveryProfileSchema.parse({...remote(),artifacts:['source','source']}));
  assert.throws(()=>deliveryProfileSchema.parse({...remote(),runtime_root:'not-needed'}));
  const p=remote();p.deployment.verification='portable_manifest';assert.throws(()=>deliveryProfileSchema.parse(p));
  p.deployment.verification='none';assert.throws(()=>deliveryProfileSchema.parse(p));
});

test('planning fills blanks without changing chosen target or supplied methods',()=>{
  const selected=remote();selected.deployment.deploy='';selected.deployment.health='';selected.deployment.rollback='';
  assert.doesNotThrow(()=>assertDeliverySelection(selected,remote()));
  const changed=remote();changed.deployment.target='另一台服务器';assert.throws(()=>assertDeliverySelection(selected,changed),/静默/);
  changed.deployment.target=selected.deployment.target;changed.artifacts=['source'];assert.throws(()=>assertDeliverySelection(selected,changed),/静默/);
  const method=remote();method.deployment.deploy='另一种部署方法';assert.throws(()=>assertDeliverySelection(remote(),method),/静默/);
});

test('planning may fill blank target and artifact description but preserves supplied requirements',()=>{
  const selected=remote();selected.deployment.target='';
  const planned=remote();planned.artifact_description='源码和线上机器人服务';
  assert.doesNotThrow(()=>assertDeliverySelection(selected,planned));
  const fixed=remote();fixed.artifact_description='须交付源码和线上机器人服务';
  assert.throws(()=>assertDeliverySelection(fixed,planned),/成果说明/);
  assert.doesNotThrow(()=>assertDeliverySelection(fixed,{...planned,artifact_description:fixed.artifact_description}));
  const moved=remote();moved.deployment.target='未经选择的服务器';
  assert.throws(()=>assertDeliverySelection(remote(),moved),/静默/);
});

test('digest is canonical and binds all frozen profile details',()=>{
  const reordered=remote();reordered.artifacts.reverse();assert.equal(deliveryProfileDigest(reordered),deliveryProfileDigest(remote()));
  for(const field of ['target','deploy','health','rollback'] as const){const changed=remote();changed.deployment[field]+='变化';assert.notEqual(deliveryProfileDigest(changed),deliveryProfileDigest(remote()))}
  const described=remote();described.artifact_description='新增成果要求';assert.notEqual(deliveryProfileDigest(described),deliveryProfileDigest(remote()));
});

test('receipt binds all reviewed artifacts and states that deployment is executor reported',()=>{
  const bound=bindDeploymentReceipt(context(),receipt());
  assert.equal(bound.verification,'executor_reported');assert.equal(bound.verification_note,executorVerificationNote);
  assert.deepEqual(bound.artifact_hashes,[A,B]);assert.deepEqual(assertDeploymentReceipt(context(),bound),bound);
  assert.throws(()=>deploymentReceiptInput.parse({...receipt(),verified:true}));
  assert.throws(()=>assertDeploymentReceipt(context(),{...bound,verification_note:'服务端已验证部署'}));
});

test('rejects replay, actor/version/review mismatch and incomplete or duplicate artifact sets',()=>{
  const changes=[{run_id:'R-old'},{reported_by:'someone-else'},{version:'0.4.1'},{review_id:'RA-old'},{profile_sha256:B},{artifact_hashes:[A]},{artifact_hashes:[A,A]},{artifact_hashes:[A,B,'c'.repeat(64)]}];
  for(const change of changes)assert.throws(()=>bindDeploymentReceipt(context(),{...receipt(),...change}));
  assert.throws(()=>bindDeploymentReceipt({...context(),current_run_id:'R-new'},receipt()),/当前 Run/);
  const changed=remote();changed.deployment.target='另一台服务器';assert.throws(()=>assertDeploymentReceipt({...context(),profile:changed},bindDeploymentReceipt(context(),receipt())),/已改变/);
  assert.throws(()=>bindDeploymentReceipt({...context(),artifact_hashes:[A,A]},receipt()),/不能重复/);
});

test('null review requires explicit review skip and still binds current full artifacts',()=>{
  const input={...receipt(),review_id:null};
  assert.throws(()=>bindDeploymentReceipt({...context(),review_id:null},input),/显式跳过/);
  assert.doesNotThrow(()=>bindDeploymentReceipt({...context(),review_id:null,review_skipped:true},input));
  assert.throws(()=>bindDeploymentReceipt({...context(),review_skipped:true},receipt()),/审查绑定无效/);
});

test('none and portable deliveries cannot bypass their own checks with executor receipts',()=>{
  for(const profile of [resolveDeliveryProfile({delivery_target:'source'}),resolveDeliveryProfile({delivery_target:'runtime',runtime_root:projectRuntime})])
    assert.throws(()=>bindDeploymentReceipt({...context(),profile},{...receipt(),profile_sha256:deliveryProfileDigest(profile)}),/不能使用/);
  const local=remote();local.deployment.mode='local';assert.doesNotThrow(()=>bindDeploymentReceipt({...context(),profile:local},{...receipt(),profile_sha256:deliveryProfileDigest(local)}));
  const other=remote();other.deployment.mode='other';assert.doesNotThrow(()=>bindDeploymentReceipt({...context(),profile:other},{...receipt(),profile_sha256:deliveryProfileDigest(other)}));
});
