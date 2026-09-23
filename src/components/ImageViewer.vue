<template>
  <transition name="fade">
    <div
      v-if="visible"
      class="image-viewer-overlay"
      @click="onOverlayClick"
      @keydown.esc="close"
      @keydown.left="previousImage"
      @keydown.right="nextImage"
      tabindex="0"
      ref="overlay"
    >
      <!-- Close button -->
      <button class="close-btn" @click="close" aria-label="关闭">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <line x1="18" y1="6" x2="6" y2="18"></line>
          <line x1="6" y1="6" x2="18" y2="18"></line>
        </svg>
      </button>

      <!-- Image counter -->
      <div v-if="images.length > 1" class="image-counter">
        {{ currentIndex + 1 }} / {{ images.length }}
      </div>

      <!-- Main image container -->
      <div
        class="image-container"
        @click.stop
        @touchstart.stop="handleTouchStart"
        @touchmove.stop.prevent="handleTouchMove"
        @touchend.stop="handleTouchEnd"
        @pointerdown="handlePointerDown"
        @pointermove="handlePointerMove"
        @pointerup="handlePointerUp"
        @pointercancel="handlePointerUp"
      >
        <img
          v-if="currentImage"
          :src="currentImage"
          :alt="`图片 ${currentIndex + 1}`"
          class="viewer-image"
          :style="imageStyle"
          @dblclick.stop="toggleZoom"
          @load="onImageLoad"
          @error="onImageError"
        />
        <div v-if="loading" class="loading-spinner">加载中...</div>
        <div v-if="error" class="error-message">图片加载失败</div>
      </div>

      <!-- Navigation arrows (only show if multiple images) -->
      <template v-if="images.length > 1">
        <button
          class="nav-btn nav-btn-prev"
          @click.stop="previousImage"
          :disabled="currentIndex === 0"
          aria-label="上一张"
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <polyline points="15 18 9 12 15 6"></polyline>
          </svg>
        </button>
        <button
          class="nav-btn nav-btn-next"
          @click.stop="nextImage"
          :disabled="currentIndex === images.length - 1"
          aria-label="下一张"
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <polyline points="9 18 15 12 9 6"></polyline>
          </svg>
        </button>
      </template>

      <!-- Thumbnail strip (for multiple images) -->
      <div v-if="images.length > 1" class="thumbnail-strip">
        <div
          v-for="(img, idx) in images"
          :key="idx"
          class="thumbnail"
          :class="{ active: idx === currentIndex }"
          @click.stop="goToImage(idx)"
        >
          <img :src="img" :alt="`缩略图 ${idx + 1}`" />
        </div>
      </div>
    </div>
  </transition>
</template>

<script lang="ts">
import { defineComponent, ref, computed, watch, nextTick, onBeforeUnmount, getCurrentInstance } from "vue";
import {
  clampViewerScale,
  resetViewerTransform,
  shouldCloseViewer,
  swipeImageDirection
} from "@/utils/imageViewerGestures";
import { useUIStore } from "@/stores/ui";

