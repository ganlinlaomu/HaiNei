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
  let shareError: Error | undefined;
  Object.defineProperty(navigator, "canShare", { configurable: true, value: () => true });
  Object.defineProperty(navigator, "share", { configurable: true, value: async ({ files }: { files: File[] }) => { if (shareError) throw shareError; shared.push(files); } });
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
      localDeviceName: "iPhone", createdAt: Date.now(),
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
    if (!document.querySelector('.transfer-head')?.textContent?.includes('Linux 电脑 → iPhone') || !document.querySelector('.transfer-time')?.textContent?.includes('接收于')) throw new Error('records must identify both devices and reception time');
    if (save.textContent !== '保存') throw new Error('batch save must use a concise label');
    shareError = new DOMException('Canceled', 'AbortError');
    save.click();
    await settle();
    if (nearbyState.transfers[0].saveState || document.querySelector('.confirm-saved')) throw new Error('canceling the share sheet must not mark a file saved');
    shareError = new Error('Share failed');
    save.click();
    await settle();
    if (nearbyState.transfers[0].saveState) throw new Error('failed share must not mark a file saved');
    shareError = undefined;
    save.click();
    await settle();
    if (shared.length !== 1 || shared[0].length !== 2) throw new Error("batch save must share original files together");
    if (nearbyState.transfers[0].saveState !== 'system' || !document.querySelector('.save-hint')?.textContent?.includes('已交给系统')) throw new Error('share completion must report handoff rather than disk save');
    click('.confirm-saved');
    await nextTick();
    if (String(nearbyState.transfers[0].saveState) !== 'saved' || !document.querySelector('.save-hint')?.textContent?.includes('✓ 已保存') || document.querySelector('.confirm-saved')) throw new Error('save confirmation must remain visible as saved');
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
    if (!document.querySelector('.selected-target')?.textContent?.includes('Linux 电脑')) throw new Error('a single device must be selected automatically');
    click(".attachment-button");
    pickBatch();
    await nextTick();
    if (pickerCalls !== 1 || document.querySelector("#target-title") || send.disabled) throw new Error("attachments must be staged until send is clicked");
    const beforeFiles = ui.toasts.length;
    send.click();
    await settle();
    // No transport room exists in this isolated fixture. A toast proves that
    // the real send path was invoked, without starting a network connection.
    if (document.querySelector("#target-title") || ui.toasts.length !== beforeFiles + 1) throw new Error("send must submit directly to the selected device");
    click(".selected-batch button");
    await nextTick();
    typeText("第一行\n第二行");
    await nextTick();
    textarea.focus();
    await nextTick();
    if (getComputedStyle(textarea).fontSize !== "16px" || textarea.scrollWidth > textarea.clientWidth + 1) throw new Error("composer text must retain mobile sizing");
    const beforeText = ui.toasts.length;
    send.click();
    await settle();
    if (ui.toasts.length !== beforeText + 1 || textarea.value !== "第一行\n第二行") throw new Error("failed text submission must restore the draft");
    nearbyState.pairTextPeers = {};
    await nextTick();
    if (!send.disabled || !document.querySelector('.recipient-hint')) throw new Error('unsupported text must disable sending before submission');
    click('.selected-target');
    await nextTick();
    if (!document.querySelector(".target-device")?.hasAttribute("disabled")) throw new Error("legacy peers must not silently drop text");
    nearbyState.pairTextPeers = { peer: true };
    await nextTick();
    const beforeSelection = ui.toasts.length;
    click('.target-device');
    await nextTick();
    if (document.querySelector('#target-title') || ui.toasts.length !== beforeSelection || textarea.value !== '第一行\n第二行') throw new Error('selecting a device must preserve the draft without sending');
    nearbyState.pairPeers = { peer: 'Linux 电脑', second: 'iPad' };
    nearbyState.pairTextPeers = { peer: true, second: true };
    await nextTick();
    if (!document.querySelector('.selected-target')?.textContent?.includes('Linux 电脑')) throw new Error('new peers must not change the recipient');
    nearbyState.pairPeers = { second: 'iPad' };
    await nextTick();
    if (!send.disabled || !document.querySelector('.selected-target')?.textContent?.includes('已断开')) throw new Error('disconnect must not silently redirect to another device');
    click('.selected-target');
    await nextTick();
    click('.target-device');
    await nextTick();
    if (!document.querySelector('.selected-target')?.textContent?.includes('iPad') || send.disabled) throw new Error('recipient switching must occur before send');
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
    if (textarea.value || document.querySelector(".selected-batch") || document.querySelector('.selected-target')?.textContent?.includes('iPad')) throw new Error("account switch must clear draft, attachments and recipient");
    nearbyState.pairPeers = {};
    await nextTick();
    typeText('offline draft');
    await nextTick();
    if (!send.disabled || !document.querySelector('.selected-target')?.textContent?.includes('连接设备')) throw new Error('no devices must show connection action and disable sending');
    click('.selected-target');
    await nextTick();
    if (!document.querySelector('.connection-sheet')) throw new Error('connection action must open device connections');
    click('[aria-label="关闭设备与连接"]');
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
