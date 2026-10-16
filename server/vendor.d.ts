declare module "libheif-js/libheif-wasm/libheif-bundle.mjs" {
  const createLibheif: () => object;
  export default createLibheif;
}

declare module "heic-decode/lib.js" {
  interface DecodedHeic {
    width: number;
    height: number;
    data: Uint8ClampedArray;
  }
  interface HeicFrame {
    width: number;
    height: number;
    decode(): Promise<DecodedHeic>;
  }
  interface HeicDecoder {
    one(input: { buffer: Uint8Array }): Promise<DecodedHeic>;
    all(input: { buffer: Uint8Array }): Promise<HeicFrame[] & { dispose(): void }>;
  }
  const createDecoder: (libheif: object) => HeicDecoder;
  export default createDecoder;
}
