import { deviceStorage } from "./deviceStorage";
export const autoLockKey = (account: string) =>
  `hainei_background_lock_${account}`;
export function installBackgroundLock(
  options: {
    account: () => string;
    eligible: () => boolean;
    lock: () => Promise<void>;
  },
  target: Document = document,
) {
  let hiddenAt: number | undefined;
  let hiddenAccount = "";
  let timer: ReturnType<typeof setTimeout> | undefined;
  let locking = false;
  const maybeLock = () => {
    if (
      locking ||
      hiddenAt === undefined ||
      Date.now() - hiddenAt < 300_000 ||
      hiddenAccount !== options.account() ||
      !options.eligible() ||
      deviceStorage.getItem(autoLockKey(hiddenAccount)) !== "1"
    )
      return;
    hiddenAt = undefined;
    locking = true;
    void options
      .lock()
      .catch(() => console.warn("[account] background lock failed"))
      .finally(() => {
        locking = false;
      });
  };
  const visibility = () => {
    clearTimeout(timer);
    if (target.visibilityState === "hidden") {
      hiddenAt = Date.now();
      hiddenAccount = options.account();
      timer = setTimeout(maybeLock, 300_000);
    } else {
      maybeLock();
      hiddenAt = undefined;
    }
  };
  target.addEventListener("visibilitychange", visibility);
  if (target.visibilityState === "hidden") visibility();
  return () => {
    clearTimeout(timer);
    target.removeEventListener("visibilitychange", visibility);
  };
}
