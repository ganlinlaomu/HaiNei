import { logger } from "@/utils/logger";

export function closeSubscription(subscription: any) {
  if (!subscription) return;
  try {
    if (typeof subscription.close === "function") subscription.close();
    else if (typeof subscription.unsub === "function") subscription.unsub();
    else if (typeof subscription.unsubscribe === "function") subscription.unsubscribe();
    else if (typeof subscription === "function") subscription();
  } catch (e) {
    logger.warn("close subscription failed", e);
  }
}
