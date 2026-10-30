import { z } from "zod";

const schema = z.object({
  TELEGRAM_BOT_TOKEN: z.string().min(10, "TELEGRAM_BOT_TOKEN is required"),
  OPENCODE_BASE_URL: z.string().url().default("http://127.0.0.1:49374"),
  OPENCODE_DIRECTORY: z.string().optional(),
  ADMIN_TELEGRAM_USER_ID: z.coerce.number().int().positive().optional(),
  PILOT_PROJECT: z.string().optional(),
  LOG_LEVEL: z.enum(["trace", "debug", "info", "warn", "error"]).default("info"),
  OPS_PORT: z.coerce.number().int().positive().default(9090),
  OPS_HOST: z.string().default("127.0.0.1"),
  DISK_GUARD_MIN_FREE_MB: z.coerce.number().int().positive().default(2048),
  DISK_GUARD_PATH: z.string().optional(),
  VOICE_TRANSCRIBER: z.string().optional(),
  VOICE_TRANSCRIBER_ARGS: z.string().optional(),
  VOICE_TRANSCRIPTION_LANGUAGE: z.string().optional(),
  VOICE_TRANSCRIPTION_TIMEOUT_MS: z.coerce.number().int().positive().default(120000),
  VOICE_ATTACH_AUDIO: z.string().optional().default("false").transform((v) => v === "true" || v === "1"),
});

export type Config = z.infer<typeof schema>;

export function loadConfig(): Config {
  const parsed = schema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("\n");
    throw new Error(`Invalid configuration:\n${issues}`);
  }
  return parsed.data;
}