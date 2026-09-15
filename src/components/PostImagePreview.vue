<template>
  <div class="post-image-preview" v-if="images.length > 0">
    <img
      v-if="!showAll"
      :src="images[0].url"
      :alt="altText"
      class="post-image-first"
      @error="onError(0)"
      @click="openViewer(0)"
      loading="lazy"
    />
    <div v-else class="gallery" :class="galleryClass">
      <div 
        v-for="(img, idx) in images" 
        :key="idx"
        class="gallery-item-wrapper"
        :ref="el => setItemRef(el, idx)"
      >
        <img
          v-if="img.shouldLoad"
          :src="img.url"
          :alt="altText"
          class="gallery-item"
          @error="onError(idx)"
          @click="openViewer(idx)"
          loading="lazy"
        />
        <div v-else class="gallery-item gallery-item-placeholder">
          <span class="loading-icon">⏳</span>
        </div>
      </div>
    </div>
    
    <!-- Image Viewer Modal -->
    <ImageViewer
      :visible="viewerVisible"
      :images="imageUrls"
      :initialIndex="viewerIndex"
      @close="closeViewer"
    />
  </div>
</template>

<script lang="ts">
import { defineComponent, computed, ref, onBeforeUnmount, watch, nextTick } from "vue";
import { extractImageUrls } from "@/utils/extractImageUrls";
import { decodeEncryptedImageRef, isEncryptedImageRef } from "@/utils/encryptedImageRef";
import { base64ToBytes } from "@/nostr/crypto";
import ImageViewer from "@/components/ImageViewer.vue";
import { getImageFromCache, storeImageInCache } from "@/utils/imageCache";
import { useKeyStore } from "@/stores/keys";

interface ImageItem {
  url: string;
  isEncrypted: boolean;
  shouldLoad: boolean; // 控制是否应该加载此图片
}

