import type {DeliveryProfile} from '../core/delivery-profile.ts';
/** Display defaults only. Server-side parsing and planning remain authoritative. */
export function deliveryForView(record:Record<string,any>={},project:Record<string,any>={}):DeliveryProfile{
  if(record.delivery_profile)return structuredClone(record.delivery_profile);
  const value=record.delivery_target?record:project;
  if(value.delivery_profile)return structuredClone(value.delivery_profile);
  if(value.delivery_target==='runtime')return {schema:1,artifacts:['source','software'],artifact_description:'',deployment:{mode:'local',target:value.runtime_root||project.runtime_root||'',deploy:'按工作台便携安装流程安装当前受审产物',health:'核对当前便携版本、清单与全部受管程序文件',rollback:'保留并使用安装前的便携程序备份回滚',verification:'portable_manifest'}};
  return {schema:1,artifacts:['source'],artifact_description:'',deployment:{mode:'none',target:'',deploy:'',health:'',rollback:'',verification:'none'}};
}
