/** Square, center-cropped JPEG data URL small enough for the local account list. */
export async function createAvatarThumb(file: Blob, size = 96): Promise<string> {
  if (!file.type.startsWith("image/") || typeof createImageBitmap !== "function") return "";
  const bitmap = await createImageBitmap(file);
  try {
    const side = Math.min(bitmap.width, bitmap.height);
    const canvas = document.createElement("canvas");
    canvas.width = size;
    canvas.height = size;
    const context = canvas.getContext("2d");
    if (!context) return "";
    context.drawImage(
      bitmap,
      (bitmap.width - side) / 2,
      (bitmap.height - side) / 2,
      side,
      side,
      0,
      0,
      size,
      size,
    );
    return canvas.toDataURL("image/jpeg", 0.8);
  } finally {
    bitmap.close();
  }
}
