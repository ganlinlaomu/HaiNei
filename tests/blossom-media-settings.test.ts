import { afterEach, expect, it, vi } from "vitest";
import { getBlossomConfig } from "@/utils/blossom";
import { mediaServerId } from "@/services/connectionSettings";

afterEach(() => vi.unstubAllGlobals());

it("keeps the configured identity for health reporting while deriving the upload endpoint", async () => {
  const url = "https://media.example";
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => key === "blossom_servers" ? JSON.stringify([
      { id: "legacy-a", url, updatedAt: 10, token: "saved-token" },
      { id: "legacy-b", url: `${url}/`, updatedAt: 20 }
    ]) : null
  });
  const config = await getBlossomConfig();
  expect(config.url).toBe(`${url}/upload`);
  expect(config.servers).toHaveLength(1);
  expect(config.servers[0]).toMatchObject({ id: mediaServerId("blossom", url), url, token: "saved-token" });
});

it("merges tombstones before filtering the actual upload candidates", async () => {
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => key === "blossom_servers" ? JSON.stringify([
      { id: "legacy-a", url: "https://media.example", updatedAt: 10 },
      { id: "legacy-b", url: "https://media.example", updatedAt: 20, deleted: true }
    ]) : null
  });
  const config = await getBlossomConfig();
  expect(config.servers).toEqual([]);
  expect(config.url).toBeNull();
});
