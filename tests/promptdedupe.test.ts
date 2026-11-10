import { describe, expect, test } from "bun:test";
import { stripRestatedPrompt } from "../src/util.js";

describe("stripRestatedPrompt", () => {
  test("removes a prompt quoted back by the model", () => {
    const prompt = "What is 2+2?: - DEBUG_LEVEL=1 CUDA_PATH=/usr/lib/cuda scripts/zig-ai-run -- ./zig-out/bin/engine -p test";
    const thinking = `Responding to user query\n\n${prompt} - Puerta: secuencia\n\nEl resultado es 4`;
    const out = stripRestatedPrompt(thinking, prompt);
    expect(out).not.toContain("DEBUG_LEVEL=1");
    expect(out).toContain("El resultado es 4");
    expect(out).toContain("Responding to user query");
  });

  test("keeps the reasoning when the prompt is not repeated", () => {
    const prompt = "un prompt totalmente distinto que no aparece aqui";
    const thinking = "El build falló por OOM, voy a revisar el log";
    expect(stripRestatedPrompt(thinking, prompt)).toBe(thinking);
  });

  test("is a no-op without a prompt", () => {
    const thinking = "razonamiento normal";
    expect(stripRestatedPrompt(thinking)).toBe(thinking);
  });

  test("handles empty text", () => {
    expect(stripRestatedPrompt("")).toBe("");
  });

  test("does not remove short prompts quoted back", () => {
    const prompt = "hola";
    const thinking = "el usuario dijo hola y eso es todo";
    expect(stripRestatedPrompt(thinking, prompt)).toBe(thinking);
  });
});
