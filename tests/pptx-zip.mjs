// tests/pptx-zip.mjs - minimal .pptx (ZIP) reader for the test suites.
// No dependency: ZIP central-directory parsing plus raw DEFLATE via
// node:zlib. Used to assert on the actual exported file, not just on the
// options passed to PptxGenJS: slide backgrounds and text colours live in
// ppt/slides/slideN.xml as srgbClr values.
import { inflateRawSync } from "node:zlib";

function findEocd(buf) {
  // End of central directory: PK\x05\x06, searched from the end.
  for (let i = buf.length - 22; i >= 0; i -= 1) {
    if (buf[i] === 0x50 && buf[i + 1] === 0x4b && buf[i + 2] === 0x05 && buf[i + 3] === 0x06) return i;
  }
  return -1;
}

// All member files as { name, text }. Throws on a malformed archive.
export function pptxMembers(base64) {
  const buf = Buffer.from(base64, "base64");
  if (buf.subarray(0, 2).toString("latin1") !== "PK") throw new Error("not a ZIP file");
  const eocd = findEocd(buf);
  if (eocd < 0) throw new Error("ZIP end of central directory not found");
  const count = buf.readUInt16LE(eocd + 10);
  let offset = buf.readUInt32LE(eocd + 16);
  const out = [];
  for (let n = 0; n < count; n += 1) {
    if (buf.readUInt32LE(offset) !== 0x02014b50) throw new Error("bad central directory entry");
    const method = buf.readUInt16LE(offset + 10);
    const compressedSize = buf.readUInt32LE(offset + 20);
    const nameLen = buf.readUInt16LE(offset + 28);
    const extraLen = buf.readUInt16LE(offset + 30);
    const commentLen = buf.readUInt16LE(offset + 32);
    const localOffset = buf.readUInt32LE(offset + 42);
    const name = buf.subarray(offset + 46, offset + 46 + nameLen).toString("utf8");
    const localNameLen = buf.readUInt16LE(localOffset + 26);
    const localExtraLen = buf.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLen + localExtraLen;
    const compressed = buf.subarray(dataStart, dataStart + compressedSize);
    let text;
    if (method === 0) text = compressed.toString("utf8");
    else if (method === 8) text = inflateRawSync(compressed).toString("utf8");
    else throw new Error(`unsupported ZIP method ${method} for ${name}`);
    out.push({ name, text });
    offset += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

// The concatenated XML of every slide in the deck, in slide order.
export function pptxSlideXml(base64) {
  return pptxMembers(base64)
    .filter((m) => /^ppt\/slides\/slide\d+\.xml$/.test(m.name))
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }))
    .map((m) => m.text)
    .join("\n");
}
