import type Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";
import { ClaudeImageReader, MAX_PHOTO_LINES, imageMime } from "../src/index.js";

const fake = (resp: unknown, calls: unknown[] = []) =>
  ({ beta: { messages: { parse: async (req: unknown) => (calls.push(req), resp) } } }) as unknown as Anthropic;

describe("ClaudeImageReader", () => {
  it("manda la imagen en base64 y devuelve las líneas limpias, máximo 10", async () => {
    const calls: Array<{ messages: Array<{ content: Array<{ type: string; source?: { media_type: string; data: string } }> }> }> = [];
    const lines = ["  Doña Lupe se llevó $185 ", "", "Beto   se llevó $40", ...Array.from({ length: 12 }, (_, i) => `Cliente ${i} se llevó $1`)];
    const r = await new ClaudeImageReader({ client: fake({ stop_reason: "end_turn", parsed_output: { lines } }, calls) }).read(new Uint8Array([1, 2, 3]), "image/jpeg");
    expect(r[0]).toBe("Doña Lupe se llevó $185");
    expect(r[1]).toBe("Beto se llevó $40");
    expect(r).toHaveLength(MAX_PHOTO_LINES);
    const img = calls[0]!.messages[0]!.content[0]!;
    expect(img.type).toBe("image");
    expect(img.source).toEqual({ type: "base64", media_type: "image/jpeg", data: Buffer.from([1, 2, 3]).toString("base64") });
  });

  it("si el modelo declina o el formato no es imagen, no hay líneas", async () => {
    const calls: unknown[] = [];
    expect(await new ClaudeImageReader({ client: fake({ stop_reason: "refusal", parsed_output: null }) }).read(new Uint8Array([1]), "image/png")).toEqual([]);
    expect(await new ClaudeImageReader({ client: fake({}, calls) }).read(new Uint8Array([1]), "application/pdf")).toEqual([]);
    expect(calls).toHaveLength(0);
  });

  it("imageMime acepta solo los formatos que lee el modelo", () => {
    expect(imageMime("image/jpeg")).toBe("image/jpeg");
    expect(imageMime("IMAGE/PNG; q=1")).toBe("image/png");
    expect(imageMime("image/heic")).toBeNull();
  });
});
