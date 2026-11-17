import { open } from 'node:fs/promises';

const newline = 10;
const chunkBytes = 1 << 20;

export async function readFirstLine(file, maxLineBytes) {
  const handle = await open(file, 'r');
  const parts = [];
  let total = 0;
  try {
    const buffer = Buffer.alloc(Math.min(chunkBytes, maxLineBytes + 1));
    for (;;) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, total);
      if (bytesRead === 0) return null;
      const end = buffer.subarray(0, bytesRead).indexOf(newline);
      if (end !== -1 && total + end <= maxLineBytes) return Buffer.concat([...parts, buffer.subarray(0, end)]).toString('utf8');
      total += bytesRead;
      if (end !== -1 || total > maxLineBytes) return null;
      parts.push(Buffer.from(buffer.subarray(0, bytesRead)));
    }
  } finally {
    await handle.close();
  }
}

export async function readHead(handle, bytes) {
  const buffer = Buffer.alloc(bytes);
  let total = 0;
  while (total < bytes) {
    const { bytesRead } = await handle.read(buffer, total, bytes - total, total);
    if (bytesRead === 0) break;
    total += bytesRead;
  }
  return buffer.subarray(0, total);
}

export async function readNewLines({ file, handle: opened, offset, maxLineBytes, markers, onLine, shouldStop = () => false }) {
  const handle = opened ?? await open(file, 'r');
  const markerBytes = markers.map((marker) => Buffer.from(marker));
  let position = offset;
  let consumed = offset;
  let pending = [];
  let pendingBytes = 0;
  let oversized = false;
  let skipped = 0;
  const buffer = Buffer.alloc(chunkBytes);
  const finishLine = (line) => {
    if (markerBytes.some((marker) => line.includes(marker))) onLine(line.toString('utf8'));
  };
  try {
    for (;;) {
      const { bytesRead } = await handle.read(buffer, 0, chunkBytes, position);
      if (bytesRead === 0) break;
      if (shouldStop()) return { offset: consumed, skipped, aborted: true };
      position += bytesRead;
      let start = 0;
      for (let end = buffer.indexOf(newline, 0); end !== -1 && end < bytesRead; end = buffer.indexOf(newline, start)) {
        if (oversized || pendingBytes + end - start > maxLineBytes) skipped += 1;
        else finishLine(pending.length ? Buffer.concat([...pending, buffer.subarray(start, end)]) : buffer.subarray(start, end));
        consumed += pendingBytes + end - start + 1;
        pending = [];
        pendingBytes = 0;
        oversized = false;
        start = end + 1;
      }
      if (start < bytesRead) {
        const rest = bytesRead - start;
        if (oversized || pendingBytes + rest > maxLineBytes) {
          oversized = true;
          pending = [];
        } else {
          pending.push(Buffer.from(buffer.subarray(start, bytesRead)));
        }
        pendingBytes += rest;
      }
    }
  } finally {
    if (!opened) await handle.close();
  }
  return { offset: consumed, skipped, aborted: false };
}
