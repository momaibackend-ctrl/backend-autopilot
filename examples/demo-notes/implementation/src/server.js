import { createServer } from 'node:http';
import { URL } from 'node:url';
// The task this demo implements requires "Structured logging and observable errors". It used to
// claim that in its requirements and ship none: every failure was serialized to the client and
// otherwise swallowed, so an operator watching this service saw nothing at all. One JSON line per
// request, and every error carrying its code, is the smallest thing that makes the claim true.
const emit=(level,event,fields)=>process.stdout.write(JSON.stringify({level,event,at:new Date().toISOString(),...fields})+'\n');
export const log={info:(event,fields={})=>emit('info',event,fields),error:(event,fields={})=>emit('error',event,fields)};
export function createNotesServer(service){return createServer(async(req,res)=>{const owner=req.headers['x-user-id'];const url=new URL(req.url,'http://localhost');const id=url.pathname.split('/')[2];const startedAt=Date.now();try{let body={};for await(const chunk of req)body=JSON.parse(chunk.toString());let value,status=200;if(req.method==='POST'&&url.pathname==='/notes'){value=await service.create(owner,body);status=201;}else if(req.method==='GET'&&url.pathname==='/notes')value=await service.list(owner);else if(req.method==='GET'&&id)value=await service.get(owner,id);else if(req.method==='PATCH'&&id)value=await service.update(owner,id,body);else if(req.method==='DELETE'&&id){await service.remove(owner,id);status=204;}else throw Object.assign(new Error('NOT_FOUND'),{code:'NOT_FOUND',status:404});log.info('notes.request',{method:req.method,path:url.pathname,status,durationMs:Date.now()-startedAt});res.writeHead(status,{'content-type':'application/json'});res.end(status===204?'':JSON.stringify(value));}catch(error){const status=error.status??500;
// The owner id is deliberately absent from the log: it identifies a person, and a request log is
// not the place to put one. Method, path, status and error code are what an operator acts on.
log.error('notes.request_failed',{method:req.method,path:url.pathname,status,code:error.code??'INTERNAL',durationMs:Date.now()-startedAt});res.writeHead(status,{'content-type':'application/json'});res.end(JSON.stringify({error:{code:error.code??'INTERNAL'}}));}});}
