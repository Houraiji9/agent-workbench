// Editable starter roles. No accounts, purchases, balances or personal plans are seeded.
export const agentBaseline=[
 ['codex','Codex','需求规划、工程实现与问题排查','engineering,frontend_light,review,research,operations'],
 ['claude','Claude','前端设计、工程实现与研究','engineering,frontend_light,review,research,operations'],
 ['grok-build','Grok Build','独立审查其他执行者的产物','review']
].map(([id,name,scope,kinds])=>({id,name,scope,restriction:id==='grok-build'?'只承担独立审查':'按自己的可用工具与资源安排',allowed_kinds:kinds.split(','),account_ids:[],pool_ids:[],model:null,activity:'unknown',activity_source:'尚无执行回报',source:'builtin_template',as_of:null,version:1}));
export const accounts:Record<string,any>[]=[];
export const subscriptions:Record<string,any>[]=[];