export default defineComponent({
  name: "PostImagePreview",
  components: { ImageViewer },
  props: {
    content: { type: String, required: true },
    max: { type: Number, default: 9 },
    showAll: { type: Boolean, default: false },
    altText: { type: String, default: "image" }
  },
  setup(props) {
    const keys = useKeyStore();
    const extractedUrls = computed(() => extractImageUrls(props.content || ""));
    const images = ref<ImageItem[]>([]);
    const objectUrls = new Set<string>();
    const itemRefs = ref<(HTMLElement | null)[]>([]);
    const itemIndexMap = new Map<HTMLElement, number>(); // 元素到索引的映射
    const observer = ref<IntersectionObserver | null>(null);
    
    // Image viewer state
    const viewerVisible = ref(false);
    const viewerIndex = ref(0);
    
    // Compute gallery class based on number of images for better browser compatibility
    const galleryClass = computed(() => {
      const count = images.value.length;
      if (count === 1) return 'gallery-single';
      if (count === 2) return 'gallery-two';
      if (count === 4) return 'gallery-four';
      return 'gallery-grid';
    });
    
    // Get array of image URLs for viewer (只返回已加载的图片)
    const imageUrls = computed(() => {
      const urls: string[] = [];
      for (const img of images.value) {
        if (img.shouldLoad && img.url !== "") {
          urls.push(img.url);
        }
      }
      return urls;
    });

    function setItemRef(el: any, idx: number) {
      if (el) {
        const element = el as HTMLElement;
        itemRefs.value[idx] = element;
        itemIndexMap.set(element, idx); // 建立映射
      }
    }

    function openViewer(index: number) {
      // 点击图片时，确保该图片已加载
      if (images.value[index] && !images.value[index].shouldLoad) {
        images.value[index].shouldLoad = true;
        // 等待图片加载后再打开查看器
        nextTick(() => {
          viewerIndex.value = index;
          viewerVisible.value = true;
        });
      } else {
        viewerIndex.value = index;
        viewerVisible.value = true;
      }
    }

    function closeViewer() {
      viewerVisible.value = false;
    }

    async function processImageUrl(url: string): Promise<ImageItem> {
      if (isEncryptedImageRef(url)) {
        // 延迟解密，先返回占位符
        return { url, isEncrypted: true, shouldLoad: false };
      } else {
        // Plain http(s) URL，也延迟加载
        return { url, isEncrypted: false, shouldLoad: false };
      }
    }
    
    async function decryptAndLoadImage(item: ImageItem, idx: number): Promise<void> {
      if (!item.isEncrypted || item.url === "" || item.shouldLoad) {
        // 非加密图片或已加载，直接标记为应该显示
        if (!item.shouldLoad) {
          images.value[idx].shouldLoad = true;
        }
        return;
      }
      
      // 解密加密图片
      const metadata = decodeEncryptedImageRef(item.url);
      if (!metadata) {
        console.error("Invalid encrypted image reference format:", item.url);
        images.value[idx].shouldLoad = true; // 标记为已尝试加载
        return;
      }

      const accountAtStart = keys.pkHex;
      if (!accountAtStart) return;

      try {
        // Try to get from cache first
        const cached = await getImageFromCache(accountAtStart, item.url);
        if (keys.pkHex !== accountAtStart) return;
        if (cached) {
          // Cache hit! Use cached blob
          const objectUrl = URL.createObjectURL(cached.blob);
          objectUrls.add(objectUrl);
          images.value[idx].url = objectUrl;
          images.value[idx].shouldLoad = true;
          return;
        }

        // Cache miss, fetch and decrypt
        const response = await fetch(metadata.url);
        if (keys.pkHex !== accountAtStart) return;
        if (!response.ok) {
          console.error("Failed to fetch encrypted image:", metadata.url, response.status);
          images.value[idx].shouldLoad = true;
          return;
        }
        
        const encryptedBytes = new Uint8Array(await response.arrayBuffer());
        
        // Import key and decrypt
        const keyBytes = base64ToBytes(metadata.key);
        const key = await crypto.subtle.importKey(
          "raw",
          keyBytes,
          "AES-GCM",
          false,
          ["decrypt"]
        );
        
        const ivBytes = base64ToBytes(metadata.iv);
        const decrypted = await crypto.subtle.decrypt(
          { name: "AES-GCM", iv: ivBytes },
          key,
          encryptedBytes
        );
        
        // Create blob and cache it
        const blob = new Blob([decrypted], { type: metadata.mime });
        if (keys.pkHex !== accountAtStart) return;
        
        // Store in cache asynchronously (don't wait)
        storeImageInCache(accountAtStart, item.url, blob, metadata.mime).catch(e => {
          console.warn("Failed to cache image:", e);
        });
        
        // Create object URL from decrypted blob
        const objectUrl = URL.createObjectURL(blob);
        objectUrls.add(objectUrl);
        
        // 更新图片 URL 并标记为应该加载
        images.value[idx].url = objectUrl;
        images.value[idx].shouldLoad = true;
      } catch (error) {
        console.error("Failed to decrypt image:", item.url, error);
        images.value[idx].shouldLoad = true; // 即使失败也标记为已尝试
      }
    }

    async function loadImages() {
      const urls = props.showAll 
        ? extractedUrls.value.slice(0, props.max)
        : extractedUrls.value.slice(0, 1);
      
      // Clear previous object URLs
      objectUrls.forEach(url => {
        try { 
          URL.revokeObjectURL(url); 
        } catch (error) {
          console.error("Failed to revoke object URL:", url, error);
        }
      });
      objectUrls.clear();
      itemRefs.value = [];
      itemIndexMap.clear();
      
      // Process all image URLs (创建占位符)
      const processed = await Promise.all(urls.map(processImageUrl));
      images.value = processed;
      
      // 如果只显示第一张图片（showAll=false），立即加载
      if (!props.showAll && images.value.length > 0) {
        await decryptAndLoadImage(images.value[0], 0);
      }
      
      // 设置 IntersectionObserver（仅在 showAll 模式下）
      if (props.showAll) {
        setupIntersectionObserver();
      }
    }
    
    function setupIntersectionObserver() {
      // 清理旧的 observer 和映射
      if (observer.value) {
        observer.value.disconnect();
      }
      itemIndexMap.clear();
      
      // 等待 DOM 更新后再设置 observer
      nextTick(() => {
        observer.value = new IntersectionObserver(
          (entries) => {
            entries.forEach((entry) => {
              if (entry.isIntersecting) {
                // 使用映射快速查找索引 O(1)
                const idx = itemIndexMap.get(entry.target as HTMLElement);
                if (idx !== undefined && !images.value[idx].shouldLoad) {
                  // 图片进入视口，开始加载
                  decryptAndLoadImage(images.value[idx], idx);
                  // 停止观察这个元素
                  observer.value?.unobserve(entry.target);
                  // 移除映射
                  itemIndexMap.delete(entry.target as HTMLElement);
                }
              }
            });
          },
          {
            root: null,
            rootMargin: '50px', // 提前 50px 开始加载
            threshold: 0.01
          }
        );
        
        // 观察所有图片容器
        itemRefs.value.forEach((ref) => {
          if (ref && observer.value) {
            observer.value.observe(ref);
          }
        });
      });
    }

    // Watch for changes in content or display mode
    watch([() => props.content, () => props.showAll, () => props.max], () => {
      loadImages();
    }, { immediate: true });

    const failed = ref<Record<number, boolean>>({});

    function onError(idx: number) {
      failed.value[idx] = true;
    }
    
    onBeforeUnmount(() => {
      // Clean up observer
      if (observer.value) {
        observer.value.disconnect();
        observer.value = null;
      }
      
      // Clean up index map
      itemIndexMap.clear();
      
      // Clean up object URLs
      objectUrls.forEach(url => {
        try { 
          URL.revokeObjectURL(url); 
        } catch (error) {
          console.error("Failed to revoke object URL on unmount:", url, error);
        }
      });
      objectUrls.clear();
    });

    return { 
      images, 
      onError, 
      failed, 
      galleryClass, 
      viewerVisible, 
      viewerIndex, 
      imageUrls, 
      openViewer, 
      closeViewer,
      setItemRef
    };
  }
});
</script>

