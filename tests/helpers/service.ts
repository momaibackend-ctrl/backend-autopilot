import { createService } from '../../packages/core/src/runtime.js';
import { MemoryStateStore } from '../../packages/project-registry/src/memory-store.js';
export function testService(){const store=new MemoryStateStore();return {store,service:createService({store})};}
