import { describe, expect, it } from "vitest";
import { isRemoteSignerConnectivityError } from "@/services/nip46RemoteSigner";

describe("NIP-46 connectivity error classification", () => {
  it("recognizes recoverable transport/session failures", () => {
    expect(isRemoteSignerConnectivityError(new Error("remote_signer_offline"))).toBe(true);
    expect(isRemoteSignerConnectivityError(new Error("remote_signer_timeout"))).toBe(true);
    expect(isRemoteSignerConnectivityError(new Error("remote_signer_session_changed"))).toBe(true);
    expect(isRemoteSignerConnectivityError(new Error("WebSocket connection closed"))).toBe(true);
    expect(isRemoteSignerConnectivityError(new Error("failed to connect to relay"))).toBe(true);
    expect(isRemoteSignerConnectivityError(new Error("Request timed out"))).toBe(true);
  });

  it("does not retry signer policy or validation failures", () => {
    expect(isRemoteSignerConnectivityError(new Error("user rejected request"))).toBe(false);
    expect(isRemoteSignerConnectivityError(new Error("remote_signer_invalid_event"))).toBe(false);
    expect(isRemoteSignerConnectivityError(new Error("permission denied"))).toBe(false);
  });
});
