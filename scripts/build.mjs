import { buildApi, buildSessionRuntime } from '@cantelop/sdk/build';
await buildApi({entrypoint:'src/api.ts',outdir:'artifacts/api'});
await buildSessionRuntime({entrypoint:'src/session.ts',outdir:'artifacts/session'});
console.log('Built Cantelop Edge API and Session runtime artifacts');
