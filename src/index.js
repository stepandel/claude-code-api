import { DockerRuntime } from './runtime.js';
import { Service } from './service.js';
import { server } from './server.js';
const token = process.env.CANTELOP_ADMIN_TOKEN;
if (!token || token.length < 32) throw new Error('Set CANTELOP_ADMIN_TOKEN to at least 32 random characters');
const service = new Service(new DockerRuntime(process.env.CANTELOP_IMAGE));
const app = server(service, token);
app.listen(Number(process.env.PORT ?? 3000), process.env.HOST ?? '127.0.0.1', () => {
  console.log('Cantelop listening', app.address());
});
let closing = false;
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, async () => {
  if (closing) return; closing = true;
  app.close();
  try { await service.close(); } catch { console.error('Container cleanup failed; inspect docker ps --filter label=app=cantelop'); process.exitCode = 1; }
});
