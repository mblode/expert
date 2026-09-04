/** PNG signature. Anything else is not ours and gets no metadata. */
const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Signature (8) + IHDR length (4) + "IHDR" (4) puts width at 16, height at 20. */
const IHDR_WIDTH_OFFSET = 16;
const HEADER_BYTES = 24;

/**
 * Width and height out of a PNG's IHDR, without decoding it.
 *
 * `undefined` rather than a throw on anything unparseable: the bytes are the
 * screenshot and the size is a convenience, so a header this cannot read must
 * cost the model its metadata, never its image.
 */
export function pngSize(buf: Buffer): { width: number; height: number } | undefined {
  if (buf.length < HEADER_BYTES || !buf.subarray(0, SIGNATURE.length).equals(SIGNATURE)) {
    return undefined;
  }
  const width = buf.readUInt32BE(IHDR_WIDTH_OFFSET);
  const height = buf.readUInt32BE(IHDR_WIDTH_OFFSET + 4);
  return width > 0 && height > 0 ? { height, width } : undefined;
}
