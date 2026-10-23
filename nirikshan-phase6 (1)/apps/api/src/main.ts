import { createApp } from './bootstrap';
import { loadEnv } from './config/env';

createApp().then(async (app) => {
  const env = loadEnv(); await app.listen(env.PORT, '0.0.0.0');
  console.log(`Nirikshan API listening on :${env.PORT}`);
}).catch((e) => { console.error(e); process.exit(1); });
