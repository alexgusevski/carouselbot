import { open } from "node:fs/promises";
import { constants } from "node:fs";

// Read through one descriptor: replacing a path after validation cannot change
// the file being read, and growing a file cannot exceed the byte reservation.
export async function readBoundedFile(path, limit, { noFollow = false } = {}) {
  const handle = await open(path, constants.O_RDONLY | constants.O_NONBLOCK | (noFollow ? constants.O_NOFOLLOW || 0 : 0));
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile() || metadata.size <= 0 || metadata.size > limit) throw new Error("File is unavailable or exceeds the transfer limit.");
    const buffer = Buffer.alloc(metadata.size + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, null);
      if (!bytesRead) break;
      length += bytesRead;
    }
    if (length > metadata.size) throw new Error("File changed while reading. Please retry.");
    return { buffer: buffer.subarray(0, length), metadata };
  } finally { await handle.close(); }
}
