type BeforeLock = (account: string) => void | Promise<void>;
const beforeLock = new Set<BeforeLock>();
export function onBeforeAccountLock(handler: BeforeLock) {
  beforeLock.add(handler);
  return () => beforeLock.delete(handler);
}
export async function prepareAccountLock(account: string) {
  // A failed draft write keeps the session unlocked so the user can retry.
  await Promise.all([...beforeLock].map((handler) => handler(account)));
}
