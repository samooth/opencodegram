export class MetricsStore {
  private readonly counters = new Map<string, number>();
  readonly startedAt = Date.now();
  lastError: { time: number; message: string } | null = null;

  inc(name: string, amount = 1): void {
    this.counters.set(name, (this.counters.get(name) ?? 0) + amount);
  }

  recordError(message: string): void {
    this.lastError = { time: Date.now(), message: message.slice(0, 200) };
    this.inc("errors");
  }

  get(name: string): number {
    return this.counters.get(name) ?? 0;
  }

  snapshot(): Record<string, number> {
    return Object.fromEntries(this.counters);
  }
}
