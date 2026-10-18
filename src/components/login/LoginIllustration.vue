<template>
  <div
    class="illustration"
    role="img"
    aria-label="晴朗的蓝天下，一家人在开满小花的草坡上快乐地奔跑、放风筝"
  >
    <img
      class="artwork"
      src="/login-welcome.webp"
      alt=""
      width="1024"
      height="1536"
      decoding="async"
      fetchpriority="high"
    />

    <div class="brand">
      <h1>海内</h1>
      <p>海内存知己，天涯若比邻</p>
    </div>
    <div class="fade" aria-hidden="true"></div>
  </div>
</template>

<style scoped>
.illustration {
  position: relative;
  overflow: hidden;
  height: min(540px, 62svh);
  min-height: 340px;
  background: #69b8ec;
}

.artwork {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  object-fit: cover;
  object-position: center 48%;
}

.brand {
  position: absolute;
  top: 17%;
  right: 0;
  left: 0;
  text-align: center;
  color: #fff;
  text-shadow: 0 2px 12px rgba(22, 82, 132, 0.42);
}

.brand h1 {
  margin: 0;
  font-family: var(--hn-font-brand);
  font-size: 2.75rem;
  font-weight: 400;
  line-height: 1.2;
  letter-spacing: 0.12em;
  /* letter-spacing also pads the last glyph; shift back to stay optically centered */
  text-indent: 0.12em;
}

.brand p {
  margin: 10px 0 0;
  color: rgba(255, 255, 255, 0.94);
  font-size: 14px;
  letter-spacing: 0.08em;
}

.fade {
  position: absolute;
  right: 0;
  bottom: 0;
  left: 0;
  height: 72px;
  background: linear-gradient(to bottom, transparent, var(--hn-bg));
}
</style>
