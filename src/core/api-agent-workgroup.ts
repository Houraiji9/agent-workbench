import type {Workbench} from './workbench.ts';
import type {ApiAgents,ApiAgentTurn} from './api-agents.ts';
import {runApiAgentTurn,type ApiAgentRuntimeDependencies} from './api-agent-runtime.ts';
import type {WorkgroupRunner,WorkgroupRuntimeInput} from './workgroup-schema.ts';

type ToolCall=(input:WorkgroupRuntimeInput,name:string,args:Record<string,unknown>,signal:AbortSignal)=>Promise<unknown>;

/** HTTP credentials and private transcripts remain in the backend, outside group tools. */
export function createApiWorkgroupRunner(wb:Workbench,agents:ApiAgents,callTool:ToolCall,deps:ApiAgentRuntimeDependencies={}):WorkgroupRunner{
  return async input=>{
    let turn:ApiAgentTurn|undefined;
    try{
      if(input.signal.aborted)return {status:'cancelled',text:'',exitCode:null,processStopped:true,errorCode:'api_cancelled'};
      turn=await agents.acquireTurn({agentId:input.agentId,roomId:input.roomId,memberId:input.memberId,jobId:input.jobId,...(input.nativeSessionId?{sessionId:input.nativeSessionId}:{})});
      const config=turn.config;
      return await runApiAgentTurn({
        protocol:config.protocol,baseUrl:config.base_url,apiKey:config.apiKey,model:config.model,systemPrompt:config.system_prompt,
        prompt:input.prompt,cwd:input.cwd,allowedRoots:input.allowedRoots,protectedPaths:[wb.config.dataDir],isPrivatePath:file=>wb.privatePath(file),
        sessionId:turn.session.id,state:turn.session.state,signal:input.signal,timeoutMs:input.timeoutMs,
        tools:input.mcp.tools,callTool:(name,args,context)=>callTool(input,name,args,context.signal),
        onCheckpoint:state=>turn!.save(state),onSessionId:input.onSessionId,onActivity:input.onActivity,onBeforeRequest:input.onBeforeRequest,
      },deps);
    }catch{
      return {status:input.signal.aborted?'cancelled':'blocked',text:'',exitCode:null,processStopped:true,errorCode:input.signal.aborted?'api_cancelled':'api_configuration_unavailable',errorMessage:input.signal.aborted?'API 调用已停止。':'无法使用本机 API 配置或解锁会话，请检查此成员的配置、密钥和调用状态。'};
    }finally{if(turn){turn.release();turn.config.apiKey='';}}
  };
}
