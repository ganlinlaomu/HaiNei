const fileIdentity = (file: File) => `${file.name}\u0000${file.size}\u0000${file.lastModified}`;

/**
 * The files a new pick adds to those already selected: images (and videos when
 * allowed) only, none picked twice, and no more than `max` in total.
 */
export function imagesToAppend(selected: readonly File[], picked: readonly File[], max: number, options: { videos?: boolean } = {}) {
  const seen = new Set(selected.map(fileIdentity));
  const fresh = picked.filter(file => {
    if (!file.type.startsWith("image/") && !(options.videos && file.type.startsWith("video/"))) return false;
    const identity = fileIdentity(file);
    if (seen.has(identity)) return false;
    seen.add(identity);
    return true;
  });
  const room = Math.max(0, max - selected.length);
  return { added: fresh.slice(0, room), overflow: fresh.length > room };
}
