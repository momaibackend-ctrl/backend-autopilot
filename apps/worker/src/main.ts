import { createService } from '../../../packages/core/src/index.js';
import { logger } from '../../../packages/observability/src/index.js';
const service=createService();logger.info(await service.systemHealth(),'worker ready; v0.3 operations are explicitly triggered through MCP/API');
setInterval(()=>logger.debug('worker heartbeat'),30_000).unref();
