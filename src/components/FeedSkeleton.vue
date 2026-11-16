<template>
  <div class="feed-skeleton" role="status" aria-label="正在加载动态">
    <div v-for="n in 3" :key="n" class="skeleton-card" aria-hidden="true">
      <div class="skeleton-head"><span class="skeleton-avatar"></span><span class="skeleton-line short"></span></div>
      <span class="skeleton-line"></span>
      <span class="skeleton-line"></span>
      <span class="skeleton-line medium"></span>
    </div>
  </div>
</template>

<style scoped>
.feed-skeleton{display:grid;gap:22px;padding:14px 16px}
.skeleton-card{display:grid;gap:10px;animation:skeleton-pulse 1.2s ease-in-out infinite alternate}
.skeleton-head{display:flex;align-items:center;gap:10px;margin-bottom:2px}
.skeleton-avatar{width:40px;height:40px;flex:none;border-radius:50%;background:var(--bg-e2e8f0)}
.skeleton-line{display:block;width:100%;height:12px;border-radius:6px;background:var(--bg-e2e8f0)}
.skeleton-line.short{width:30%}
.skeleton-line.medium{width:62%}
@keyframes skeleton-pulse{from{opacity:1}to{opacity:.55}}
@media (prefers-reduced-motion:reduce){.skeleton-card{animation:none}}
</style>
