/**
 * main.ts — entrypoint.
 *
 * Trial mode (MAKEFUN_ENV_URL set): bind an ephemeral port, register it with
 * the environment, serve until the environment reports done, then exit 0.
 * Standalone mode (no MAKEFUN_ENV_URL): serve on PORT (default: ephemeral)
 * for local testing.
 *
 * The only wall-clock use in the whole entry lives here, in the register
 * retry backoff — never in anything the server sends.
 */

import { createApp } from './app.ts';

const ENV_URL = process.env.MAKEFUN_ENV_URL;
const SHOP_TOKEN = process.env.MAKEFUN_SHOP_TOKEN;
const VIEWER_LOGIN = process.env.FORGE_VIEWER_LOGIN ?? 'adaiversen';

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function register(envUrl: string, port: number): Promise<void> {
  let delay = 250;
  for (let attempt = 0; ; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30_000);
    try {
      const response = await fetch(`${envUrl}/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ port }),
        signal: controller.signal,
      });
      if (response.status === 200 || response.status === 409) return;
      if (response.status === 400 || response.status === 405) {
        throw new Error(`register rejected with HTTP ${response.status}`);
      }
      // Any other status is retried.
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('register rejected')) throw error;
      // Network errors and aborts are retried.
    } finally {
      clearTimeout(timeout);
    }
    if (attempt >= 60) throw new Error('register did not succeed after repeated retries');
    await sleep(delay);
    delay = Math.min(delay * 2, 2000);
  }
}

async function waitForDone(envUrl: string): Promise<void> {
  for (;;) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10_000);
    try {
      const response = await fetch(`${envUrl}/done`, { signal: controller.signal });
      if (response.ok) {
        const data = (await response.json()) as { done?: unknown };
        if (data.done === true) return;
      }
    } catch {
      // The environment may be briefly unreachable; keep polling.
    } finally {
      clearTimeout(timeout);
    }
    await sleep(250);
  }
}

async function main(): Promise<void> {
  const { server } = createApp({ expectedToken: SHOP_TOKEN, viewerLogin: VIEWER_LOGIN });

  process.on('uncaughtException', (error) => {
    console.error('uncaught exception (server keeps running):', error);
  });
  process.on('unhandledRejection', (reason) => {
    console.error('unhandled rejection (server keeps running):', reason);
  });

  const requestedPort = ENV_URL ? 0 : Number.parseInt(process.env.PORT ?? '0', 10) || 0;
  const port = await new Promise<number>((resolve, reject) => {
    server.once('error', reject);
    server.listen(requestedPort, () => {
      const address = server.address();
      if (address && typeof address === 'object') resolve(address.port);
      else reject(new Error('server did not bind to a port'));
    });
  });

  if (!ENV_URL) {
    console.error(`forge-v2 listening on port ${port} (standalone; MAKEFUN_ENV_URL is not set)`);
    // The listening server keeps the process alive; never resolve-and-exit here.
    return;
  }

  await register(ENV_URL, port);
  console.error(`forge-v2 registered on port ${port}`);
  await waitForDone(ENV_URL);
  await new Promise<void>((resolve) => server.close(() => resolve()));
  process.exit(0);
}

main().catch((error: unknown) => {
  console.error('fatal:', error instanceof Error ? error.message : String(error));
  process.exit(1);
});
