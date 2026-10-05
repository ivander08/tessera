/**
 * `ctx.waitUntil`, for a process that outlives the request.
 *
 * The Worker's execution context kept a promise alive after the response was returned and
 * let the isolate die when it was done. A server has no such boundary: a promise nobody
 * holds is a promise nobody can wait for, so a `systemctl restart` mid-turn would cut a
 * write that was already committed to happening.
 *
 * This keeps a set of the outstanding promises and awaits them on shutdown. A rejection
 * is swallowed and logged here rather than propagated — the caller already returned its
 * response, so there is no one left to throw to, and an unhandled rejection would take
 * the process down on a job that failed exactly the way `waitUntil` was designed to
 * tolerate.
 */
export class DeferredWork {
  private readonly pending: Set<Promise<unknown>> = new Set();
  private draining = false;

  add(promise: Promise<unknown>): void {
    const tracked: Promise<unknown> = promise
      .catch((error: unknown) => {
        console.warn(`[server] deferred work failed: ${error instanceof Error ? error.message : String(error)}`);
      })
      .finally(() => {
        this.pending.delete(tracked);
      });
    this.pending.add(tracked);
  }

  /** How many promises are still in flight. Used by the shutdown path and by tests. */
  get size(): number {
    return this.pending.size;
  }

  /**
   * Waits for everything outstanding.
   *
   * `allSettled` rather than `all`: one failed job must not stop the drain from waiting on
   * the others, and the failure has already been logged by `add`. Work added while draining
   * is picked up too, because the loop re-reads the set until it is empty.
   */
  async drain(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    while (this.pending.size > 0) {
      await Promise.allSettled([...this.pending]);
    }
    this.draining = false;
  }
}
