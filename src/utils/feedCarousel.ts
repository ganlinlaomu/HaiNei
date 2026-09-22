export function adjacentSlideIndexes(activeIndex: number, count: number) {
  return [activeIndex - 1, activeIndex, activeIndex + 1]
    .filter(index => index >= 0 && index < count);
}

export function carouselActiveIndex(scrollLeft: number, slideWidth: number, count: number) {
  if (slideWidth <= 0 || count <= 0) return 0;
  return Math.max(0, Math.min(count - 1, Math.round(scrollLeft / slideWidth)));
}

export function carouselIndicators(count: number) {
  return Array.from({ length: Math.max(0, count) }, (_, index) => index);
}

export function isCarouselDoubleTap(previousAt: number, previousIndex: number, now: number, index: number) {
  return previousIndex === index && previousAt > 0 && now - previousAt < 300;
}

export function shouldSendDoubleTapLike(liked: boolean, pending: boolean) {
  return !liked && !pending;
}
