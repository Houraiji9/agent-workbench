import type {FastifyInstance} from 'fastify';
import {z} from 'zod';
import type {Workgroups} from '../core/workgroups.ts';

/** The application's normal Host/Origin/cookie/CSRF hook must protect these page routes. */
export function registerWorkgroupRoutes(app:FastifyInstance,groups:Workgroups){
  app.get('/api/workgroups',async req=>{const v=z.object({project_id:z.string().optional()}).strict().parse(req.query);return groups.list(v.project_id);});
  app.get('/api/workgroups/candidates',async req=>{const v=z.object({project_id:z.string()}).strict().parse(req.query);return groups.candidates(v.project_id);});
  app.post('/api/workgroups',async req=>groups.create(req.body));
  app.get<{Params:{id:string}}>('/api/workgroups/:id',async req=>groups.detail(req.params.id,req.query));
  app.get<{Params:{id:string;jobId:string}}>('/api/workgroups/:id/jobs/:jobId',async req=>groups.jobDetail(req.params.id,req.params.jobId));
  app.post<{Params:{id:string}}>('/api/workgroups/:id/messages',async req=>groups.post(req.params.id,req.body));
  app.post<{Params:{id:string}}>('/api/workgroups/:id/dispatch',async req=>groups.dispatch(req.params.id,req.body));
  app.patch<{Params:{id:string}}>('/api/workgroups/:id',async req=>groups.update(req.params.id,req.body));
  app.post<{Params:{id:string}}>('/api/workgroups/:id/update',async req=>groups.update(req.params.id,req.body));
  app.post<{Params:{id:string}}>('/api/workgroups/:id/members',async req=>groups.addRoomMember(req.params.id,req.body));
  const removal=(room:string,member:string,body:unknown)=>groups.removeMember(room,member,z.object({expected_revision:z.number().int().positive()}).strict().parse(body).expected_revision);
  app.delete<{Params:{id:string;memberId:string}}>('/api/workgroups/:id/members/:memberId',async req=>removal(req.params.id,req.params.memberId,req.body));
  app.post<{Params:{id:string;memberId:string}}>('/api/workgroups/:id/members/:memberId/remove',async req=>removal(req.params.id,req.params.memberId,req.body));
  app.post<{Params:{id:string;jobId:string}}>('/api/workgroups/:id/jobs/:jobId/cancel',async req=>{z.object({reason:z.string().max(2000).optional()}).strict().parse(req.body);return groups.cancel(req.params.id,req.params.jobId);});
  app.post<{Params:{id:string;jobId:string}}>('/api/workgroups/:id/jobs/:jobId/resume',async req=>groups.resume(req.params.id,req.params.jobId,req.body));
  app.post<{Params:{id:string}}>('/api/workgroups/:id/stop',async req=>{z.object({reason:z.string().max(2000).optional()}).strict().parse(req.body);return groups.stop(req.params.id);});
}
