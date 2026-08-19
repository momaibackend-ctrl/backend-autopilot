import { createService } from '../../../packages/core/src/index.js';
import { buildControlApi } from './app.js';

const app=buildControlApi(createService());
const port=Number(process.env['AUTOPILOT_PORT']??4310);const host=process.env['AUTOPILOT_HOST']??'127.0.0.1';
await app.listen({port,host});
