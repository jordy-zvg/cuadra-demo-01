import { describe, expect, it } from "vitest";
import { TranscriptionError, createTranscriber } from "../src/index.js";

function fake(res: Response) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fn = (async (url: string | URL, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return res;
  }) as typeof fetch;
  return { fn, calls };
}

describe("createTranscriber", () => {
  it("manda el audio como multipart con modelo e idioma, y devuelve el texto", async () => {
    const f = fake(new Response(JSON.stringify({ text: " Doña Lupe se llevó 185 pesos " }), { status: 200 }));
    const t = createTranscriber({ apiKey: "k", fetch: f.fn });
    expect(await t(new Uint8Array([1, 2]), "audio/ogg; codecs=opus")).toBe("Doña Lupe se llevó 185 pesos");
    expect(f.calls[0]!.url).toBe("https://api.openai.com/v1/audio/transcriptions");
    expect((f.calls[0]!.init.headers as Record<string, string>).Authorization).toBe("Bearer k");
    const form = f.calls[0]!.init.body as FormData;
    expect(form.get("model")).toBe("whisper-1");
    expect(form.get("language")).toBe("es");
    expect((form.get("file") as File).name).toBe("nota.ogg");
  });

  it("otro proveedor compatible: URL base y modelo propios", async () => {
    const f = fake(new Response(JSON.stringify({ text: "hola" }), { status: 200 }));
    await createTranscriber({ apiKey: "k", baseUrl: "https://api.groq.com/openai/v1/", model: "whisper-large-v3-turbo", fetch: f.fn })(new Uint8Array([1]), "audio/mpeg");
    expect(f.calls[0]!.url).toBe("https://api.groq.com/openai/v1/audio/transcriptions");
    const form = f.calls[0]!.init.body as FormData;
    expect(form.get("model")).toBe("whisper-large-v3-turbo");
    expect((form.get("file") as File).name).toBe("nota.mp3");
  });

  it("propaga el error del servicio", async () => {
    const f = fake(new Response(JSON.stringify({ error: { message: "Invalid API key" } }), { status: 401 }));
    const e = await createTranscriber({ apiKey: "mala", fetch: f.fn })(new Uint8Array([1]), "audio/ogg").catch((x: unknown) => x);
    expect(e).toBeInstanceOf(TranscriptionError);
    expect((e as TranscriptionError).status).toBe(401);
  });
});
