import { createApp, nextTick } from "vue";
import { createPinia } from "pinia";
import { createMemoryHistory, createRouter } from "vue-router";
import NearbyTransfer from "../../src/views/NearbyTransfer.vue";
import { nearbyState, resetNearby } from "../../src/services/nearbySession";

/** Exercise real Vue event bindings and the batch share call in browser CI. */
export async function validateTransferAssistant() {
  const router = createRouter({ history: createMemoryHistory(), routes: [{ path: "/nearby", component: NearbyTransfer }] });
  await router.push("/nearby");
  const shareDescriptor = Object.getOwnPropertyDescriptor(navigator, "share");
  const canShareDescriptor = Object.getOwnPropertyDescriptor(navigator, "canShare");
  const shared: File[][] = [];
  Object.defineProperty(navigator, "canShare", { configurable: true, value: () => true });
  Object.defineProperty(navigator, "share", { configurable: true, value: async ({ files }: { files: File[] }) => { shared.push(files); } });
  const app = createApp(NearbyTransfer).use(createPinia()).use(router);
  try {
    const files = [new File(["photo"], "照片.jpg", { type: "image/jpeg" }), new File(["pdf"], "文档.pdf", { type: "application/pdf" })];
    nearbyState.pairKey = { roomId: "preview", password: "preview" };
    nearbyState.pairPeers = { peer: "Linux 电脑" };
    nearbyState.transfers.push({
      id: "fixture", kind: "pair", peerId: "peer", direction: "in", peerName: "Linux 电脑",
      files: files.map(file => ({ name: file.name, size: file.size, type: file.type })),
      progress: [1, 1], received: files, state: "done",
    });
    app.mount("#app");
    await nextTick();
    const save = document.querySelector<HTMLButtonElement>(".batch-save");
    if (!save || !document.querySelector(".assistant-header")?.textContent?.includes("文件传输助手")) throw new Error("assistant batch did not render");
    save.click();
    await nextTick();
    if (shared.length !== 1 || shared[0].length !== 2 || shared[0][0].name !== "照片.jpg") throw new Error("batch save must share original files together");
    const input = document.querySelector<HTMLInputElement>(".hidden-input")!;
    const selected = new DataTransfer();
    files.forEach(file => selected.items.add(file));
    input.files = selected.files;
    input.dispatchEvent(new Event("change", { bubbles: true }));
    await nextTick();
    if (!document.querySelector("#target-title")?.textContent?.includes("发送到设备")) throw new Error("selection did not open device picker");
    if (!document.querySelector(".target-device")?.textContent?.includes("Linux 电脑")) throw new Error("online device missing from picker");
    document.querySelector<HTMLButtonElement>(".clear-transfer")!.click();
    await nextTick();
    if (nearbyState.transfers.length) throw new Error("removing received files did not release record");
  } finally {
    app.unmount();
    await resetNearby();
    for (const [name, descriptor] of [["share", shareDescriptor], ["canShare", canShareDescriptor]] as const) {
      if (descriptor) Object.defineProperty(navigator, name, descriptor);
      else delete (navigator as unknown as Record<string, unknown>)[name];
    }
  }
}
