// Entry point for the forge: owns only the conversation with the trial env.
// The HTTP surface itself lives in app.ts; this file binds a port, announces
// it, and stays alive until the env declares the trial finished.
//
// Sequence: read MAKEFUN_ENV_URL (absent means there is no trial, so exit 1),
// listen on port 0 so the kernel assigns a free one, POST /register with the
// chosen port, then poll GET /done and exit 0 once it reports done.

import { createApp } from './app.ts';

const envBase = (process.env.MAKEFUN_ENV_URL || '').replace(/\/+$/, '');

if (!envBase) {
  console.error('forge: MAKEFUN_ENV_URL is not set; nothing to register with');
  process.exit(1);
}

const FETCH_TIMEOUT_MS = 30_000;
const FIRST_BACKOFF_MS = 200;
const MAX_BACKOFF_MS = 2_500;

function backoffMs(failures: number): number {
  const grown = FIRST_BACKOFF_MS * Math.pow(2, Math.min(failures, 9));
  return Math.min(MAX_BACKOFF_MS, grown);
}

function pause(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Tell the env where we listen. A 200 registers us; a 409 means an earlier
// register from this trial already won and is equally good. Contract errors
// (400/405) are fatal; anything else is retried while the env warms up.
async function announce(port: number): Promise<void> {
  let failures = 0;
  for (;;) {
    let fatal: Error | null = null;
    try {
      const reply = await fetch(envBase + '/register', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ port }),
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (reply.status === 200 || reply.status === 409) return;
      if (reply.status === 400 || reply.status === 405) {
        fatal = new Error('register refused with HTTP ' + reply.status + ': ' + (await reply.text()));
      }
    } catch (err) {
      if (fatal === null && err instanceof Error && err.message.indexOf('register refused') === 0) fatal = err;
    }
    if (fatal !== null) throw fatal;
    await pause(backoffMs(failures));
    failures += 1;
  }
}

// Poll the env's /done route. Only a JSON body with done === true ends the
// wait; errors and non-done answers just schedule another poll.
async function awaitDone(): Promise<void> {
  let failures = 0;
  for (;;) {
    let finished = false;
    try {
      const reply = await fetch(envBase + '/done', {
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (reply.ok) {
        const body: any = await reply.json();
        finished = body !== null && typeof body === 'object' && body.done === true;
      }
    } catch {
      finished = false;
    }
    if (finished) return;
    await pause(backoffMs(failures));
    failures += 1;
  }
}

const server = createApp();

const boundPort: number = await new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(0, () => {
    const addr = server.address();
    if (addr === null || typeof addr === 'string') {
      reject(new Error('forge: listen(0) did not yield a TCP port'));
      return;
    }
    resolve(addr.port);
  });
});

console.log('forge: listening on port ' + boundPort);
await announce(boundPort);
console.log('forge: registered with the env; serving until done');
await awaitDone();
server.close();
console.log('forge: env reports done; exiting');
process.exit(0);
