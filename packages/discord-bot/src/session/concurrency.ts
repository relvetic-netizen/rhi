export class Semaphore {
  private current = 0;
  private queue: Array<() => void> = [];

  constructor(private readonly max: number) {}

  async acquire(): Promise<void> {
    if (this.current < this.max) {
      this.current++;
      return;
    }
    return new Promise<void>((resolve) => {
      this.queue.push(() => {
        this.current++;
        resolve();
      });
    });
  }

  tryAcquire(): boolean {
    if (this.current < this.max) {
      this.current++;
      return true;
    }
    return false;
  }

  release(): void {
    this.current--;
    const next = this.queue.shift();
    if (next) next();
  }

  get available(): number {
    return this.max - this.current;
  }
}

export class UserSemaphoreMap {
  private map = new Map<string, { sem: Semaphore; lastUsed: number }>();
  private cleanupInterval: ReturnType<typeof setInterval>;

  constructor(cleanupIntervalMs = 300_000) {
    this.cleanupInterval = setInterval(() => this.purgeIdle(), cleanupIntervalMs);
  }

  get(userId: string): Semaphore {
    let entry = this.map.get(userId);
    if (!entry) {
      entry = { sem: new Semaphore(1), lastUsed: Date.now() };
      this.map.set(userId, entry);
    }
    entry.lastUsed = Date.now();
    return entry.sem;
  }

  private purgeIdle(maxIdleMs = 600_000): void {
    const now = Date.now();
    for (const [userId, entry] of this.map) {
      if (now - entry.lastUsed > maxIdleMs && entry.sem.available > 0) {
        this.map.delete(userId);
      }
    }
  }

  destroy(): void {
    clearInterval(this.cleanupInterval);
    this.map.clear();
  }
}
