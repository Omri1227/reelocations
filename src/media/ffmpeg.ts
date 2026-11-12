import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

export function ffmpegPath(): string | null {
  try { const p = require('ffmpeg-static') as string; return p && fs.existsSync(p) ? p : null; } catch { return null; }
}

export function run(bin: string, args: string[], timeoutMs = 120_000): Promise<{ code: number; stdout: Buffer; stderr: string }> {
  return new Promise((resolve, reject) => {
    const p = spawn(bin, args, { windowsHide: true });
    const out: Buffer[] = []; let err = '';
    const t = setTimeout(() => { p.kill(); reject(new Error(`${path.basename(bin)} timed out`)); }, timeoutMs);
    p.stdout.on('data', (d) => out.push(d));
    p.stderr.on('data', (d) => { err += d.toString(); if (err.length > 20_000) err = err.slice(-10_000); });
    p.on('error', (e) => { clearTimeout(t); reject(e); });
    p.on('close', (code) => { clearTimeout(t); resolve({ code: code ?? -1, stdout: Buffer.concat(out), stderr: err }); });
  });
}

export async function probeDuration(ff: string, file: string): Promise<number | null> {
  const r = await run(ff, ['-hide_banner', '-i', file], 30_000).catch(() => null);
  const m = r?.stderr.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
  return m ? Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) : null;
}

export function hasAudioStream(stderr: string): boolean { return /Stream #\d+:\d+.*Audio:/.test(stderr); }

/**
 * Sample frames for OCR: evenly spaced (max `max`), always including the first and the last second
 * (location text and "shown at the end" moments are common there).
 */
/** Times (s) where the picture changes a lot — cuts between stops in a montage. ffmpeg scene score > threshold. */
export async function sceneChanges(file: string, threshold = 0.35, max = 12): Promise<number[]> {
  const ff = ffmpegPath(); if (!ff) return [];
  const r = await run(ff, ['-hide_banner', '-i', file, '-vf', `scale=320:-2,select='gt(scene,${threshold})',showinfo`, '-an', '-f', 'null', '-'], 180_000).catch(() => null);
  if (!r) return [];
  return [...r.stderr.matchAll(/pts_time:(\d+(?:\.\d+)?)/g)].map((m) => Number(m[1])).slice(0, max);
}

/** Merge even samples with scene cuts (a frame ~0.6 s after each cut, once the new shot has settled); drop near-duplicates. */
export function planFrameTimes(dur: number, cuts: number[], max = 16): number[] {
  const nEven = Math.max(2, Math.min(8, Math.ceil(dur / 3)));
  const even = Array.from({ length: nEven }, (_, i) => (i === nEven - 1 ? Math.max(0, dur - 0.3) : (dur * i) / (nEven - 1)));
  const cutFrames = cuts.map((t) => Math.min(Math.max(0, dur - 0.3), t + 0.6));
  const all = [...even, ...cutFrames].sort((a, b) => a - b);
  const out: number[] = [];
  for (const t of all) if (!out.length || t - out[out.length - 1]! >= 1.0) out.push(t);
  if (out.length <= max) return out;
  return Array.from({ length: max }, (_, i) => out[Math.round((i * (out.length - 1)) / (max - 1))]!);
}

/**
 * Sample frames for OCR and the AI fallback: evenly across the whole timeline (first and last second included —
 * location text and "shown at the end" moments are common there) plus one frame after each scene change, so a
 * montage of five stops yields frames of all five. File names carry the timestamp ("frame-03-12.5s.png").
 */
export async function extractFrames(file: string, outDir: string, max = 16): Promise<string[]> {
  const ff = ffmpegPath(); if (!ff) throw new Error('ffmpeg not available');
  fs.mkdirSync(outDir, { recursive: true });
  const dur = (await probeDuration(ff, file)) ?? 30;
  const times = planFrameTimes(dur, await sceneChanges(file), max);
  const files: string[] = [];
  for (const [i, t] of times.entries()) {
    const out = path.join(outDir, `frame-${String(i).padStart(2, '0')}-${t.toFixed(1)}s.png`);
    const r = await run(ff, ['-y', '-hide_banner', '-loglevel', 'error', '-ss', t.toFixed(2), '-i', file, '-frames:v', '1', '-vf', 'scale=1080:-2', out]);
    if (r.code === 0 && fs.existsSync(out)) files.push(out);
  }
  return files;
}

/** Decode audio to 16 kHz mono float32 PCM (what Whisper expects). Returns null if the file has no audio. */
export async function extractAudioPcm(file: string): Promise<Float32Array | null> {
  const ff = ffmpegPath(); if (!ff) throw new Error('ffmpeg not available');
  const r = await run(ff, ['-hide_banner', '-loglevel', 'error', '-i', file, '-vn', '-ac', '1', '-ar', '16000', '-f', 'f32le', '-t', '180', 'pipe:1'], 180_000);
  if (r.code !== 0 || r.stdout.length < 16000 * 4 * 0.5) return null;
  const buf = r.stdout;
  return new Float32Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + (buf.length - (buf.length % 4))));
}

/** Downscale an image for a paid vision call (cost scales with pixels). */
export async function downscale(file: string, out: string, width = 768): Promise<string> {
  const ff = ffmpegPath(); if (!ff) throw new Error('ffmpeg not available');
  const r = await run(ff, ['-y', '-hide_banner', '-loglevel', 'error', '-i', file, '-vf', `scale='min(${width},iw)':-2`, '-q:v', '4', out]);
  if (r.code !== 0) throw new Error(`downscale failed: ${r.stderr.slice(0, 200)}`);
  return out;
}
