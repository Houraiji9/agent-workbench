/** Compare requested identifiers consistently; only Claude's documented short aliases expand. */
export function requestedModelMatches(client:string|null|undefined,requested:string|null|undefined,actual:string|null|undefined){
 if(!requested||!actual)return true;
 return actual===requested||client==='claude'&&['sonnet','opus','haiku'].includes(requested)&&actual.startsWith('claude-'+requested+'-');
}
