import { createApp, nextTick } from "vue";
import { createPinia } from "pinia";
import { createMemoryHistory, createRouter } from "vue-router";
import NearbyTransfer from "../../src/views/NearbyTransfer.vue";
import { nearbyState, resetNearby } from "../../src/services/nearbySession";
import { useUIStore } from "../../src/stores/ui";

/** Exercise real Vue event bindings and the batch share call in browser CI. */
export async function validateTransferAssistant() {
  const router = createRouter({ history: createMemoryHistory(), routes: [{ path: "/nearby", component: NearbyTransfer }] });
  await router.push("/nearby");
  const shareDescriptor = Object.getOwnPropertyDescriptor(navigator, "share");
  const canShareDescriptor = Object.getOwnPropertyDescriptor(navigator, "canShare");
  const shared: File[][] = [];
  Object.defineProperty(navigator, "canShare", { configurable: true, value: () => true });
  Object.defineProperty(navigator, "share", { configurable: true, value: async ({ files }: { files: File[] }) => { shared.push(files); } });
  const pinia = createPinia();
  const app = createApp(NearbyTransfer).use(pinia).use(router);
  const ui = useUIStore(pinia);
  const settle = async () => { await new Promise(resolve => setTimeout(resolve, 0)); await nextTick(); };
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
    if (document.querySelector(".assistant-body .device-card") || document.querySelector(".assistant-body .diagnostics")) throw new Error("connection controls must not fill the chat history");
    const save = document.querySelector<HTMLButtonElement>(".batch-save");
    if (!save || !document.querySelector(".assistant-header")?.textContent?.includes("文件传输助手")) throw new Error("assistant batch did not render");
    save.click();
    await nextTick();
    if (shared.length !== 1 || shared[0].length !== 2 || shared[0][0].name !== "照片.jpg") throw new Error("batch save must share original files together");
    const input = document.querySelector<HTMLInputElement>(".hidden-input")!;
    let pickerCalls = 0;
    input.click = () => { pickerCalls++; };
    const selected = new DataTransfer();
    files.forEach(file => selected.items.add(file));
    input.files = selected.files;
    input.dispatchEvent(new Event("change", { bubbles: true }));
    await nextTick();
    if (!document.querySelector("#target-title")?.textContent?.includes("发送到设备")) throw new Error("selection did not open device picker");
    if (!document.querySelector(".target-device")?.textContent?.includes("Linux 电脑")) throw new Error("online device missing from picker");
    // This isolated fixture has no transport room: the error toast proves the
    // send handler ran, without opening a real network connection in the test.
    const beforeFileFirst = ui.toasts.length;
    document.querySelector<HTMLButtonElement>(".target-device")!.click();
    await settle();
    if (document.querySelector("#target-title") || ui.toasts.length !== beforeFileFirst + 1) throw new Error("file-first selection must attempt sending on device click");
    document.querySelector<HTMLButtonElement>(".selected-batch button")!.click();
    await nextTick();

    document.querySelector<HTMLButtonElement>('[aria-label="设备与连接"]')!.click();
    await nextTick();
    document.querySelector<HTMLButtonElement>(".peer-send")!.click();
    await nextTick();
    if (pickerCalls !== 1 || document.querySelector(".connection-sheet")) throw new Error("device-first selection must open the file picker and close the device sheet");
    const beforeDeviceFirst = ui.toasts.length;
    input.files = selected.files;
    input.dispatchEvent(new Event("change", { bubbles: true }));
    await settle();
    if (document.querySelector("#target-title") || ui.toasts.length !== beforeDeviceFirst + 1) throw new Error("device-first file selection must send without asking for the device again");
    document.querySelector<HTMLButtonElement>(".selected-batch button")!.click();
    await nextTick();

    document.querySelector<HTMLButtonElement>('[aria-label="设备与连接"]')!.click();
    await nextTick();
    document.querySelector<HTMLButtonElement>(".peer-send")!.click();
    input.dispatchEvent(new Event("cancel"));
    document.querySelector<HTMLButtonElement>(".choose-files")!.click();
    input.files = selected.files;
    input.dispatchEvent(new Event("change", { bubbles: true }));
    await settle();
    if (!document.querySelector("#target-title")) throw new Error("cancelled picker must not reuse a previous target on the next file-first selection");
    document.querySelector<HTMLButtonElement>(".clear-transfer")!.click();
    await nextTick();
    if (nearbyState.transfers.length) throw new Error("removing received files did not release record");
  } finally {
    app.unmount();
    await resetNearby();
    for (const toast of [...ui.toasts]) ui.removeToast(toast.id);
    for (const [name, descriptor] of [["share", shareDescriptor], ["canShare", canShareDescriptor]] as const) {
      if (descriptor) Object.defineProperty(navigator, name, descriptor);
      else delete (navigator as unknown as Record<string, unknown>)[name];
    }
  }
}
