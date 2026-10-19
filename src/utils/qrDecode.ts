/**
 * QR decoding for the scanner sheet. Prefers the browser's BarcodeDetector;
 * otherwise loads only zxing's QR reader (not the multi-format browser kit).
 */

export type QrDecode = (canvas: HTMLCanvasElement, tryHarder?: boolean) => Promise<string | null>;

type Detector = { detect: (source: CanvasImageSource) => Promise<Array<{ rawValue?: string }>> };
type DetectorClass = { new (options: { formats: string[] }): Detector; getSupportedFormats?: () => Promise<string[]> };

async function nativeDecoder(): Promise<QrDecode | null> {
  const Native = (globalThis as { BarcodeDetector?: DetectorClass }).BarcodeDetector;
  if (!Native) return null;
  try {
    if (Native.getSupportedFormats && !(await Native.getSupportedFormats()).includes("qr_code")) return null;
    const detector = new Native({ formats: ["qr_code"] });
    return async canvas => (await detector.detect(canvas)).find(code => code.rawValue)?.rawValue || null;
  } catch {
    return null;
  }
}

async function zxingDecoder(): Promise<QrDecode> {
  const [{ default: QRCodeReader }, { default: BinaryBitmap }, { default: HybridBinarizer }, { default: RGBLuminanceSource }, { default: DecodeHintType }] = await Promise.all([
    import("@zxing/library/esm/core/qrcode/QRCodeReader"),
    import("@zxing/library/esm/core/BinaryBitmap"),
    import("@zxing/library/esm/core/common/HybridBinarizer"),
    import("@zxing/library/esm/core/RGBLuminanceSource"),
    import("@zxing/library/esm/core/DecodeHintType"),
  ]);
  const reader = new QRCodeReader();
  return async (canvas, tryHarder = false) => {
    const { width, height } = canvas;
    const rgba = canvas.getContext("2d", { willReadFrequently: true })!.getImageData(0, 0, width, height).data;
    const luminance = new Uint8ClampedArray(width * height);
    for (let pixel = 0, offset = 0; pixel < luminance.length; pixel++, offset += 4) {
      luminance[pixel] = (rgba[offset] * 77 + rgba[offset + 1] * 150 + rgba[offset + 2] * 29) >> 8;
    }
    const hints = tryHarder ? new Map([[DecodeHintType.TRY_HARDER, true]]) : undefined;
    try {
      return reader.decode(new BinaryBitmap(new HybridBinarizer(new RGBLuminanceSource(luminance, width, height))), hints).getText();
    } catch {
      return null;
    } finally {
      reader.reset();
    }
  };
}

let decoderFlight: Promise<QrDecode> | null = null;
export function loadQrDecoder() {
  return decoderFlight ??= nativeDecoder().then(native => native || zxingDecoder()).catch(error => {
    decoderFlight = null;
    throw error;
  });
}

/** Draw a frame or image scaled to at most `maxSide` pixels on its longer edge. */
export function drawScaled(canvas: HTMLCanvasElement, source: CanvasImageSource, width: number, height: number, maxSide: number) {
  const scale = Math.min(1, maxSide / Math.max(width, height));
  canvas.width = Math.max(1, Math.round(width * scale));
  canvas.height = Math.max(1, Math.round(height * scale));
  canvas.getContext("2d", { willReadFrequently: true })!.drawImage(source, 0, 0, canvas.width, canvas.height);
  return canvas;
}