export default defineComponent({
  name: "ImageViewer",
  props: {
    visible: {
      type: Boolean,
      required: true
    },
    images: {
      type: Array as () => string[],
      required: true
    },
    initialIndex: {
      type: Number,
      default: 0
    }
  },
  emits: ["close"],
  setup(props, { emit }) {
    const ui = useUIStore();
    const overlayId = `image-viewer-${getCurrentInstance()?.uid}`;
    const currentIndex = ref(0);
    const scale = ref(1);
    const translateX = ref(0);
    const translateY = ref(0);
    const zoomed = computed(() => scale.value > 1);
    const loading = ref(true);
    const error = ref(false);
    const overlay = ref<HTMLElement | null>(null);

    const currentImage = computed(() => props.images[currentIndex.value] || null);

    const imageStyle = computed(() => {
      return {
        cursor: zoomed.value ? "grab" : "zoom-in",
        transform: `translate3d(${translateX.value}px, ${translateY.value}px, 0) scale(${scale.value})`
      };
    });

    function resetTransform() {
      const reset = resetViewerTransform();
      scale.value = reset.scale;
      translateX.value = reset.x;
      translateY.value = reset.y;
    }

    function close() {
      emit("close");
      resetTransform();
    }

    function onOverlayClick(e: MouseEvent) {
      // Close when clicking on overlay (not on image)
      if (e.target === e.currentTarget) {
        close();
      }
    }

    function previousImage() {
      if (currentIndex.value > 0) {
        currentIndex.value--;
        resetTransform();
        loading.value = true;
        error.value = false;
      }
    }

    function nextImage() {
      if (currentIndex.value < props.images.length - 1) {
        currentIndex.value++;
        resetTransform();
        loading.value = true;
        error.value = false;
      }
    }

    function goToImage(index: number) {
      currentIndex.value = index;
      resetTransform();
      loading.value = true;
      error.value = false;
    }

    function toggleZoom() {
      if (zoomed.value) resetTransform();
      else scale.value = 2;
    }

    function onImageLoad() {
      loading.value = false;
      error.value = false;
    }

    function onImageError() {
      loading.value = false;
      error.value = true;
    }

    let touchStartX = 0;
    let touchStartY = 0;
    let startTranslateX = 0;
    let startTranslateY = 0;
    let pinchDistance = 0;
    let pinchScale = 1;
    let lastTapAt = 0;

    function distance(touches: TouchList) {
      return Math.hypot(touches[0].clientX - touches[1].clientX, touches[0].clientY - touches[1].clientY);
    }

    function handleTouchStart(e: TouchEvent) {
      if (e.touches.length === 2) {
        pinchDistance = distance(e.touches);
        pinchScale = scale.value;
        return;
      }
      touchStartX = e.touches[0].clientX;
      touchStartY = e.touches[0].clientY;
      startTranslateX = translateX.value;
      startTranslateY = translateY.value;
    }

    function handleTouchMove(e: TouchEvent) {
      if (e.touches.length === 2 && pinchDistance) {
        scale.value = clampViewerScale(pinchScale * distance(e.touches) / pinchDistance);
        if (scale.value === 1) resetTransform();
        return;
      }
      if (e.touches.length === 1 && zoomed.value) {
        translateX.value = startTranslateX + e.touches[0].clientX - touchStartX;
        translateY.value = startTranslateY + e.touches[0].clientY - touchStartY;
      }
    }

    function handleTouchEnd(e: TouchEvent) {
      if (e.touches.length > 0) return;
      pinchDistance = 0;
      const touchEndX = e.changedTouches[0].clientX;
      const touchEndY = e.changedTouches[0].clientY;
      const deltaX = touchEndX - touchStartX;
      const deltaY = touchEndY - touchStartY;
      const now = Date.now();
      if (Math.abs(deltaX) < 12 && Math.abs(deltaY) < 12 && now - lastTapAt < 300) {
        toggleZoom();
        lastTapAt = 0;
        return;
      }
      if (Math.abs(deltaX) < 12 && Math.abs(deltaY) < 12) lastTapAt = now;
      if (shouldCloseViewer(scale.value, deltaX, deltaY)) return close();
      const direction = swipeImageDirection(scale.value, deltaX, deltaY);
      if (direction < 0) previousImage();
      if (direction > 0) nextImage();
    }

    let activePointer: number | null = null;
    function handlePointerDown(e: PointerEvent) {
      if (e.pointerType === "touch" || !zoomed.value) return;
      activePointer = e.pointerId;
      touchStartX = e.clientX;
      touchStartY = e.clientY;
      startTranslateX = translateX.value;
      startTranslateY = translateY.value;
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    }
    function handlePointerMove(e: PointerEvent) {
      if (activePointer !== e.pointerId || !zoomed.value) return;
      translateX.value = startTranslateX + e.clientX - touchStartX;
      translateY.value = startTranslateY + e.clientY - touchStartY;
    }
    function handlePointerUp(e: PointerEvent) {
      if (activePointer === e.pointerId) activePointer = null;
    }

    // Watch for visibility changes
    watch(() => props.visible, async (newVal) => {
      ui.setBlockingOverlay(overlayId, newVal);
      if (newVal) {
        currentIndex.value = props.initialIndex;
        resetTransform();
        loading.value = true;
        error.value = false;
        
        await nextTick();
        
        // Focus overlay for keyboard events
        if (overlay.value) {
          overlay.value.focus();
        }

      }
    }, { immediate: true });

    onBeforeUnmount(() => ui.setBlockingOverlay(overlayId, false));

    return {
      currentIndex,
      currentImage,
      zoomed,
      loading,
      error,
      overlay,
      imageStyle,
      close,
      onOverlayClick,
      previousImage,
      nextImage,
      goToImage,
      toggleZoom,
      onImageLoad,
      onImageError,
      handleTouchStart,
      handleTouchMove,
      handleTouchEnd,
      handlePointerDown,
      handlePointerMove,
      handlePointerUp
    };
  }
});
</script>

