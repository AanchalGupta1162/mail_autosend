const MIN_DELAY_MS = 5000;

export function computeDelayMs(windowMinutes, numPending) {
  if (numPending <= 1) return 0;
  const windowMs = windowMinutes * 60 * 1000;
  return Math.max(MIN_DELAY_MS, Math.floor(windowMs / numPending));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Sends `rows` one at a time, waiting `delayMs` between each send.
 * `sendOne(row)` is called for every row; its resolution/rejection
 * determines success/failure but never stops the queue.
 */
export async function processQueue(rows, delayMs, sendOne) {
  for (let i = 0; i < rows.length; i++) {
    if (i > 0) await sleep(delayMs);
    const row = rows[i];
    try {
      await sendOne(row);
    } catch (error) {
      // sendOne is expected to handle logging/marking failure itself;
      // we just make sure one bad row never stops the rest of the queue.
    }
  }
}
