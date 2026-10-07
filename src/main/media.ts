import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';

const TYPES: Record<string, string> = {
  '.wav': 'audio/wav', '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.aac': 'audio/aac', '.ogg': 'audio/ogg',
  '.opus': 'audio/ogg', '.flac': 'audio/flac', '.webm': 'audio/webm', '.mp4': 'video/mp4', '.m4v': 'video/mp4',
  '.mov': 'video/quicktime', '.mkv': 'video/x-matroska', '.avi': 'video/x-msvideo',
};

/**
 * Streams a source audio/video file for <audio>. Seeking to a cue needs byte
 * ranges, so a single "bytes=a-b" range is answered with 206.
 */
export async function mediaResponse(file: string, range: string | null): Promise<Response> {
  let size: number;
  try {
    const info = await stat(file);
    if (!info.isFile()) return new Response('Not found', { status: 404 });
    size = info.size;
  } catch { return new Response('Not found', { status: 404 }); }
  const headers: Record<string, string> = { 'Content-Type': TYPES[path.extname(file).toLowerCase()] ?? 'application/octet-stream', 'Accept-Ranges': 'bytes' };
  const body = (start: number, end: number) => Readable.toWeb(createReadStream(file, { start, end })) as unknown as ReadableStream;
  const match = range ? /^bytes=(\d*)-(\d*)$/.exec(range.trim()) : null;
  if (!match || (!match[1] && !match[2])) {
    if (!size) return new Response(null, { status: 200, headers: { ...headers, 'Content-Length': '0' } });
    return new Response(body(0, size - 1), { status: 200, headers: { ...headers, 'Content-Length': String(size) } });
  }
  // "bytes=-500" asks for the last 500 bytes.
  let start = match[1] ? Number(match[1]) : Math.max(0, size - Number(match[2]));
  let end = match[1] && match[2] ? Math.min(Number(match[2]), size - 1) : size - 1;
  if (!match[1]) end = size - 1;
  if (start >= size || start > end) return new Response(null, { status: 416, headers: { ...headers, 'Content-Range': `bytes */${size}` } });
  start = Math.max(0, start);
  return new Response(body(start, end), { status: 206, headers: { ...headers, 'Content-Length': String(end - start + 1), 'Content-Range': `bytes ${start}-${end}/${size}` } });
}