<style scoped>
.image-viewer-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.95);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 9999;
  outline: none;
  overflow: hidden;
}

.close-btn {
  position: absolute;
  top: 20px;
  right: 20px;
  width: 48px;
  height: 48px;
  background: rgba(255, 255, 255, 0.1);
  border: none;
  border-radius: 50%;
  color: white;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: all 0.2s;
  z-index: 10;
  backdrop-filter: blur(10px);
  -webkit-backdrop-filter: blur(10px);
}

.close-btn svg {
  width: 24px;
  height: 24px;
}

.close-btn:hover {
  background: rgba(255, 255, 255, 0.2);
  transform: scale(1.1);
}

.image-counter {
  position: absolute;
  top: 20px;
  left: 50%;
  transform: translateX(-50%);
  color: white;
  background: rgba(0, 0, 0, 0.5);
  padding: 8px 16px;
  border-radius: 20px;
  font-size: 14px;
  font-weight: 500;
  z-index: 10;
  backdrop-filter: blur(10px);
  -webkit-backdrop-filter: blur(10px);
}

.image-container {
  max-width: 90vw;
  max-height: 90vh;
  display: flex;
  align-items: center;
  justify-content: center;
  position: relative;
  width: 100vw;
  height: 100vh;
  touch-action: none;
}

.viewer-image {
  max-width: 100%;
  max-height: 90vh;
  object-fit: contain;
  display: block;
  transition: transform 0.18s ease;
  transform-origin: center center;
  user-select: none;
  -webkit-user-select: none;
}

.loading-spinner,
.error-message {
  color: white;
  font-size: 16px;
  text-align: center;
  padding: 20px;
}

.nav-btn {
  position: absolute;
  top: 50%;
  transform: translateY(-50%);
  width: 48px;
  height: 48px;
  background: rgba(255, 255, 255, 0.1);
  border: none;
  border-radius: 50%;
  color: white;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: all 0.2s;
  z-index: 10;
  backdrop-filter: blur(10px);
  -webkit-backdrop-filter: blur(10px);
}

.nav-btn svg {
  width: 24px;
  height: 24px;
}

.nav-btn:hover:not(:disabled) {
  background: rgba(255, 255, 255, 0.2);
  transform: translateY(-50%) scale(1.1);
}

.nav-btn:disabled {
  opacity: 0.3;
  cursor: not-allowed;
}

.nav-btn-prev {
  left: 20px;
}

.nav-btn-next {
  right: 20px;
}

.thumbnail-strip {
  position: absolute;
  bottom: 20px;
  left: 50%;
  transform: translateX(-50%);
  display: flex;
  gap: 8px;
  background: rgba(0, 0, 0, 0.5);
  padding: 8px;
  border-radius: 12px;
  max-width: 90vw;
  overflow-x: auto;
  backdrop-filter: blur(10px);
  -webkit-backdrop-filter: blur(10px);
}

.thumbnail {
  width: 60px;
  height: 60px;
  border-radius: 6px;
  overflow: hidden;
  cursor: pointer;
  border: 2px solid transparent;
  transition: all 0.2s;
  flex-shrink: 0;
}

.thumbnail:hover {
  border-color: rgba(255, 255, 255, 0.5);
  transform: scale(1.05);
}

.thumbnail.active {
  border-color: white;
}

.thumbnail img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}

/* Fade transition */
.fade-enter-active,
.fade-leave-active {
  transition: opacity 0.3s ease;
}

.fade-enter-from,
.fade-leave-to {
  opacity: 0;
}

/* Mobile optimizations */
@media (max-width: 768px) {
  .close-btn,
  .nav-btn {
    width: 40px;
    height: 40px;
  }

  .close-btn svg,
  .nav-btn svg {
    width: 20px;
    height: 20px;
  }

  .close-btn {
    top: 10px;
    right: 10px;
  }

  .nav-btn-prev {
    left: 10px;
  }

  .nav-btn-next {
    right: 10px;
  }

  .image-counter {
    top: 10px;
    font-size: 12px;
    padding: 6px 12px;
  }

  .thumbnail-strip {
    bottom: 10px;
    padding: 6px;
    gap: 6px;
  }

  .thumbnail {
    width: 50px;
    height: 50px;
  }
}
</style>
