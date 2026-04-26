export interface BoundedSetOptions {
  maxSize: number;
  /** Entries older than this count as absent. Omit for size based eviction only. */
  ttlMs?: number;
  now?: () => number;
}

/** Remembers recent keys. The oldest entry goes first when full, so memory stays flat. */
export class BoundedSet<T> {
  private readonly entries = new Map<T, number>();
  private readonly now: () => number;

  constructor(private readonly options: BoundedSetOptions) {
    this.now = options.now ?? Date.now;
  }

  has(key: T): boolean {
    const addedAt = this.entries.get(key);
    if (addedAt === undefined) return false;
    if (this.options.ttlMs !== undefined && this.now() - addedAt >= this.options.ttlMs) {
      this.entries.delete(key);
      return false;
    }
    return true;
  }

  add(key: T): void {
    this.entries.delete(key);
    this.entries.set(key, this.now());
    while (this.entries.size > this.options.maxSize) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
  }

  get size(): number {
    return this.entries.size;
  }
}
