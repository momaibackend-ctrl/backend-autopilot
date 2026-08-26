import { buildPortableRuntime, portableRuntimeConfigFromEnv } from './app.js';

const app = buildPortableRuntime(portableRuntimeConfigFromEnv());
const port = Number(process.env['PORT'] ?? process.env['AUTOPILOT_PORT'] ?? 4310);
const host = process.env['HOST'] ?? process.env['AUTOPILOT_HOST'] ?? '0.0.0.0';

await app.listen({ port, host });

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    void app.close().finally(() => process.exit(0));
  });
}
