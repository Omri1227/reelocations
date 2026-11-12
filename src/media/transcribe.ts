/**
 * Optional local speech-to-text with Whisper via @huggingface/transformers (ONNX, runs on CPU, free).
 * Not a hard dependency: if the package is not installed, transcription is reported as "unavailable".
 * Installed as an optionalDependency; first use downloads the Whisper model (~80 MB) to the transformers cache.
 */
export interface Transcript { text: string; segments: { t: number; text: string }[] }
export interface Transcriber { transcribe(pcm16k: Float32Array): Promise<Transcript> }

let cached: Transcriber | null | undefined;

export async function loadTranscriber(model = 'Xenova/whisper-base', language?: string): Promise<Transcriber | null> {
  if (cached !== undefined) return cached;
  try {
    const pkg = '@huggingface/transformers';
    const mod: any = await import(pkg);
    // Hosted: keep the downloaded model on the data volume so redeploys don't fetch it again.
    if (process.env.HF_HOME && mod.env) mod.env.cacheDir = process.env.HF_HOME;
    const asr = await mod.pipeline('automatic-speech-recognition', model, { dtype: 'q8' });
    cached = {
      async transcribe(pcm) {
        // Timestamped chunks let the AI fallback line speech up with frames ("…and this is Fushimi Inari" @ 14 s).
        const r = await asr(pcm, { chunk_length_s: 30, stride_length_s: 5, return_timestamps: true, ...(language ? { language, task: 'transcribe' } : {}) });
        const res = Array.isArray(r) ? r[0] : r;
        const segments = (res?.chunks ?? []).map((c: any) => ({ t: Number(c.timestamp?.[0] ?? 0), text: String(c.text ?? '').trim() })).filter((c: any) => c.text);
        return { text: String(res?.text ?? segments.map((x: any) => x.text).join(' ')).trim(), segments };
      },

    };
  } catch {
    cached = null;
  }
  return cached;
}
