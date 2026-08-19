import Fastify from 'fastify';
import { DomainError, type AutopilotService } from '../../../packages/core/src/index.js';
import { logger } from '../../../packages/observability/src/index.js';
import { redact } from '../../../packages/audit/src/index.js';

export function buildControlApi(service:AutopilotService){
  const app=Fastify({loggerInstance:logger});
  app.setErrorHandler((error,_request,reply)=>{if(error instanceof DomainError)return reply.code(error.code==='NOT_FOUND'?404:409).send({error:{code:error.code,message:error.message,details:redact(error.details)}});return reply.code(500).send({error:{code:'INTERNAL',message:error instanceof Error?error.message:'Unknown error'}});});
  app.get('/health',()=>service.systemHealth());app.get('/v1/projects',()=>service.projectList());app.post('/v1/projects',request=>service.projectCreate(request.body));app.get<{Params:{projectId:string}}>('/v1/projects/:projectId/snapshot',request=>service.projectSnapshot(request.params.projectId));app.get<{Params:{projectId:string}}>('/v1/projects/:projectId/tasks',request=>service.taskList(request.params.projectId));return app;
}
