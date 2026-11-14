// Entry point: wire the forge server to the trial env.
//
// The env hands this process MAKEFUN_ENV_URL. The process binds its HTTP
// server to an ephemeral port, tells the env that port, then polls the
// env until the trial is finished. That is the whole lifecycle; the
// scored work lives in app.ts, not here.
//
// Behaviour, step by step:
//   - No MAKEFUN_ENV_URL means there is no env to talk to: exit 1.
//   - listen(0) lets the OS pick a free port. Port 8080 belongs to the
//     env and must never be bound by this process.
//   - POST <env>/register with {"port": N}. The env records the caller
//     address plus N and starts dialing it. The first register wins;
//     a 409 means another entry registered first, and that is fine.
//   - GET <env>/done, polling until the body is {"done": true}.
//     A failed poll is retried with exponential backoff; the process
//     never exits before the env reports done.
//   - Close the server and exit 0. The harness then stops the env.

import { createApp } from './app.ts';

const envBase = (process.env.MAKEFUN_ENV_URL ?? '').replace(/\/+$/, '');
if (envBase === '') {
  process.stderr.write('[entry] MAKEFUN_ENV_URL is not set: no env to register with\n');
  process.exit(1);
}

const REQ_MS = 30_000;
const BACKOFF_FIRST_MS = 250;
const BACKOFF_MAX_MS = 2_000;

const pause = (ms: number): Promise<void> => new Promise((ok) => setTimeout(ok, ms));

function backoffMs(failures: number): number {
  return Math.min(BACKOFF_MAX_MS, BACKOFF_FIRST_MS * 2 ** Math.min(failures, 8));
}

async function announce(port: number): Promise<void> {
  for (let failures = 0; ; failures += 1) {
    try {
      const reply = await fetch(`${envBase}/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ port }),
        signal: AbortSignal.timeout(REQ_MS),
      });
      if (reply.status === 200 || reply.status === 409) return;
      if (reply.status === 400 || reply.status === 405) {
        throw new Error(`register failed with HTTP ${reply.status}: ${await reply.text()}`);
      }
    } catch (err) {
      if (err instanceof Error && err.message.startsWith('register failed with HTTP ')) throw err;
    }
    await pause(backoffMs(failures));
  }
}

async function awaitDone(): Promise<void> {
  for (let failures = 0; ; failures += 1) {
    try {
      const reply = await fetch(`${envBase}/done`, { signal: AbortSignal.timeout(REQ_MS) });
      if (reply.ok) {
        const payload = (await reply.json()) as { done?: unknown };
        if (payload.done === true) return;
      }
    } catch {
      // The env is not answering yet: keep polling.
    }
    await pause(backoffMs(failures));
  }
}

async function run(): Promise<void> {
  const server = createApp();
  await new Promise<void>((ok, fail) => {
    server.once('error', fail);
    server.listen(0, () => ok());
  });
  const bound = server.address();
  if (bound === null || typeof bound === 'string') {
    throw new Error('the server did not bind an ephemeral TCP port');
  }
  process.stdout.write(`[entry] listening on port ${bound.port}\n`);
  await announce(bound.port);
  process.stdout.write('[entry] registered; waiting for the env to finish\n');
  await awaitDone();
  server.close();
  process.stdout.write('[entry] done\n');
}

try {
  await run();
  process.exit(0);
} catch (err) {
  process.stderr.write(`[entry] ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
}
