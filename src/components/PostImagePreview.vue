<template>
  <div v-if="images.length" class="post-image-preview">
    <div v-if="showAll" class="gallery" :class="galleryClass">
      <div
        v-for="(img, idx) in visibleImages"
        :key="img.sourceUrl"
        :ref="el => setItemRef(el, idx)"
        class="gallery-item-wrapper"
        :style="itemAspectStyle(img)"
      >
        <img
          v-if="img.status === 'loaded'"
          :src="img.url"
          :alt="altText"
          class="gallery-item"
          loading="lazy"
          decoding="async"
          @error="markFailed(idx)"
          @click="openViewer(idx)"
        />
        <button
          v-else-if="img.status === 'error'"
          class="gallery-state gallery-error"
          type="button"
          @click="retryImage(idx)"
        >
          <span>图片加载失败</span>
          <span class="retry-label">点击重试</span>
        </button>
        <div v-else class="gallery-state gallery-skeleton" aria-label="图片加载中"></div>
        <button
          v-if="idx === visibleImages.length - 1 && hiddenCount > 0"
          class="more-overlay"
          type="button"
          :aria-label="`查看其余 ${hiddenCount} 张图片`"
          @click="openViewer(idx)"
        >
          +{{ hiddenCount }}
        </button>
      </div>
    </div>

    <div v-else class="single-preview" :ref="el => setItemRef(el, 0)" :style="itemAspectStyle(images[0])">
      <img
        v-if="images[0].status === 'loaded'"
        :src="images[0].url"
        :alt="altText"
        class="post-image-first"
        loading="lazy"
        decoding="async"
        @error="markFailed(0)"
        @click="openViewer(0)"
      />
      <button v-else-if="images[0].status === 'error'" class="gallery-state gallery-error" type="button" @click="retryImage(0)">
        <span>图片加载失败</span>
        <span class="retry-label">点击重试</span>
      </button>
      <div v-else class="gallery-state gallery-skeleton" aria-label="图片加载中"></div>
    </div>

    <ImageViewer
      :visible="viewerVisible"
      :images="viewerImageUrls"
      :initialIndex="viewerIndex"
      @close="closeViewer"
    />
  </div>
</template>

<script lang="ts">
import { computed, defineComponent, nextTick, onBeforeUnmount, ref, watch } from "vue";
import ImageViewer from "@/components/ImageViewer.vue";
import { useKeyStore } from "@/stores/keys";
import { useSettingsStore } from "@/stores/settings";
import { base64ToBytes } from "@/nostr/crypto";
import { decodeEncryptedImageRef, isEncryptedImageRef, variantToEncryptedImageRef } from "@/utils/encryptedImageRef";
import { extractImageUrls } from "@/utils/extractImageUrls";
import { getImageFromCache, storeImageInCache } from "@/utils/imageCache";

type LoadStatus = "idle" | "loading" | "loaded" | "error";

interface ImageItem {
  sourceUrl: string;
  url: string;
  isEncrypted: boolean;
  status: LoadStatus;
  originalSourceUrl: string;
  originalUrl: string;
  originalStatus: LoadStatus;
  width?: number;
  height?: number;
}

const MAX_VISIBLE_TILES = 4;
const MAX_DECRYPT_CONCURRENCY = 3;
let activeDecrypts = 0;
const decryptQueue: Array<() => void> = [];
const inFlightDecrypts = new Map<string, Promise<Blob>>();
const decryptControllers = new Map<string, AbortController>();

function drainDecryptQueue() {
  while (activeDecrypts < MAX_DECRYPT_CONCURRENCY && decryptQueue.length) decryptQueue.shift()?.();
}

function withDecryptSlot<T>(task: () => Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    decryptQueue.push(() => {
      activeDecrypts += 1;
      task().then(resolve, reject).finally(() => {
        activeDecrypts -= 1;
        drainDecryptQueue();
      });
    });
    drainDecryptQueue();
  });
}

function cancelAccountDecrypts(account: string) {
  if (!account) return;
  for (const [key, controller] of decryptControllers) {
    if (key.startsWith(`${account}:`)) controller.abort();
  }
}

