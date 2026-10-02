/**
 * What an uploaded file's BYTES say it is.
 *
 * `File.type` is whatever the browser — or a hand-built request — claims, so on
 * its own it proves nothing. This checks the leading signature against the
 * declared type, so a script or an executable renamed to .png is refused before
 * it is stored and, for a crest, handed to the image decoder.
 */
function startsWith(bytes: Uint8Array, signature: number[], offset = 0) {
  return signature.every((byte, index) => bytes[offset + index] === byte);
}

const ascii = (text: string) => [...text].map((c) => c.charCodeAt(0));

export function bytesMatchType(bytes: Uint8Array, mimeType: string): boolean {
  switch (mimeType) {
    case "image/png":
      return startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    case "image/jpeg":
      return startsWith(bytes, [0xff, 0xd8, 0xff]);
    case "image/webp":
      return startsWith(bytes, ascii("RIFF")) && startsWith(bytes, ascii("WEBP"), 8);
    case "image/heic":
      // ISO base media: "ftyp" at offset 4, then a HEIF brand.
      return (
        startsWith(bytes, ascii("ftyp"), 4) &&
        ["heic", "heix", "hevc", "hevx", "mif1", "msf1"].some((brand) =>
          startsWith(bytes, ascii(brand), 8),
        )
      );
    case "application/pdf":
      // Readers tolerate a little junk before the header; so do we.
      return Buffer.from(bytes.subarray(0, 1024)).includes("%PDF-");
    default:
      return false;
  }
}
