// Entry point: `node server/index.mjs`. Also re-exports createApp for tests.
import { fileURLToPath } from 'node:url';
import { realpathSync } from 'node:fs';
import { createApp, optionsFromEnv } from './app.mjs';

export { createApp, optionsFromEnv } from './app.mjs';

export async function main(env = process.env) {
  const opts = optionsFromEnv(env);
  const app = createApp(opts);
  await new Promise((resolve, reject) => {
    app.server.once('error', reject);
    app.server.listen(opts.port, opts.host, resolve);
  });
  const addr = app.server.address();
  console.log(`missing-works api listening on ${addr.address}:${addr.port}${opts.serveStatic ? ' (serving static files)' : ''}`);
  const shutdown = (signal) => {
    console.log(`${signal} received, shutting down`);
    const force = setTimeout(() => process.exit(1), 10_000);
    force.unref();
    app.close().then(() => process.exit(0), () => process.exit(1));
  };
  process.once('SIGTERM', () => shutdown('SIGTERM'));
  process.once('SIGINT', () => shutdown('SIGINT'));
  return app;
}

function isMain() {
  try {
    return process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isMain()) {
  main().catch((err) => {
    console.error(`failed to start: ${err.message}`);
    process.exit(1);
  });
}