function getDecryptedBlob(account: string, encryptedRef: string): Promise<Blob> {
  const taskKey = `${account}:${encryptedRef}`;
  const existing = inFlightDecrypts.get(taskKey);
  if (existing) return existing;

  const controller = new AbortController();
  decryptControllers.set(taskKey, controller);
  const task = withDecryptSlot(async () => {
    if (controller.signal.aborted) throw new DOMException("Aborted", "AbortError");
    const cached = await getImageFromCache(account, encryptedRef);
    if (cached) return cached.blob;

    const metadata = decodeEncryptedImageRef(encryptedRef);
    if (!metadata) throw new Error("Invalid encrypted image reference");
    const response = await fetch(metadata.url, { signal: controller.signal });
    if (!response.ok) throw new Error(`Encrypted image request failed (${response.status})`);
    const encryptedBytes = new Uint8Array(await response.arrayBuffer());
    const key = await crypto.subtle.importKey("raw", base64ToBytes(metadata.key), "AES-GCM", false, ["decrypt"]);
    const decrypted = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: base64ToBytes(metadata.iv) },
      key,
      encryptedBytes
    );
    if (controller.signal.aborted) throw new DOMException("Aborted", "AbortError");
    const blob = new Blob([decrypted], { type: metadata.mime });
    await storeImageInCache(account, encryptedRef, blob, metadata.mime);
    return blob;
  }).finally(() => {
    inFlightDecrypts.delete(taskKey);
    decryptControllers.delete(taskKey);
  });

  inFlightDecrypts.set(taskKey, task);
  return task;
}

