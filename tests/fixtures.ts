import type {Workbench} from '../src/core/workbench.ts';
// Synthetic test records. This module is never imported by application code.
export function seedTestData(wb:Workbench){
 const roster=[['zcode','Zcode','engineering,frontend_light,review,operations'],['cursor','Cursor','engineering,review'],['deepseek','DeepSeek Harness','engineering,frontend_light,review,operations'],['antigravity-flash','Antigravity / Gemini Flash','engineering,operations'],['antigravity-claude','Antigravity / Claude','frontend_light'],['cursor-claude','Cursor / Claude','frontend_light'],['grok-bot','Grok Bot','engineering,frontend_light'],['grok-search','Grok 网页','research,operations'],['gemini','Gemini 应用','research,operations'],['kimi','Kimi','engineering,research,operations'],['workbuddy','WorkBuddy','operations'],['antigravity','Antigravity','engineering,frontend_light,operations']];
 wb.transaction(()=>{
  for(const [id,name,kinds] of roster)if(!wb.maybe('agents',id))wb.put('agents',{id,name,scope:'测试专用职责',restriction:'测试夹具',allowed_kinds:kinds.split(','),account_ids:[],pool_ids:[],model:null,source:'user_reported',version:1,archived:['cursor','cursor-claude','antigravity-flash','antigravity-claude'].includes(id),...(['antigravity-flash','antigravity-claude'].includes(id)?{merged_into:'antigravity'}:{})});
  for(const id of ['test-codex','test-personal','zcode','x','google','kimi','workbuddy','test-claude'])if(!wb.maybe('accounts',id))wb.put('accounts',{id,name:'测试账号 '+id,source:'test_fixture'});
  for(const [id,account]of [['codex','test-codex'],['zcode','zcode']])wb.put('agents',{...wb.get('agents',id),account_ids:[account]});
  const entries=[
   {id:'test-active-codex',account_id:'test-codex',title:'测试Codex订阅',status:'user_reported_active',end_date:'2035-03-01'},
   {id:'test-expired',account_id:'test-personal',title:'测试过期订阅',status:'user_reported_expired'},
   {id:'test-active-zcode',account_id:'zcode',title:'测试Zcode订阅',status:'user_reported_active',end_date:'2035-04-15'},
   {id:'test-active-kimi',account_id:'kimi',title:'测试Kimi订阅',status:'user_reported_active'},
   {id:'test-active-claude',account_id:'test-claude',title:'测试Claude订阅',status:'user_reported_active',amount:null},
   {id:'test-plan-shared',account_id:'x',title:'测试计划B',status:'planned',planned_date:'2035-04-15'},
   {id:'test-plan-price',account_id:'google',title:'测试计划A',status:'planned',planned_date:'2035-05-01',amount:12.5,currency:'USD',interval:'month'},
   {id:'test-plan-codex',account_id:'test-personal',title:'测试计划C',status:'planned',planned_date:'2035-03-01'}
  ];
  for(const s of entries)if(!wb.maybe('subscriptions',s.id))wb.put('subscriptions',{end_date:null,confirmed_at:null,source:'user_reported',version:1,...s},{account_id:s.account_id});
  if(!wb.maybe('quota_pools','test-shared-planned'))wb.put('quota_pools',{id:'test-shared-planned',name:'测试共享计划',status:'planned',members:[],source:'test_fixture',archived:true});
 });return wb;
}
