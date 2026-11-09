<template>
  <div class="video-player-container">
    <!-- Encrypted video player -->
    <EncryptedVideoPlayer 
      v-if="isEncrypted && encryptedMetadata"
      :metadata="encryptedMetadata"
      :data-saver="settings.dataSaver"
    />
    
    <!-- Direct video rendering without thumbnail -->
    <div v-else class="video-player">
      <!-- YouTube / Vimeo: nothing loads from the video site until tapped. -->
      <button
        v-if="embed.iframeUrl && !playerLoaded"
        type="button"
        class="video-facade"
        :aria-label="`播放 ${videoData.provider} 视频`"
        @click.stop="playerLoaded = true"
      >
        <!-- Through the HaiNei Worker: the video site never sees the reader. -->
        <img
          v-if="thumbUrl && !thumbFailed"
          class="video-facade-thumb"
          :src="thumbUrl"
          crossorigin="anonymous"
          referrerpolicy="origin"
          loading="lazy"
          alt=""
          @error="thumbFailed = true"
        />
        <span class="video-facade-play" aria-hidden="true">▶</span>
        <span class="video-facade-label">点击播放 {{ videoData.provider }} 视频</span>
      </button>

      <!-- YouTube embed. The app sends no referrer by default and YouTube
           refuses to play without one, so this player sends only our origin. -->
      <iframe
        v-else-if="videoData.provider === 'YouTube' && embed.iframeUrl"
        :src="`${embed.iframeUrl}?autoplay=1&playsinline=1`"
        frameborder="0"
        allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
        allowfullscreen
        referrerpolicy="strict-origin-when-cross-origin"
        class="video-iframe"
      ></iframe>

      <!-- Vimeo embed -->
      <iframe
        v-else-if="videoData.provider === 'Vimeo' && embed.iframeUrl"
        :src="`${embed.iframeUrl}?autoplay=1`"
        frameborder="0"
        allow="autoplay; fullscreen; picture-in-picture"
        allowfullscreen
        referrerpolicy="strict-origin-when-cross-origin"
        class="video-iframe"
      ></iframe>

      <!-- Direct video or hosted video -->
      <video
        v-else-if="embed.mediaUrl"
        :src="embed.mediaUrl"
        controls
        class="video-element"
        :preload="settings.dataSaver ? 'none' : 'metadata'"
      >
        您的浏览器不支持视频播放。
      </video>

      <!-- Fallback for external links -->
      <div v-else-if="embed.linkUrl" class="video-fallback">
        <a :href="embed.linkUrl" target="_blank" rel="noopener noreferrer" class="external-link">
          打开外部视频链接
        </a>
      </div>
    </div>
  </div>
</template>

<script lang="ts">
import { defineComponent, PropType, computed, ref } from 'vue';
import { safeVideoEmbed, type VideoData } from '@/utils/videoUtils';
import { classifyLink } from '@/utils/links';
import { haineiWorkerBaseUrl } from '@/services/workerUrl';
import { isEncryptedVideoRef, decodeEncryptedVideoRef } from '@/utils/encryptedVideoRef';
import EncryptedVideoPlayer from './EncryptedVideoPlayer.vue';
import { useSettingsStore } from '@/stores/settings';

export default defineComponent({
  name: 'VideoPlayer',
  components: {
    EncryptedVideoPlayer
  },
  props: {
    videoData: {
      type: Object as PropType<VideoData>,
      required: true
    }
  },
  setup(props) {
    const settings = useSettingsStore();
    // Check if the video URL is an encrypted reference
    const isEncrypted = computed(() => {
      return isEncryptedVideoRef(props.videoData.url);
    });

    // Decode encrypted metadata if available
    const encryptedMetadata = computed(() => {
      if (!isEncrypted.value) return null;
      return decodeEncryptedVideoRef(props.videoData.url);
    });

    // Never bind raw videoData URLs: they come from peer-authored content.
    const embed = computed(() => safeVideoEmbed(props.videoData));
    const playerLoaded = ref(false);
    const thumbFailed = ref(false);
    // Same proxied thumbnail as chat link cards, from the validated embed URL.
    const thumbUrl = computed(() => {
      const iframeUrl = embed.value.iframeUrl;
      if (!iframeUrl) return '';
      const id = /\/embed\/([A-Za-z0-9_-]{11})$/.exec(iframeUrl)?.[1] || /\/video\/(\d+)$/.exec(iframeUrl)?.[1];
      const path = id && classifyLink(props.videoData.provider === 'YouTube' ? `https://youtu.be/${id}` : `https://vimeo.com/${id}`).thumbPath;
      return path ? `${haineiWorkerBaseUrl()}${path}` : '';
    });

    return {
      playerLoaded,
      thumbFailed,
      thumbUrl,
      settings,
      isEncrypted,
      encryptedMetadata,
      embed
    };
  }
});
</script>

<style scoped>
.video-player-container {
  width: 100%;
  margin: 12px 0;
  border-radius: 12px;
  overflow: hidden;
  background: #1f2937;
}

.video-player {
  position: relative;
  width: 100%;
  padding-top: 56.25%; /* 16:9 aspect ratio */
}

.video-iframe,
.video-element {
  position: absolute;
  top: 0;
  left: 0;
  width: 100%;
  height: 100%;
  border: none;
}

.video-element {
  background: #000;
}

.video-facade {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 10px;
  border: 0;
  background: #111827;
  color: #fff;
  font: inherit;
  cursor: pointer;
}

.video-facade-thumb {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.video-facade-label {
  position: relative;
  text-shadow: 0 1px 3px rgba(0, 0, 0, .7);
}

.video-facade-play {
  position: relative;
  display: grid;
  width: 56px;
  height: 40px;
  place-items: center;
  border-radius: 12px;
  background: #ff0033;
  font-size: 18px;
}

.video-facade-label {
  font-size: 13px;
  opacity: .85;
}

.video-fallback {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  background: #1f2937;
  padding: 20px;
}

.external-link {
  color: #3b82f6;
  text-decoration: none;
  font-size: 16px;
  padding: 12px 24px;
  border: 2px solid #3b82f6;
  border-radius: 8px;
  transition: all 0.2s;
}

.external-link:hover {
  background: #3b82f6;
  color: white;
}
</style>
