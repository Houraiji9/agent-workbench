import type {FastifyInstance} from 'fastify';
import {z} from 'zod';
import type {Workbench} from '../core/workbench.ts';
import type {ApiAgents} from '../core/api-agents.ts';

/** Only page routes: the app's Host/Origin/session/CSRF checks protect credentials. */
export function registerApiAgentRoutes(app:FastifyInstance,_wb:Workbench,agents:ApiAgents){
  app.get('/api/api-agents',async()=>agents.snapshot());
  app.post('/api/api-agents/save',async req=>agents.save(req.body));
  app.post<{Params:{id:string}}>('/api/api-agents/:id/check',async req=>{z.object({}).strict().parse(req.body);return agents.check(req.params.id);});
}
