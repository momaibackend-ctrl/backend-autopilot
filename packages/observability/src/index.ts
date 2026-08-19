import pino from 'pino';
export const logger=pino({level:process.env['AUTOPILOT_LOG_LEVEL']??'info',base:{service:'backend-autopilot',platformVersion:'0.2.0'},redact:{paths:['*.token','*.secret','*.password','*.authorization','*.apiKey'],censor:'[REDACTED]'}});
export class MetricsRegistry {private counters=new Map<string,number>();increment(name:string,value=1){this.counters.set(name,(this.counters.get(name)??0)+value);}snapshot(){return Object.fromEntries(this.counters);}}
