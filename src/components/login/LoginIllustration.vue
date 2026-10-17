<template>
  <div class="illustration" role="img" aria-label="夜晚的海边，有人抱膝坐着，望向海平线上的一盏灯">
    <!-- Placeholder artwork; to be replaced by the final illustration. -->
    <svg class="scene" viewBox="0 0 390 540" preserveAspectRatio="xMidYMax slice" aria-hidden="true">
      <defs>
        <linearGradient id="hn-sky" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stop-color="#1F2B47" />
          <stop offset="1" stop-color="#2A3757" />
        </linearGradient>
        <linearGradient id="hn-sea" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stop-color="#18223B" />
          <stop offset="1" stop-color="#121A2E" />
        </linearGradient>
        <radialGradient id="hn-glow" cx="0.5" cy="0.5" r="0.5">
          <stop offset="0" stop-color="#F7C873" stop-opacity="0.75" />
          <stop offset="0.35" stop-color="#F7C873" stop-opacity="0.28" />
          <stop offset="1" stop-color="#F7C873" stop-opacity="0" />
        </radialGradient>
        <linearGradient id="hn-reflection" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stop-color="#F7C873" stop-opacity="0.7" />
          <stop offset="1" stop-color="#F7C873" stop-opacity="0" />
        </linearGradient>
        <mask id="hn-crescent">
          <circle cx="92" cy="112" r="24" fill="#fff" />
          <circle cx="103" cy="104" r="21" fill="#000" />
        </mask>
      </defs>

      <rect width="390" height="332" fill="url(#hn-sky)" />
      <g fill="#F3E3B3">
        <circle cx="38" cy="58" r="1.1" opacity=".7" />
        <circle cx="160" cy="40" r="1.3" opacity=".8" />
        <circle cx="232" cy="92" r="0.9" opacity=".6" />
        <circle cx="318" cy="52" r="1.2" opacity=".75" />
        <circle cx="356" cy="140" r="0.9" opacity=".55" />
        <circle cx="200" cy="168" r="0.8" opacity=".45" />
        <circle cx="28" cy="196" r="0.9" opacity=".5" />
        <circle cx="282" cy="210" r="0.8" opacity=".45" />
      </g>
      <rect x="62" y="82" width="60" height="60" fill="#F3E3B3" mask="url(#hn-crescent)" />

      <rect y="330" width="390" height="210" fill="url(#hn-sea)" />
      <line x1="0" y1="330.5" x2="390" y2="330.5" stroke="#2E3B5C" stroke-width="1" />

      <circle cx="286" cy="329" r="62" fill="url(#hn-glow)" />
      <circle cx="286" cy="329" r="3.4" fill="#F7C873" />
      <g fill="url(#hn-reflection)">
        <rect x="280" y="336" width="12" height="2" rx="1" />
        <rect x="277" y="344" width="18" height="2" rx="1" opacity=".85" />
        <rect x="281" y="353" width="10" height="2" rx="1" opacity=".75" />
        <rect x="275" y="362" width="22" height="2" rx="1" opacity=".55" />
        <rect x="282" y="373" width="9" height="2" rx="1" opacity=".45" />
        <rect x="276" y="385" width="19" height="2" rx="1" opacity=".3" />
        <rect x="281" y="399" width="11" height="2" rx="1" opacity=".2" />
      </g>
      <g stroke="#2B3859" stroke-width="1.2" stroke-linecap="round" opacity=".7">
        <path d="M40 360h46M150 376h30M208 352h24M60 402h22M330 396h34" />
      </g>

      <path d="M0 468C82 440 160 442 236 470C292 491 344 498 390 492V540H0Z" fill="#0E1424" />
      <g fill="#0A0F1B">
        <circle cx="114" cy="413" r="10.5" />
        <path d="M103 424C95 434 94 448 99 458H139C142 448 141 434 134 427C128 421 119 418 111 419C108 420 105 421 103 424Z" />
      </g>
    </svg>

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
  background: #1F2B47;
}

.scene {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
}

.brand {
  position: absolute;
  top: 34%;
  left: 0;
  right: 0;
  text-align: center;
  color: #fff;
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
  color: rgba(255, 255, 255, 0.82);
  font-size: 14px;
  letter-spacing: 0.08em;
}

.fade {
  position: absolute;
  right: 0;
  bottom: 0;
  left: 0;
  height: 48px;
  background: linear-gradient(to bottom, transparent, var(--hn-bg));
}
</style>
