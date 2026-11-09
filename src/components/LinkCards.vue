<template>
  <div v-if="cards.length" class="link-cards">
    <div v-for="card in cards" :key="card.url" class="link-card" :class="card.kind">
      <div v-if="loaded.has(card.url) && card.embedUrl" class="link-embed">
        <!-- The app sends no referrer by default; YouTube refuses to play
             without one, so this tapped-open player sends only our origin. -->
        <iframe
          :src="card.embedUrl"
          :title="`${card.site} 播放器`"
          allow="autoplay; encrypted-media; picture-in-picture; fullscreen"
          allowfullscreen
          referrerpolicy="strict-origin-when-cross-origin"
        ></iframe>
      </div>
      <img
        v-else-if="loaded.has(card.url) && card.kind === 'image' && !failed.has(card.url)"
        class="link-image"
        :src="card.url"
        alt="链接中的图片"
        @error="markFailed(card.url)"
      />
      <a v-if="card.kind === 'maps'" class="link-map" :href="card.url" target="_blank" rel="noopener noreferrer nofollow" tabindex="-1" aria-hidden="true" @click.stop>
        <MapLinkThumb :url="card.url" />
      </a>
      <div class="link-row">
        <!-- Videos and images open in the card itself; tapping anywhere on
             the card plays or shows it. Other sites open as links. -->
        <button
          v-if="canLoad(card)"
          class="link-main"
          type="button"
          :aria-label="card.kind === 'image' ? '显示图片' : `播放 ${card.site} 视频`"
          @click.stop="load(card.url)"
        >
          <span class="link-badge" aria-hidden="true">{{ BADGES[card.kind] }}</span>
          <span class="link-copy">
            <strong>{{ card.kind === "image" ? "点击显示图片" : `点击播放 · ${card.site}` }}</strong>
            <small>{{ card.display }}</small>
          </span>
        </button>
        <a v-else class="link-main" :href="card.url" target="_blank" rel="noopener noreferrer nofollow" @click.stop>
          <span class="link-badge" aria-hidden="true">{{ BADGES[card.kind] }}</span>
          <span class="link-copy">
            <strong>{{ card.site }}</strong>
            <small>{{ card.display }}</small>
          </span>
        </a>
        <a
          v-if="(card.embedUrl || card.kind === 'image') && !loaded.has(card.url)"
          class="link-open"
          :href="card.url"
          target="_blank"
          rel="noopener noreferrer nofollow"
          :aria-label="`在 ${card.site} 打开`"
          @click.stop
        >{{ card.kind === "image" ? "打开" : `在 ${card.site} 打开` }}</a>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from "vue";
import MapLinkThumb from "@/components/MapLinkThumb.vue";
import { linkCardsFor, type LinkInfo, type LinkKind } from "@/utils/links";

const props = withDefaults(defineProps<{ text: string; max?: number }>(), { max: 3 });

// Text badges instead of favicons: a favicon would be a request to the site.
const BADGES: Record<LinkKind, string> = {
  youtube: "▶", vimeo: "▶", x: "𝕏", instagram: "◎", tiktok: "♪", niconico: "ニ", maps: "📍",
  amazon: "a", github: "GH", wikipedia: "W", spotify: "♫", line: "L", image: "🖼", web: "🔗",
};

const cards = computed(() => linkCardsFor(props.text, props.max));
const loaded = ref(new Set<string>());
const failed = ref(new Set<string>());

function canLoad(card: LinkInfo) {
  if (loaded.value.has(card.url)) return false;
  return !!card.embedUrl || card.kind === "image";
}

function load(url: string) {
  loaded.value = new Set([...loaded.value, url]);
}

function markFailed(url: string) {
  failed.value = new Set([...failed.value, url]);
}
</script>

<style scoped>
.link-cards{display:grid;gap:6px;margin-top:6px;min-width:0}
/* The text above held only links that became these cards. */
:empty + .link-cards{margin-top:0}
.link-card{overflow:hidden;border:1px solid var(--bd-e5eaf0);border-radius:12px;background:var(--bg-f7f9f9)}
.link-row{display:flex;align-items:center;gap:6px;min-width:0;padding:7px 8px}
.link-main{display:flex;flex:1;align-items:center;gap:9px;min-width:0;padding:0;border:0;background:transparent;color:inherit;font:inherit;text-align:left;text-decoration:none;cursor:pointer}
.link-badge{display:grid;flex:none;width:30px;height:30px;place-items:center;border-radius:8px;background:#64748b;color:#fff;font-size:14px;font-weight:700;line-height:1}
.youtube .link-badge{background:#ff0033}
.vimeo .link-badge{background:#17d5ff}
.x .link-badge,.tiktok .link-badge,.niconico .link-badge,.github .link-badge{box-shadow:inset 0 0 0 1px rgba(255,255,255,.22)}
.x .link-badge{background:#0f1419}
.instagram .link-badge{background:linear-gradient(45deg,#f9ce34,#ee2a7b,#6228d7)}
.tiktok .link-badge{background:#010101}
.niconico .link-badge{background:#252525}
.maps .link-badge{background:#e8f0fe}
.amazon .link-badge{background:#ff9900;color:#111}
.github .link-badge{background:#24292f;font-size:11px}
.wikipedia .link-badge{background:#fff;color:#111;border:1px solid #c8ccd1;font-family:Georgia,serif}
.spotify .link-badge{background:#1db954}
.line .link-badge{background:#06c755}
.image .link-badge{background:#e2e8f0}
.link-copy{display:grid;min-width:0;gap:1px}
.link-copy strong{overflow:hidden;color:var(--fg-0f1419);font-size:13px;font-weight:600;text-overflow:ellipsis;white-space:nowrap}
.link-copy small{overflow:hidden;color:var(--fg-536471);font-size:11px;text-overflow:ellipsis;white-space:nowrap}
.link-open{flex:none;padding:6px 2px;color:var(--fg-536471);font-size:11px;text-decoration:none;white-space:nowrap}
.link-embed{position:relative;aspect-ratio:16/9;background:#000}
.link-embed iframe{position:absolute;inset:0;width:100%;height:100%;border:0}
.link-map{display:block}
.link-image{display:block;width:100%;max-height:320px;object-fit:contain;background:var(--bg-eff3f4)}
</style>
