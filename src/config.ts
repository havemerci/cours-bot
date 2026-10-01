import "dotenv/config";
import { z } from "zod";

const booleanFromString = z
  .enum(["true", "false"])
  .default("true")
  .transform((value) => value === "true");

const envSchema = z.object({
  TOKEN: z.string().min(1, "dc token unconfigured"),
  DB_URL: z.url("db_url invalid"),
  DB_KEY: z
    .string()
    .min(1, "db_key unconfigured"),
  PREFIX: z.string().min(1).max(5).default(";"),
  PORT: z.coerce.number().int().min(1).max(65535).default(10_000),
  PRESENCE: booleanFromString,
  REDIS_URL: z.preprocess((value) => value === "" ? undefined : value, z.url().optional()),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  const details = parsed.error.issues
    .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
    .join("\n");
  throw new Error(`Invalid environment configuration:\n${details}`);
}

export const config = parsed.data;