export default defineComponent({
  name: "PostImagePreview",
  components: { ImageViewer },
  props: {
    content: { type: String, required: true },
    max: { type: Number, default: 9 },
    showAll: { type: Boolean, default: false },
    altText: { type: String, default: "动态图片" }
  },
  setup(props) {
    const keys = useKeyStore();
    const settings = useSettingsStore();
    const images = ref<ImageItem[]>([]);
    const objectUrls = new Set<string>();
    const itemRefs = ref<(HTMLElement | null)[]>([]);
    const itemIndexMap = new Map<HTMLElement, number>();
    const observer = ref<IntersectionObserver | null>(null);
    const loadGeneration = ref(0);
    const itemLoadPromises = new WeakMap<ImageItem, Promise<void>>();
    const originalLoadPromises = new WeakMap<ImageItem, Promise<void>>();
    const viewerVisible = ref(false);
    const viewerIndex = ref(0);
    const viewerImageUrls = ref<string[]>([]);
    const viewerAnchorIndex = ref<number | null>(null);

    const visibleImages = computed(() => images.value.slice(0, MAX_VISIBLE_TILES));
    const hiddenCount = computed(() => Math.max(0, images.value.length - MAX_VISIBLE_TILES));
    const galleryClass = computed(() => {
      const count = visibleImages.value.length;
      return `gallery-${count === 1 ? "single" : count === 2 ? "two" : count === 3 ? "three" : "four"}`;
    });

    function revokeObjectUrls() {
      objectUrls.forEach(url => URL.revokeObjectURL(url));
      objectUrls.clear();
    }

    function setItemRef(el: unknown, idx: number) {
      if (!(el instanceof HTMLElement)) return;
      itemRefs.value[idx] = el;
      itemIndexMap.set(el, idx);
    }

    function loadImage(idx: number): Promise<void> {
      const item = images.value[idx];
      if (!item || item.status === "loaded") return Promise.resolve();
      const existing = itemLoadPromises.get(item);
      if (existing) return existing;
      const task = performLoadImage(item, idx).finally(() => itemLoadPromises.delete(item));
      itemLoadPromises.set(item, task);
      return task;
    }

    async function performLoadImage(item: ImageItem, idx: number) {
      const generation = loadGeneration.value;
      item.status = "loading";

      if (!item.isEncrypted) {
        if (generation === loadGeneration.value) item.status = "loaded";
        return;
      }

      const accountAtStart = keys.pkHex;
      if (!accountAtStart) {
        item.status = "error";
        return;
      }
      try {
        const blob = await getDecryptedBlob(accountAtStart, item.sourceUrl);
        if (generation !== loadGeneration.value || keys.pkHex !== accountAtStart || images.value[idx] !== item) return;
        const objectUrl = URL.createObjectURL(blob);
        objectUrls.add(objectUrl);
        item.url = objectUrl;
        item.status = "loaded";
      } catch (error) {
        if (generation !== loadGeneration.value || keys.pkHex !== accountAtStart || images.value[idx] !== item) return;
        if (!(error instanceof DOMException && error.name === "AbortError")) console.warn("Failed to load encrypted image", error);
        item.status = "error";
      }
    }

    function loadOriginal(idx: number): Promise<void> {
      const item = images.value[idx];
      if (!item || item.originalStatus === "loaded") return Promise.resolve();
      const existing = originalLoadPromises.get(item);
      if (existing) return existing;
      const task = performLoadOriginal(item, idx).finally(() => originalLoadPromises.delete(item));
      originalLoadPromises.set(item, task);
      return task;
    }

    async function performLoadOriginal(item: ImageItem, idx: number) {
      if (item.originalSourceUrl === item.sourceUrl) {
        await loadImage(idx);
        if (item.status === "loaded") {
          item.originalUrl = item.url;
          item.originalStatus = "loaded";
        }
        return;
      }
      const generation = loadGeneration.value;
      const accountAtStart = keys.pkHex;
      if (!accountAtStart) { item.originalStatus = "error"; return; }
      item.originalStatus = "loading";
      try {
        const blob = await getDecryptedBlob(accountAtStart, item.originalSourceUrl);
        if (generation !== loadGeneration.value || keys.pkHex !== accountAtStart || images.value[idx] !== item) return;
        const objectUrl = URL.createObjectURL(blob);
        objectUrls.add(objectUrl);
        item.originalUrl = objectUrl;
        item.originalStatus = "loaded";
      } catch (error) {
        if (generation !== loadGeneration.value || keys.pkHex !== accountAtStart || images.value[idx] !== item) return;
        if (!(error instanceof DOMException && error.name === "AbortError")) console.warn("Failed to load original image", error);
        item.originalStatus = "error";
      }
    }

    function markFailed(idx: number) {
      if (images.value[idx]) images.value[idx].status = "error";
    }

    function retryImage(idx: number) {
      const item = images.value[idx];
      if (!item) return;
      item.status = "idle";
      item.url = item.sourceUrl;
      void loadImage(idx);
    }

    async function openViewer(index: number) {
      await loadOriginal(index);
      if (images.value[index]?.originalStatus !== "loaded") return;

      viewerAnchorIndex.value = index;
      viewerImageUrls.value = [
        images.value[index].originalUrl,
        ...images.value
          .filter((item, itemIndex) => itemIndex !== index && item.status === "loaded")
          .map(item => item.url)
      ];
      viewerIndex.value = 0;
      viewerVisible.value = true;

      // Keep the clicked image stable at index 0 while the existing bounded
      // decrypt queue fills in the rest of the viewer in the background.
      images.value.forEach((_, itemIndex) => {
        if (itemIndex === index) return;
        const backgroundLoad = settings.dataSaver ? loadImage(itemIndex) : loadOriginal(itemIndex);
        void backgroundLoad.then(() => {
          if (!viewerVisible.value || viewerAnchorIndex.value !== index) return;
          viewerImageUrls.value = [
            images.value[index].originalUrl,
            ...images.value
              .filter((item, candidateIndex) => candidateIndex !== index &&
                (settings.dataSaver ? item.status === "loaded" : item.originalStatus === "loaded"))
              .map(item => settings.dataSaver ? item.url : item.originalUrl)
          ];
        });
      });
    }

    function closeViewer() {
      viewerVisible.value = false;
      viewerAnchorIndex.value = null;
    }

    function setupObserver() {
      observer.value?.disconnect();
      itemIndexMap.clear();
      nextTick(() => {
        if (typeof IntersectionObserver === "undefined") {
          visibleImages.value.forEach((_, idx) => void loadImage(idx));
          return;
        }
        observer.value = new IntersectionObserver(entries => {
          entries.forEach(entry => {
            if (!entry.isIntersecting) return;
            const idx = itemIndexMap.get(entry.target as HTMLElement);
            if (idx === undefined) return;
            void loadImage(idx);
            observer.value?.unobserve(entry.target);
            itemIndexMap.delete(entry.target as HTMLElement);
          });
        }, { root: null, rootMargin: settings.dataSaver ? "60px" : "200px", threshold: 0.01 });
        itemRefs.value.forEach(element => element && observer.value?.observe(element));
      });
    }

    function resetImages() {
      loadGeneration.value += 1;
      observer.value?.disconnect();
      closeViewer();
      viewerImageUrls.value = [];
      revokeObjectUrls();
      itemRefs.value = [];
      itemIndexMap.clear();
      const urls = extractImageUrls(props.content || "");
      const selected = props.showAll ? urls : urls.slice(0, 1);
      images.value = selected.map(originalSourceUrl => {
        const metadata = isEncryptedImageRef(originalSourceUrl)
          ? decodeEncryptedImageRef(originalSourceUrl)
          : null;
        const sourceUrl = metadata?.preview
          ? variantToEncryptedImageRef(metadata.preview)
          : originalSourceUrl;
        return {
          sourceUrl,
          url: sourceUrl,
          isEncrypted: isEncryptedImageRef(sourceUrl),
          status: "idle" as LoadStatus,
          originalSourceUrl,
          originalUrl: originalSourceUrl,
          originalStatus: "idle" as LoadStatus,
          width: metadata?.preview?.width || metadata?.width,
          height: metadata?.preview?.height || metadata?.height,
        };
      });
      setupObserver();
    }

    function itemAspectStyle(item?: ImageItem) {
      if (images.value.length > 1 || !item?.width || !item.height) return undefined;
      return { aspectRatio: `${item.width} / ${item.height}` };
    }

    watch([() => props.content, () => props.showAll], resetImages, { immediate: true });
    watch(() => keys.pkHex, (account, previousAccount) => {
      if (previousAccount && account !== previousAccount) cancelAccountDecrypts(previousAccount);
      resetImages();
    });
    watch(() => settings.dataSaver, setupObserver);

    onBeforeUnmount(() => {
      loadGeneration.value += 1;
      observer.value?.disconnect();
      itemIndexMap.clear();
      revokeObjectUrls();
    });

    return {
      images,
      visibleImages,
      hiddenCount,
      galleryClass,
      viewerImageUrls,
      viewerVisible,
      viewerIndex,
      setItemRef,
      markFailed,
      retryImage,
      openViewer,
      closeViewer,
      itemAspectStyle
    };
  }
});
</script>

