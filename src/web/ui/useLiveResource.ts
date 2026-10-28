import {useEffect,useRef,useState} from 'react';
import {api} from '../api.js';
import {snapshotRefresh} from '../app/snapshot.js';

/** One active read plus one queued notification; background reads keep the current view mounted. */
export function useLiveResource<T>(url:string|null,changeTick:number){
 type State={key:string|null;data:T|null;signature?:string;error:string;loading:boolean};
 const [state,setState]=useState<State>({key:null,data:null,error:'',loading:false});
 const source=useRef<{key:string;refresh:()=>Promise<void>}|null>(null);
 useEffect(()=>{
  setState({key:url,data:null,error:'',loading:!!url});
  if(!url){source.current=null;return;}
  const scope=new AbortController();
  const refresh=snapshotRefresh<T>(signal=>{
   if(scope.signal.aborted)throw new DOMException('范围已切换','AbortError');
   setState(current=>current.key===url&&!current.data&&!current.loading?{...current,loading:true}:current);
   return api(url,undefined,AbortSignal.any([signal,scope.signal]));
  },data=>{
   if(scope.signal.aborted)return;
   const signature=JSON.stringify(data);
   setState(current=>current.key!==url?current:current.signature===signature&&!current.error&&!current.loading?current:{key:url,data,signature,error:'',loading:false});
  },()=>{
   // The refresh promise preserves the actual failure below; never remove the last successful data.
  });
  const value={key:url,refresh:()=>refresh().catch(error=>{if(!scope.signal.aborted)setState(current=>current.key===url?{...current,error:error instanceof Error?error.message:'读取失败',loading:false}:current);})};
  source.current=value;
  return()=>{scope.abort();if(source.current===value)source.current=null;};
 },[url]);
 useEffect(()=>{if(source.current?.key===url)void source.current.refresh();},[url,changeTick]);
 // Gate during render, before effects run, so another project's/range's previous data cannot flash.
 const current=state.key===url;
 return {data:current?state.data:null,error:current?state.error:'',loading:!!url&&(!current||state.loading)};
}
