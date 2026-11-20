declare module "bun:sqlite" {
  export class Database {
    constructor(filename: string);
    run(sql: string, ...params: unknown[]): void;
    query(sql: string): {
      get(...params: unknown[]): unknown;
      all(...params: unknown[]): unknown[];
    };
    transaction(fn: () => void): () => void;
    close(): void;
  }
}
