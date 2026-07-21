import { AsyncLocalStorage } from 'async_hooks';

export type GymContext = {
  gymId: number;
  timezone: string;
};

const storage = new AsyncLocalStorage<GymContext>();

export function runWithGymContext<T>(ctx: GymContext, fn: () => T): T {
  return storage.run(ctx, fn);
}

export function getGymContext(): GymContext | undefined {
  return storage.getStore();
}
