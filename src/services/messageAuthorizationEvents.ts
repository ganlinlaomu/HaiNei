type MessageAuthorizationListener = (accountPubkey: string) => void | Promise<void>;

const listeners = new Set<MessageAuthorizationListener>();

export function onMessageAuthorizationChanged(listener: MessageAuthorizationListener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function notifyMessageAuthorizationChanged(accountPubkey: string) {
  const account = accountPubkey.trim().toLowerCase();
  if (!account) return;
  for (const listener of listeners) {
    try {
      void listener(account);
    } catch {
      // Authorization observers are best-effort and must not break friendship state.
    }
  }
}
