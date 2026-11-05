import type {FastifyInstance} from 'fastify';
import {z} from 'zod';
import {ExternalServices} from '../core/external-services.ts';
import {externalQueryInput,externalArtifactInput,type ExternalCaller} from '../core/external-service-schema.ts';
import {assert} from '../core/security.ts';

export function registerExternalServiceRoutes(app:FastifyInstance,services:ExternalServices){
  app.get('/api/external-services',async()=>services.snapshot());
  app.post('/api/external-services/save',async req=>services.save(req.body));
  app.post<{Params:{id:string}}>('/api/external-services/:id/probe',async req=>{z.object({}).strict().parse(req.body);return services.probe(req.params.id);});
  app.post<{Params:{id:string}}>('/api/external-services/:id/delete',async req=>services.remove(req.params.id,z.object({version:z.number().int()}).strict().parse(req.body).version));
  app.get<{Params:{id:string}}>('/api/external-services/:id/calling',async req=>services.calling(req.params.id));
  app.get<{Params:{id:string}}>('/api/external-services/invocations/:id',async req=>services.poll(req.params.id));
  app.post('/api/external-services/harness-grant',async req=>{
    const v=z.object({project_id:z.string(),agent_id:z.string(),credential_path:z.string()}).strict().parse(req.body);
    return services.createImageGrant(v.project_id,v.agent_id,v.credential_path);
  });
}
export async function callExternalTool(services:ExternalServices,tool:string,input:any,caller:ExternalCaller){
  if(tool==='list_external_services')return services.list(caller,input.project_id);
  if(tool==='get_external_calling'){
    const list=services.list(caller,input.project_id);assert(list.services.some(c=>c.id===input.service_id),'此连接未授权给当前会话',403);return services.calling(input.service_id);
  }
  if(tool==='invoke_external_service')return services.invoke(input,caller);
  if(tool==='get_external_invocation'){const v=externalQueryInput.parse(input);return services.poll(v.invocation_id,caller);}
  if(tool==='get_external_artifact'){const v=externalArtifactInput.parse(input);return services.artifact(v.invocation_id,v.artifact_id,caller);}
  throw new Error('外部工具未登记');
}
