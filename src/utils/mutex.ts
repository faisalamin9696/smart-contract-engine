/** Minimal async mutex used to serialise block processing. */
export class AsyncMutex {
  private tail: Promise<unknown> = Promise.resolve();

  async runExclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.tail.then(fn, fn);
    this.tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }
}
