import { z } from "zod";

const schema = z.object({
  TELEGRAM_BOT_TOKEN: z.string().min(10, "TELEGRAM_BOT_TOKEN is required"),
  OPENCODE_BASE_URL: z.string().url().default("http://127.0.0.1:49374"),
  OPENCODE_DIRECTORY: z.string().optional(),
  REPOS_DIRECTORY: z.string().optional(),
  REPOS_DIR: z.string().optional(),
  REPOSITORIES_DIRECTORY: z.string().optional(),
  REPOSITORIES_DIR: z.string().optional(),
  PROJECTS_DIRECTORY: z.string().optional(),
  PROJECTS_DIR: z.string().optional(),
  OPENCODE_REPOS_DIRECTORY: z.string().optional(),
  OPENCODE_REPOS_DIR: z.string().optional(),
  ADMIN_TELEGRAM_USER_ID: z.coerce.number().int().positive().optional(),
  ALLOWED_TELEGRAM_USER_IDS: z.string().optional(),
  PILOT_PROJECT: z.string().optional(),
  LOG_LEVEL: z.enum(["trace", "debug", "info", "warn", "error"]).default("info"),
  DEBUG: z.string().optional(),
  OPS_PORT: z.coerce.number().int().positive().default(9090),
  OPS_HOST: z.string().default("127.0.0.1"),
  DISK_GUARD_MIN_FREE_MB: z.coerce.number().int().positive().default(2048),
  AUTO_RETRY_ENABLED: z.string().optional().default("true").transform((v) => v === "true" || v === "1"),
  AUTO_RETRY_MAX_ATTEMPTS: z.coerce.number().int().min(0).default(3),
  AUTO_RETRY_MAX_AGE_MS: z.coerce.number().int().positive().default(1800000),
  RETRY_BACKOFF_BASE_MS: z.coerce.number().int().positive().default(60000),
  RETRY_BACKOFF_MAX_MS: z.coerce.number().int().positive().default(900000),
  RETRY_BACKOFF_FACTOR: z.coerce.number().positive().default(2),
  AUTO_CLEANUP_DAYS: z.coerce.number().int().min(0).default(0),
  DISK_GUARD_PATH: z.string().optional(),
  WEBHOOK_MODE: z.string().optional().default("false").transform((v) => v === "true" || v === "1"),
  WEBHOOK_URL: z.string().url().optional(),
  WEBHOOK_SECRET: z.string().optional(),
  WEBHOOK_PORT: z.coerce.number().int().positive().default(8443),
  WEBHOOK_PATH: z.string().default("/telegram/webhook"),
  AGENT_BACKEND: z.enum(["opencode", "opencodex"]).default("opencode"),
  OPENCODEX_BASE_URL: z.string().url().optional(),
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
  const data = parsed.data as Config;
  if (!data.REPOS_DIRECTORY) {
    data.REPOS_DIRECTORY =
      data.REPOS_DIR ??
      data.REPOSITORIES_DIRECTORY ??
      data.REPOSITORIES_DIR ??
      data.PROJECTS_DIRECTORY ??
      data.PROJECTS_DIR ??
      data.OPENCODE_REPOS_DIRECTORY ??
      data.OPENCODE_REPOS_DIR;
  }
  return data;
}

export function getReposDirectory(config: Partial<Config> | Record<string, unknown> | undefined): string | undefined {
  if (!config) return undefined;
  const c = config as Record<string, unknown>;
  return (
    (c.REPOS_DIRECTORY as string | undefined) ??
    (c.REPOS_DIR as string | undefined) ??
    (c.REPOSITORIES_DIRECTORY as string | undefined) ??
    (c.REPOSITORIES_DIR as string | undefined) ??
    (c.PROJECTS_DIRECTORY as string | undefined) ??
    (c.PROJECTS_DIR as string | undefined) ??
    (c.OPENCODE_REPOS_DIRECTORY as string | undefined) ??
    (c.OPENCODE_REPOS_DIR as string | undefined)
  );
}