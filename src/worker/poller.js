const defaultLogger = console;

// Single in-process runner. `run` is never invoked concurrently with itself (the next run is
// scheduled only after the previous one settles), errors are logged by name/code only (messages
// can carry connection strings), and stop() waits for the in-flight run.
export function createPoller({ run, intervalMs = 30_000, logger = defaultLogger } = {}) {
  if (typeof run !== "function") throw new Error("run is required");
  let timer = null;
  let running = null;
  let stopped = true;
  let abort = new AbortController();

  async function cycle() {
    timer = null;
    if (stopped) return;
    running = (async () => {
      try {
        await run({ shouldStop: () => stopped, signal: abort.signal });
      } catch (err) {
        logger.error(`poller tick failed: ${err?.name ?? "Error"} ${err?.code ?? ""}`.trim());
      }
    })();
    await running;
    running = null;
    if (!stopped) timer = setTimeout(cycle, intervalMs);
  }

  return {
    start() {
      if (!stopped) return;
      stopped = false;
      abort = new AbortController();
      timer = setTimeout(cycle, 0);
    },
    async stop() {
      stopped = true;
      abort.abort();
      if (timer) clearTimeout(timer);
      timer = null;
      if (running) await running;
    },
  };
}


// Shutdown helper: stop the send loop and the sweep loop together. The send poller is asked to
// stop first and the sweep is never awaited before it, so sending is not prolonged by a slow IMAP run.
export async function stopWorkers(send, sweep) {
  const stopping = [send?.stop(), sweep?.stop()];
  await Promise.all(stopping);
}
