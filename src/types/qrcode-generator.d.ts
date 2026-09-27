declare module "qrcode-generator" {
  type ErrorCorrectionLevel = "L" | "M" | "Q" | "H";
  type QrCode = {
    addData(data: string, mode?: "Numeric" | "Alphanumeric" | "Byte" | "Kanji"): void;
    make(): void;
    createSvgTag(options?: {
      cellSize?: number;
      margin?: number;
      scalable?: boolean;
    }): string;
  };
  export default function qrcode(typeNumber?: number, errorCorrectionLevel?: ErrorCorrectionLevel): QrCode;
}
