import { createApp, nextTick } from "vue";
import { createPinia } from "pinia";
import { createMemoryHistory, createRouter } from "vue-router";
import NearbyTransfer from "../../src/views/NearbyTransfer.vue";
import { nearbyState, resetNearby } from "../../src/services/nearbySession";
import { useUIStore } from "../../src/stores/ui";
import { useKeyStore } from "../../src/stores/keys";

/** Exercise real composer bindings, staged attachments and batch saving. */
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
  const click = (selector: string) => document.querySelector<HTMLButtonElement>(selector)!.click();
  try {
    const files = [new File(["photo"], "照片.jpg", { type: "image/jpeg" }), new File(["pdf"], "文档.pdf", { type: "application/pdf" })];
    nearbyState.pairKey = { roomId: "preview", password: "preview" };
    nearbyState.pairPeers = { peer: "Linux 电脑" };
    nearbyState.pairTextPeers = { peer: true };
    nearbyState.transfers.push({
      id: "fixture", kind: "pair", peerId: "peer", direction: "in", peerName: "Linux 电脑",
      files: files.map(file => ({ name: file.name, size: file.size, type: file.type })),
      progress: [1, 1], received: files, state: "done",
    });
    app.mount("#app");
    await nextTick();
    if (document.querySelector(".assistant-body .device-card, .assistant-body .diagnostics, .connection-status, .choose-files")) throw new Error("chat must not contain duplicate connection or file-picker controls");
    const save = document.querySelector<HTMLButtonElement>(".batch-save");
    const send = document.querySelector<HTMLButtonElement>('[aria-label="发送"]')!;
    const textarea = document.querySelector<HTMLTextAreaElement>('[aria-label="输入消息"]')!;
    if (!save || !textarea || !send.disabled) throw new Error("empty composer must render with sending disabled");
    save.click();
    await settle();
    if (shared.length !== 1 || shared[0].length !== 2) throw new Error("batch save must share original files together");
    const input = document.querySelector<HTMLInputElement>(".hidden-input")!;
    let pickerCalls = 0;
    input.click = () => { pickerCalls++; };
    const pickBatch = () => {
      const selection = new DataTransfer();
      files.forEach(file => selection.items.add(file));
      input.files = selection.files;
      input.dispatchEvent(new Event("change", { bubbles: true }));
    };
    const typeText = (text: string) => { textarea.value = text; textarea.dispatchEvent(new Event("input", { bubbles: true })); };
    click(".attachment-button");
    pickBatch();
    await nextTick();
    if (pickerCalls !== 1 || document.querySelector("#target-title") || send.disabled) throw new Error("attachments must be staged until send is clicked");
    send.click();
    await nextTick();
    if (!document.querySelector("#target-title")) throw new Error("send must open the device picker");
    const beforeFiles = ui.toasts.length;
    click(".target-device");
    await settle();
    // No transport room exists in this isolated fixture. A toast proves that
    // the real send path was invoked, without starting a network connection.
    if (document.querySelector("#target-title") || ui.toasts.length !== beforeFiles + 1) throw new Error("device click must submit staged files");
    click(".selected-batch button");
    await nextTick();
    typeText("第一行\n第二行");
    await nextTick();
    textarea.focus();
    await nextTick();
    if (getComputedStyle(textarea).fontSize !== "16px" || textarea.scrollWidth > textarea.clientWidth + 1) throw new Error("composer text must retain mobile sizing");
    send.click();
    await nextTick();
    if (!document.querySelector("#target-title") || document.querySelector(".target-device")?.hasAttribute("disabled")) throw new Error("text must be sendable to a text-capable device");
    const beforeText = ui.toasts.length;
    click(".target-device");
    await settle();
    if (ui.toasts.length !== beforeText + 1 || textarea.value !== "第一行\n第二行") throw new Error("failed text submission must restore the draft");
    nearbyState.pairTextPeers = {};
    send.click();
    await nextTick();
    if (!document.querySelector(".target-device")?.hasAttribute("disabled")) throw new Error("legacy peers must not silently drop text");
    nearbyState.pairTextPeers = { peer: true };
    click("#target-title ~ .link-button:last-child");
    await nextTick();
    click('[aria-label="设备与连接"]');
    await nextTick();
    click(".peer-send");
    await nextTick();
    if (!document.querySelector(".selected-target") || document.querySelector(".connection-sheet")) throw new Error("device selection must stage a recipient");
    const beforeSelected = ui.toasts.length;
    send.click();
    await settle();
    if (document.querySelector("#target-title") || ui.toasts.length !== beforeSelected + 1) throw new Error("explicit recipient must not be selected twice");
    click(".attachment-button");
    pickBatch();
    await nextTick();
    if (document.querySelector("#target-title")) throw new Error("adding files must not submit text automatically");
    click(".attachment-button");
    useKeyStore(pinia).pkHex = "fixture-account";
    await nextTick();
    pickBatch();
    await nextTick();
    if (textarea.value || document.querySelector(".selected-target, .selected-batch")) throw new Error("account switch must clear draft, attachments and recipient");
    nearbyState.transfers.unshift({ id: "text", kind: "pair", peerId: "peer", direction: "in", peerName: "Linux 电脑", text: "收到的文字\n换行", files: [], progress: [], received: [], state: "done" });
    await nextTick();
    const textBubble = document.querySelector(".transfer-row:last-child")!;
    if (!textBubble.textContent?.includes("收到的文字") || textBubble.querySelector(".batch-save, .batch-files")) throw new Error("text-only records must render as text without file actions");
    click(".transfer-row:last-child .clear-transfer");
    click(".clear-transfer");
    await nextTick();
    if (nearbyState.transfers.length) throw new Error("clear must release local records");
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
