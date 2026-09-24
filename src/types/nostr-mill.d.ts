declare module "nostr-mill" {
  interface MillResult {
    method: string;
    pubkey: string;
    signer?: unknown;
  }

  interface MillOptions {
    methods?: string[];
    pomegranate?: boolean | Record<string, unknown>;
    appName?: string;
    onConnected?: (result: MillResult) => void;
    onClose?: () => void;
  }

  const MILL: {
    open(options?: MillOptions): unknown;
    close(): void;
  };

  export default MILL;
}
