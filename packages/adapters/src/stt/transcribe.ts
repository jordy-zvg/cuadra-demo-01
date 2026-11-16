/**
 * Voz a texto con la API de transcripción compatible con OpenAI (POST {base}/audio/transcriptions,
 * multipart: file, model, language). La misma forma la aceptan OpenAI y Groq, así que el proveedor
 * se elige con la URL base y el modelo, sin otro código.
 */
export interface TranscriberConfig {
  apiKey: string;
  /** Default OpenAI. Groq: https://api.groq.com/openai/v1 */
  baseUrl?: string;
  /** Default whisper-1 (OpenAI). En Groq: whisper-large-v3-turbo, por ejemplo. */
  model?: string;
  /** Idioma ISO-639-1; ayuda con montos y nombres en español. */
  language?: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

export type Transcribe = (audio: Uint8Array, mime: string) => Promise<string>;

export class TranscriptionError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

const EXT: Record<string, string> = { "audio/ogg": "ogg", "audio/mpeg": "mp3", "audio/mp4": "m4a", "audio/aac": "m4a", "audio/amr": "amr", "audio/wav": "wav", "audio/webm": "webm" };

export function createTranscriber(cfg: TranscriberConfig): Transcribe {
  if (!cfg.apiKey) throw new Error("Falta la llave de transcripción");
  const http = cfg.fetch ?? fetch;
  const url = `${(cfg.baseUrl ?? "https://api.openai.com/v1").replace(/\/+$/, "")}/audio/transcriptions`;
  return async (audio, mime) => {
    const type = mime.split(";")[0]!.trim().toLowerCase();
    const form = new FormData();
    // El servicio adivina el formato por la extensión; las notas de voz de WhatsApp son ogg/opus.
    form.append("file", new Blob([audio], { type }), `nota.${EXT[type] ?? "ogg"}`);
    form.append("model", cfg.model ?? "whisper-1");
    form.append("language", cfg.language ?? "es");
    const res = await http(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${cfg.apiKey}` },
      body: form,
      signal: AbortSignal.timeout(cfg.timeoutMs ?? 30_000),
    });
    const json = (await res.json().catch(() => null)) as { text?: string; error?: { message?: string } } | null;
    if (!res.ok || typeof json?.text !== "string") throw new TranscriptionError(res.status, json?.error?.message ?? `Transcripción ${res.status}`);
    return json.text.trim();
  };
}