<style scoped>
.gallery {
  display: grid;
  gap: 4px;
  margin: 10px 0;
  overflow: hidden;
  border-radius: 12px;
}
.gallery-two,
.gallery-four { grid-template-columns: repeat(2, minmax(0, 1fr)); }
.gallery-three {
  grid-template-columns: 2fr 1fr;
  grid-template-rows: repeat(2, minmax(0, 150px));
}
.gallery-three .gallery-item-wrapper:first-child { grid-row: 1 / 3; }
.gallery-item-wrapper {
  position: relative;
  min-width: 0;
  aspect-ratio: 1;
  overflow: hidden;
  background: #eef2f6;
}
.gallery-single .gallery-item-wrapper {
  aspect-ratio: auto;
  max-height: 550px;
  background: #f3f5f7;
}
.gallery-item,
.post-image-first {
  display: block;
  width: 100%;
  cursor: pointer;
  background: #f3f5f7;
}
.gallery-item { height: 100%; object-fit: cover; }
.gallery-single .gallery-item,
.post-image-first {
  height: auto;
  max-height: 550px;
  object-fit: contain;
}
.single-preview { margin: 10px 0; }
.post-image-first { border-radius: 12px; }
.gallery-state {
  width: 100%;
  height: 100%;
  min-height: 140px;
  border: 0;
  border-radius: inherit;
}
.gallery-skeleton {
  background: linear-gradient(100deg, #edf1f5 25%, #f7f9fb 40%, #edf1f5 55%);
  background-size: 220% 100%;
  animation: shimmer 1.4s ease-in-out infinite;
}
.gallery-error {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 4px;
  color: #64748b;
  background: #f1f5f9;
  font: inherit;
  font-size: 13px;
  cursor: pointer;
}
.retry-label { color: #2563eb; font-size: 12px; }
.more-overlay {
  position: absolute;
  inset: 0;
  border: 0;
  background: rgba(15, 23, 42, 0.58);
  color: #fff;
  font-size: 28px;
  font-weight: 650;
  cursor: pointer;
}
@keyframes shimmer { to { background-position-x: -220%; } }
@media (min-width: 720px) {
  .gallery { gap: 6px; }
  .gallery-three { grid-template-rows: repeat(2, minmax(0, 190px)); }
}
@media (prefers-reduced-motion: reduce) {
  .gallery-skeleton { animation: none; }
}
</style>
