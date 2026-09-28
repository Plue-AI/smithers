/** The transactional Durable Object storage surface the worker's objects use. */
export interface Transaction {
  get<T>(key: string): Promise<T | undefined>;
  put<T>(key: string, value: T): Promise<void>;
}
export interface State {
  storage: { transaction<T>(callback: (txn: Transaction) => Promise<T>): Promise<T> };
}
