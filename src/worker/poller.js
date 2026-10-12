const defaultLogger = console;

// Single in-process runner. `run` is never invoked concurrently with itself (the next run is
// scheduled only after the previous one settles), errors are logged by name/code only (messages
// can carry connection strings), and stop() waits for the in-flight run.
export function createPoller({ run, intervalMs = 30_000, logger = defaultLogger } = {}) {
  if (typeof run !== "function") throw new Error("run is required");
  let timer = null;
  let running = null;
  let stopped = true;

  async function cycle() {
    timer = null;
    if (stopped) return;
    running = (async () => {
      try {
        await run();
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
      timer = setTimeout(cycle, 0);
    },
    async stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      timer = null;
      if (running) await running;
    },
  };
}
