import { ref } from "vue";
import { imagesToAppend } from "@/utils/selectedImages";

export type SelectedDmImage = { file: File; preview: string };

/**
 * Images picked for the next DM: each pick appends to the current selection
 * (deduplicated, capped at `max`), and every preview object URL is revoked
 * when its image leaves the selection.
 */
export function useDmImageSelection(options: {
  max: number;
  notify: (message: string) => void;
  warm?: (file: File) => Promise<unknown>;
}) {
  const selectedImages = ref<SelectedDmImage[]>([]);
  const imageInput = ref<HTMLInputElement | null>(null);

  function clearSelectedImages() {
    for (const image of selectedImages.value) URL.revokeObjectURL(image.preview);
    selectedImages.value = [];
    if (imageInput.value) imageInput.value.value = "";
  }

  function removeSelectedImage(index: number) {
    const [removed] = selectedImages.value.splice(index, 1);
    if (removed) URL.revokeObjectURL(removed.preview);
    if (!selectedImages.value.length && imageInput.value) imageInput.value.value = "";
  }

  function selectImages(event: Event) {
    const input = event.target as HTMLInputElement;
    const picked = [...(input.files || [])];
    // Reset so picking the same photo again after removing it still fires change.
    input.value = "";
    const { added, overflow } = imagesToAppend(selectedImages.value.map(image => image.file), picked, options.max);
    const images = added.map(file => ({ file, preview: URL.createObjectURL(file) }));
    selectedImages.value = [...selectedImages.value, ...images];
    for (const image of images) void options.warm?.(image.file).catch(() => undefined);
    if (overflow) options.notify(`一次最多发送 ${options.max} 张图片`);
  }

  return { selectedImages, imageInput, clearSelectedImages, removeSelectedImage, selectImages };
}
