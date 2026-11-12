import path from 'node:path';
import fs from 'node:fs';

/**
 * Local OCR with tesseract.js (WASM, no API key, no cost). Language data is downloaded once
 * from the tesseract.js CDN and cached under data/tessdata.
 */
export class Ocr {
  private worker: any = null;
  private langs: string; private cacheDir: string;
  constructor(langs: string, cacheDir: string) { this.langs = langs; this.cacheDir = cacheDir; }

  private async get() {
    if (this.worker) return this.worker;
    const { createWorker } = await import('tesseract.js');
    fs.mkdirSync(this.cacheDir, { recursive: true });
    this.worker = await createWorker(this.langs.split('+'), 1, { cachePath: this.cacheDir, logger: () => {} });
    return this.worker;
  }

  /** Returns cleaned text lines with confidence ≥ minConf. */
  async read(file: string, minConf = 60): Promise<string[]> {
    const w = await this.get();
    const { data } = await w.recognize(file, {}, { blocks: true });
    const lines: string[] = [];
    for (const b of data.blocks ?? []) for (const p of b.paragraphs ?? []) for (const l of p.lines ?? []) {
      const t = String(l.text ?? '').replace(/\s+/g, ' ').trim();
      if (t.length >= 3 && (l.confidence ?? 0) >= minConf && /\p{L}{2,}/u.test(t)) lines.push(t);
    }
    if (!lines.length && data.text && (data.confidence ?? 0) >= minConf) {
      for (const t of String(data.text).split('\n').map((s) => s.trim())) if (t.length >= 3 && /\p{L}{2,}/u.test(t)) lines.push(t);
    }
    return lines;
  }

  /**
   * Reels put white text (captions, location tags) over busy footage, which plain OCR misses. Also read prepared
   * copies that keep only bright pixels as black-on-white text. On a real iPhone screenshot (2026-11-10) the plain
   * pass read only "Add comment..."; the bright-text passes recovered the caption ("40 segundos de …").
   */
  async readEnhanced(file: string, opts: { thorough?: boolean; tmpDir: string }): Promise<string[]> {
    const { ffmpegPath, run } = await import('./ffmpeg.ts');
    const ff = ffmpegPath();
    const filters = opts.thorough
      ? ["format=gray,lutyuv=y='if(gt(val,200),0,255)'", "format=gray,lutyuv=y='if(gt(val,170),0,255)'", 'format=gray,eq=contrast=2.0']
      : ["format=gray,lutyuv=y='if(gt(val,200),0,255)'"];
    const perPass: { lines: string[] }[] = [{ lines: await this.read(file) }];
    if (ff) {
      fs.mkdirSync(opts.tmpDir, { recursive: true });
      for (const [i, vf] of filters.entries()) {
        const out = path.join(opts.tmpDir, `${path.basename(file).replace(/\.\w+$/, '')}.v${i}.png`);
        const r = await run(ff, ['-y', '-loglevel', 'error', '-i', file, '-vf', vf, out]);
        if (r.code === 0 && fs.existsSync(out)) { perPass.push({ lines: await this.read(out) }); fs.rmSync(out, { force: true }); }
      }
    }
    return dedupeLines(perPass);
  }

  async readMany(files: string[]): Promise<{ file: string; lines: string[] }[]> {
    const out: { file: string; lines: string[] }[] = [];
    for (const f of files) out.push({ file: path.basename(f), lines: await this.read(f) });
    return out;
  }

  async close() { if (this.worker) { await this.worker.terminate(); this.worker = null; } }
}

/** Merge OCR lines across frames, dropping near-duplicates (same caption on consecutive frames). */
export function dedupeLines(perFrame: { lines: string[] }[]): string[] {
  const seen = new Set<string>(); const out: string[] = [];
  for (const f of perFrame) for (const l of f.lines) {
    const k = l.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
    if (k.length < 3 || seen.has(k)) continue;
    seen.add(k); out.push(l);
  }
  return out;
}
