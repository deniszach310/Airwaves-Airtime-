import { loadConfig } from './config.mjs';
import { createProviders } from './providers.mjs';
import { database, PostgresStore } from './store.mjs';
import { createWorker } from './workflow.mjs';
import { createApp } from './app.mjs';

const config = loadConfig();
const pool = database(config);
const store = new PostgresStore(pool);
await store.migrate();
const providers = createProviders(config);
const worker = createWorker(store,providers,config);
const server = createApp(config,store,providers);
server.listen(config.port,process.env.BIND_HOST || '127.0.0.1',() => console.log('AIRWAVES server listening on port ' + config.port));
const timer = setInterval(() => worker().catch(error => console.error('Background processing failed',error.code || error.name)),2000);
for (const signal of ['SIGTERM','SIGINT']) process.once(signal,() => {
  clearInterval(timer);
  server.close(async () => { await pool.end(); });
});
