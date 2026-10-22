export const antigravityGroups = [
  {id:'gemini',name:'Gemini'},
  {id:'argon',name:'Gemini 4 Argon'},
  {id:'claude-gpt',name:'Claude / GPT'},
] as const;
export function antigravityGroup(window:{label?:string}):string {
  const label=window.label||'';
  return /argon/i.test(label)?'argon':/claude|gpt/i.test(label)?'claude-gpt':'gemini';
}
export const defaultAntigravityWindows = [
  {kind:'session',label:'Gemini 5 小时'}, {kind:'weekly',label:'Gemini 每周'},
  {kind:'weekly',label:'Gemini 4 Argon 每周'},
  {kind:'session',label:'Claude / GPT 5 小时'}, {kind:'weekly',label:'Claude / GPT 每周'},
];
