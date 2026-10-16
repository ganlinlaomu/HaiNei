import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  persistentStorageState,
  requestPersistentStorage,
  resetPersistentStorageRequestForTests,
} from "@/services/persistentStorage";

function stubStorage(storage: Partial<StorageManager> | undefined) {
  vi.stubGlobal("navigator", storage ? { storage } : {});
}

beforeEach(() => resetPersistentStorageRequestForTests());
afterEach(() => vi.unstubAllGlobals());

describe("persistent storage", () => {
  it("does not prompt again when storage is already persisted", async () => {
    const persist = vi.fn(async () => true);
    stubStorage({ persisted: async () => true, persist });
    expect(await requestPersistentStorage()).toBe("persisted");
    expect(persist).not.toHaveBeenCalled();
  });

  it("asks once per session and reports a refusal as best effort", async () => {
    const persist = vi.fn(async () => false);
    stubStorage({ persisted: async () => false, persist });
    expect(await requestPersistentStorage()).toBe("best-effort");
    expect(await requestPersistentStorage()).toBe("best-effort");
    expect(persist).toHaveBeenCalledOnce();
  });

  it("retries on a later login if the request itself failed", async () => {
    const persist = vi.fn()
      .mockRejectedValueOnce(new Error("transient"))
      .mockResolvedValueOnce(true);
    stubStorage({ persisted: async () => false, persist });
    expect(await requestPersistentStorage()).toBe("best-effort");
    expect(await requestPersistentStorage()).toBe("persisted");
  });

  it("is a no-op where the Storage API is missing", async () => {
    stubStorage(undefined);
    expect(await requestPersistentStorage()).toBe("unsupported");
    expect(await persistentStorageState()).toBe("unsupported");
  });

  it("is requested after an unlocked login and shown on the debug page", () => {
    const app = readFileSync("src/App.vue", "utf8");
    const debug = readFileSync("src/views/Debug.vue", "utf8");
    expect(app).toMatch(/if \(isLoggedIn && isUnlocked\) \{[\s\S]*?void requestPersistentStorage\(\);/);
    expect(debug).toContain("persistentStorageLabel");
  });
});