<style scoped>
.post-image-first {
  max-width: 100%;
  height: auto;
  border-radius: 8px;
  display: block;
  margin: 8px 0;
  cursor: pointer;
  transition: opacity 0.2s ease;
}
.post-image-first:hover {
  opacity: 0.9;
}
.gallery {
  display: grid;
  gap: 4px;
  margin: 8px 0;
}
/* Default 3-column grid for 3+ images */
.gallery-grid {
  grid-template-columns: repeat(3, 1fr);
}
/* Single image - full width */
.gallery-single {
  grid-template-columns: 1fr;
}
.gallery-single .gallery-item {
  aspect-ratio: auto;
  max-height: 400px;
}
/* Two images - 2 columns */
.gallery-two {
  grid-template-columns: repeat(2, 1fr);
}
/* Four images - 2x2 grid */
.gallery-four {
  grid-template-columns: repeat(2, 1fr);
}
.gallery-item-wrapper {
  width: 100%;
  aspect-ratio: 1;
  position: relative;
}
.gallery-item {
  width: 100%;
  height: 100%;
  border-radius: 6px;
  object-fit: cover;
  background: #f1f5f9;
  cursor: pointer;
  transition: opacity 0.2s ease;
}
.gallery-item:hover {
  opacity: 0.9;
}
.gallery-item-placeholder {
  display: flex;
  align-items: center;
  justify-content: center;
  background: linear-gradient(135deg, #f1f5f9 0%, #e2e8f0 100%);
  cursor: default;
}
.loading-icon {
  font-size: 24px;
  animation: pulse 1.5s ease-in-out infinite;
}
@keyframes pulse {
  0%, 100% { opacity: 0.4; }
  50% { opacity: 1; }
}
@media (min-width: 720px) {
  .gallery { gap: 6px; }
}
</style>
