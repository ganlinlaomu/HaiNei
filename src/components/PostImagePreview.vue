<template>
  <div v-if="images.length" class="post-image-preview">
    <div class="carousel-shell" :style="carouselAspectStyle">
      <div
        ref="carousel"
        class="carousel"
        :aria-label="images.length > 1 ? `图片轮播，共 ${images.length} 张` : undefined"
        @scroll.passive="handleCarouselScroll"
      >
      <div
        v-for="(img, idx) in images"
        :key="img.sourceUrl"
        class="carousel-slide"
        role="group"
        :aria-label="`第 ${idx + 1} 张，共 ${images.length} 张`"
      >
        <img
          v-if="img.status === 'loaded'"
          :src="img.url"
          :alt="altText"
          class="carousel-image"
          loading="lazy"
          decoding="async"
          @error="markFailed(idx)"
          @click="handleImageTap(idx)"
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
      </div>
      </div>
      <span v-if="images.length > 1" class="carousel-counter">{{ activeIndex + 1 }}/{{ images.length }}</span>
      <button v-if="images.length > 1 && activeIndex > 0" class="carousel-nav previous" type="button" aria-label="上一张" @click="goToSlide(activeIndex - 1)">‹</button>
      <button v-if="images.length > 1 && activeIndex < images.length - 1" class="carousel-nav next" type="button" aria-label="下一张" @click="goToSlide(activeIndex + 1)">›</button>
      <span v-if="heartVisible" :key="heartAnimationKey" class="heart-burst" aria-hidden="true">♥</span>
    </div>

    <div v-if="images.length > 1" class="carousel-dots" aria-hidden="true">
      <span v-for="(_, idx) in images" :key="idx" :class="{ active: idx === activeIndex }"></span>
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
import { computed, defineComponent, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import ImageViewer from "@/components/ImageViewer.vue";
import { useKeyStore } from "@/stores/keys";
import { useSettingsStore } from "@/stores/settings";
import { base64ToBytes } from "@/nostr/crypto";
import { decodeEncryptedImageRef, isEncryptedImageRef, variantToEncryptedImageRef } from "@/utils/encryptedImageRef";
import { extractImageUrls } from "@/utils/extractImageUrls";
import { getImageFromCache, storeImageInCache } from "@/utils/imageCache";
import {
  adjacentSlideIndexes,
  carouselActiveIndex,
  isCarouselDoubleTap
} from "@/utils/feedCarousel";

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

const MAX_DECRYPT_CONCURRENCY = 3;
let activeDecrypts = 0;
type DecryptPriority = 0 | 1 | 2;
type DecryptJob = { priority: DecryptPriority; order: number; run: () => void };
const decryptQueue: DecryptJob[] = [];
let decryptOrder = 0;
const inFlightDecrypts = new Map<string, Promise<Blob>>();
const decryptControllers = new Map<string, AbortController>();

function drainDecryptQueue() {
  while (activeDecrypts < MAX_DECRYPT_CONCURRENCY && decryptQueue.length) {
    decryptQueue.sort((a, b) => a.priority - b.priority || a.order - b.order);
    decryptQueue.shift()?.run();
  }
}

function withDecryptSlot<T>(task: () => Promise<T>, priority: DecryptPriority): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    decryptQueue.push({
      priority,
      order: decryptOrder++,
      run: () => {
        activeDecrypts += 1;
        task().then(resolve, reject).finally(() => {
          activeDecrypts -= 1;
          drainDecryptQueue();
        });
      }
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

function getDecryptedBlob(account: string, encryptedRef: string, priority: DecryptPriority = 1): Promise<Blob> {
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
  }, priority).finally(() => {
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
  emits: ["doubleLike"],
  setup(props, { emit }) {
    const keys = useKeyStore();
    const settings = useSettingsStore();
    const images = ref<ImageItem[]>([]);
    const objectUrls = new Set<string>();
    const carousel = ref<HTMLElement | null>(null);
    const rootVisible = ref(false);
    let visibilityObserver: IntersectionObserver | null = null;
    const activeIndex = ref(0);
    const loadGeneration = ref(0);
    const itemLoadPromises = new WeakMap<ImageItem, Promise<void>>();
    const originalLoadPromises = new WeakMap<ImageItem, Promise<void>>();
    const viewerVisible = ref(false);
    const viewerIndex = ref(0);
    const viewerImageUrls = ref<string[]>([]);
    const viewerAnchorIndex = ref<number | null>(null);
    const heartVisible = ref(false);
    const heartAnimationKey = ref(0);
    const carouselAspectStyle = computed(() => {
      const item = images.value[0];
      return { aspectRatio: item?.width && item.height ? `${item.width} / ${item.height}` : "1 / 1" };
    });

    function revokeObjectUrls() {
      objectUrls.forEach(url => URL.revokeObjectURL(url));
      objectUrls.clear();
    }

    function loadImage(idx: number, priority: DecryptPriority = rootVisible.value ? 0 : 2): Promise<void> {
      const item = images.value[idx];
      if (!item || item.status === "loaded") return Promise.resolve();
      const existing = itemLoadPromises.get(item);
      if (existing) return existing;
      const task = performLoadImage(item, idx, priority).finally(() => itemLoadPromises.delete(item));
      itemLoadPromises.set(item, task);
      return task;
    }

    async function performLoadImage(item: ImageItem, idx: number, priority: DecryptPriority) {
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
        const blob = await getDecryptedBlob(accountAtStart, item.sourceUrl, priority);
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
        const blob = await getDecryptedBlob(accountAtStart, item.originalSourceUrl, 2);
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
      viewerImageUrls.value = images.value.map((item, itemIndex) =>
        itemIndex === index || item.originalStatus === "loaded" ? item.originalUrl : item.url
      );
      viewerIndex.value = index;
      viewerVisible.value = true;

      // Keep the clicked image stable at index 0 while the existing bounded
      // decrypt queue fills in the rest of the viewer in the background.
      images.value.forEach((_, itemIndex) => {
        if (itemIndex === index) return;
        const backgroundLoad = settings.dataSaver ? loadImage(itemIndex) : loadOriginal(itemIndex);
        void backgroundLoad.then(() => {
          if (!viewerVisible.value || viewerAnchorIndex.value !== index) return;
          viewerImageUrls.value = images.value.map((item, candidateIndex) =>
            candidateIndex === index || item.originalStatus === "loaded" ? item.originalUrl : item.url
          );
        });
      });
    }

    function closeViewer() {
      viewerVisible.value = false;
      viewerAnchorIndex.value = null;
    }

    function loadAround(index: number) {
      adjacentSlideIndexes(index, images.value.length).forEach(itemIndex => void loadImage(itemIndex, itemIndex === index ? 0 : 1));
    }

    let scrollFrame = 0;
    let lastScrolledAt = 0;
    function handleCarouselScroll() {
      lastScrolledAt = Date.now();
      if (scrollFrame) return;
      scrollFrame = requestAnimationFrame(() => {
        scrollFrame = 0;
        const element = carousel.value;
        if (!element?.clientWidth) return;
        activeIndex.value = carouselActiveIndex(element.scrollLeft, element.clientWidth, images.value.length);
      });
    }

    function goToSlide(index: number) {
      const next = Math.max(0, Math.min(images.value.length - 1, index));
      activeIndex.value = next;
      carousel.value?.scrollTo({ left: next * (carousel.value.clientWidth || 0), behavior: "smooth" });
    }

    let tapTimer: ReturnType<typeof setTimeout> | null = null;
    let lastTapAt = 0;
    let lastTapIndex = -1;
    let heartTimer: ReturnType<typeof setTimeout> | null = null;
    function handleImageTap(index: number) {
      if (Date.now() - lastScrolledAt < 120) return;
      const now = Date.now();
      if (isCarouselDoubleTap(lastTapAt, lastTapIndex, now, index)) {
        if (tapTimer) clearTimeout(tapTimer);
        tapTimer = null;
        lastTapAt = 0;
        heartAnimationKey.value += 1;
        heartVisible.value = true;
        if (heartTimer) clearTimeout(heartTimer);
        heartTimer = setTimeout(() => { heartVisible.value = false; }, 650);
        emit("doubleLike");
        return;
      }
      lastTapAt = now;
      lastTapIndex = index;
      if (tapTimer) clearTimeout(tapTimer);
      tapTimer = setTimeout(() => {
        tapTimer = null;
        void openViewer(index);
      }, 300);
    }

    function resetImages() {
      visibilityObserver?.disconnect();
      visibilityObserver = null;
      loadGeneration.value += 1;
      closeViewer();
      viewerImageUrls.value = [];
      revokeObjectUrls();
      activeIndex.value = 0;
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
      nextTick(() => {
        if (rootVisible.value) loadAround(0);
      });
    }

    watch([() => props.content, () => props.showAll], resetImages, { immediate: true });
    watch(() => keys.pkHex, (account, previousAccount) => {
      if (previousAccount && account !== previousAccount) cancelAccountDecrypts(previousAccount);
      resetImages();
    });
    watch(activeIndex, index => {
      if (rootVisible.value) loadAround(index);
    });

    onMounted(() => {
      const element = carousel.value?.closest(".post-image-preview");
      if (!element || typeof IntersectionObserver === "undefined") {
        rootVisible.value = true;
        loadAround(activeIndex.value);
        return;
      }
      visibilityObserver = new IntersectionObserver(entries => {
        const visible = entries.some(entry => entry.isIntersecting);
        rootVisible.value = visible;
        if (visible) loadAround(activeIndex.value);
      }, { rootMargin: "500px 0px" });
      visibilityObserver.observe(element);
    });

    onBeforeUnmount(() => {
      loadGeneration.value += 1;
      if (scrollFrame) cancelAnimationFrame(scrollFrame);
      if (tapTimer) clearTimeout(tapTimer);
      if (heartTimer) clearTimeout(heartTimer);
      revokeObjectUrls();
    });

    return {
      images,
      carousel,
      activeIndex,
      carouselAspectStyle,
      heartVisible,
      heartAnimationKey,
      viewerImageUrls,
      viewerVisible,
      viewerIndex,
      markFailed,
      retryImage,
      handleImageTap,
      handleCarouselScroll,
      goToSlide,
      closeViewer,
    };
  }
});
</script>

<style scoped>
.carousel-shell {
  position: relative;
  width: 100%;
  max-height: 550px;
  margin: 10px 0 0;
  overflow: hidden;
  border-radius: 12px;
  background: #eef2f6;
}
.carousel {
  width: 100%;
  height: 100%;
  display: flex;
  overflow-x: auto;
  overflow-y: hidden;
  scroll-snap-type: x mandatory;
  scrollbar-width: none;
  overscroll-behavior-inline: contain;
  -webkit-overflow-scrolling: touch;
}
.carousel::-webkit-scrollbar { display: none; }
.carousel-slide {
  flex: 0 0 100%;
  width: 100%;
  height: 100%;
  scroll-snap-align: start;
  scroll-snap-stop: always;
}
.carousel-image {
  display: block;
  width: 100%;
  height: 100%;
  object-fit: contain;
  cursor: pointer;
  background: #f3f5f7;
}
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
.carousel-counter {
  position: absolute;
  top: 10px;
  right: 10px;
  padding: 4px 8px;
  border-radius: 999px;
  background: rgba(15, 23, 42, 0.58);
  color: #fff;
  font-size: 11px;
}
.carousel-dots { display:flex;justify-content:center;gap:5px;min-height:16px;padding-top:7px; }
.carousel-dots span { width:6px;height:6px;border-radius:50%;background:#cbd5e1;transition:background 150ms ease,transform 150ms ease; }
.carousel-dots span.active { background:#2563eb;transform:scale(1.1); }
.carousel-nav { position:absolute;top:50%;width:32px;height:32px;margin-top:-16px;border:0;border-radius:50%;background:rgba(255,255,255,.88);color:#334155;font-size:24px;line-height:1;box-shadow:0 1px 5px rgba(15,23,42,.2);cursor:pointer; }
.carousel-nav.previous { left:8px; }.carousel-nav.next { right:8px; }
.heart-burst { position:absolute;left:50%;top:50%;color:#fff;font-size:72px;line-height:1;filter:drop-shadow(0 2px 8px rgba(0,0,0,.3));transform:translate(-50%,-50%);animation:heart-pop 650ms ease both;pointer-events:none; }
@keyframes heart-pop { 0%{opacity:0;transform:translate(-50%,-50%) scale(.35)} 35%{opacity:1;transform:translate(-50%,-50%) scale(1.12)} 100%{opacity:0;transform:translate(-50%,-50%) scale(1)} }
@media (hover:none) {
  .carousel-nav { display:none; }
}
@keyframes shimmer { to { background-position-x: -220%; } }
@media (prefers-reduced-motion: reduce) {
  .gallery-skeleton,.heart-burst { animation: none; }
}
</style>
