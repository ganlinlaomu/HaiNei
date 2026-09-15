<template>
  <div ref="container" class="encrypted-video-player-container">
    <!-- Loading state -->
    <div v-if="loading" class="video-loading">
      <div class="loading-spinner"></div>
      <div class="loading-text">解密视频中...</div>
    </div>

    <!-- Error state -->
    <div v-else-if="error" class="video-error">
      <div class="error-icon">⚠️</div>
      <div class="error-text">{{ error }}</div>
    </div>

    <!-- Video player -->
    <div v-else-if="decryptedUrl" class="video-player">
      <video
        ref="videoElement"
        :src="decryptedUrl"
        controls
        class="video-element"
        preload="metadata"
        @loadedmetadata="onVideoLoaded"
        @error="onVideoError"
      >
        您的浏览器不支持视频播放。
      </video>
    </div>
  </div>
</template>

<script lang="ts">
import { defineComponent, ref, onMounted, onBeforeUnmount, onActivated, onDeactivated, PropType } from 'vue';
import { decryptVideoToBlob, importKeyFromBase64 } from '@/utils/videoCrypto';
import type { EncryptedVideoMetadata } from '@/utils/encryptedVideoRef';

export default defineComponent({
  name: 'EncryptedVideoPlayer',
  props: {
    metadata: {
      type: Object as PropType<EncryptedVideoMetadata>,
      required: true
    }
  },
  setup(props) {
    const loading = ref(true);
    const error = ref<string | null>(null);
    const decryptedUrl = ref<string | null>(null);
    const videoElement = ref<HTMLVideoElement | null>(null);
    const container = ref<HTMLElement | null>(null);
    let observer: IntersectionObserver | null = null;
    let controller: AbortController | null = null;
    let started = false;
    let generation = 0;

    async function decryptAndLoad() {
      if (started) return;
      started = true;
      const run = ++generation;
      loading.value = true;
      error.value = null;
      controller = new AbortController();

      try {
        // Fetch the encrypted video from Blossom
        const response = await fetch(props.metadata.url, { signal: controller.signal });
        if (!response.ok) {
          throw new Error(`Failed to fetch video: ${response.status} ${response.statusText}`);
        }

        const encryptedBytes = new Uint8Array(await response.arrayBuffer());

        // Import the decryption key
        const key = await importKeyFromBase64(props.metadata.key);

        // Decrypt and create blob URL
        const blobUrl = await decryptVideoToBlob(
          encryptedBytes,
          key,
          props.metadata.iv,
          props.metadata.mime
        );

        if (run !== generation) {
          URL.revokeObjectURL(blobUrl);
          return;
        }
        decryptedUrl.value = blobUrl;
      } catch (e: any) {
        if (e?.name === 'AbortError') return;
        if (run !== generation) return;
        console.error('Failed to decrypt video:', e);
        error.value = e.message || '解密视频失败';
      } finally {
        if (run === generation) {
          controller = null;
          loading.value = false;
        }
      }
    }

    function observeVisibility() {
      if (started || observer || !container.value) return;
      observer = new IntersectionObserver(entries => {
        if (!entries.some(entry => entry.isIntersecting)) return;
        observer?.disconnect();
        observer = null;
        void decryptAndLoad();
      }, { rootMargin: '200px 0px', threshold: 0.01 });
      observer.observe(container.value);
    }

    function releaseVideo() {
      generation++;
      controller?.abort();
      controller = null;
      observer?.disconnect();
      observer = null;
      if (decryptedUrl.value) URL.revokeObjectURL(decryptedUrl.value);
      decryptedUrl.value = null;
      started = false;
      loading.value = true;
    }

    function onVideoLoaded() {
      console.log('Video loaded successfully');
    }

    function onVideoError(e: Event) {
      console.error('Video playback error:', e);
      error.value = '视频播放失败';
    }

    onMounted(() => {
      observeVisibility();
    });

    onActivated(observeVisibility);
    onDeactivated(releaseVideo);

    onBeforeUnmount(() => {
      releaseVideo();
    });

    return {
      loading,
      error,
      decryptedUrl,
      container,
      videoElement,
      onVideoLoaded,
      onVideoError
    };
  }
});
</script>

<style scoped>
.encrypted-video-player-container {
  width: 100%;
  margin: 12px 0;
  border-radius: 12px;
  overflow: hidden;
  background: #1f2937;
}

.video-loading,
.video-error {
  position: relative;
  width: 100%;
  padding-top: 56.25%; /* 16:9 aspect ratio */
  display: flex;
  align-items: center;
  justify-content: center;
}

.video-loading {
  background: linear-gradient(135deg, #1f2937 0%, #374151 100%);
}

.video-loading > *,
.video-error > * {
  position: absolute;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
}

.loading-spinner {
  width: 48px;
  height: 48px;
  border: 4px solid rgba(255, 255, 255, 0.2);
  border-top-color: #3b82f6;
  border-radius: 50%;
  animation: spin 1s linear infinite;
  margin-bottom: 60px;
}

@keyframes spin {
  to { transform: translate(-50%, -50%) rotate(360deg); }
}

.loading-text {
  color: white;
  font-size: 14px;
  margin-top: 60px;
  text-align: center;
}

.video-error {
  background: linear-gradient(135deg, #374151 0%, #1f2937 100%);
  flex-direction: column;
}

.error-icon {
  font-size: 48px;
  margin-bottom: 12px;
}

.error-text {
  color: #f87171;
  font-size: 14px;
  text-align: center;
  padding: 0 20px;
}

.video-player {
  position: relative;
  width: 100%;
  padding-top: 56.25%; /* 16:9 aspect ratio */
}

.video-element {
  position: absolute;
  top: 0;
  left: 0;
  width: 100%;
  height: 100%;
  border: none;
  background: #000;
}
</style>
