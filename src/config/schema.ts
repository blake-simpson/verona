/**
 * Zod schemas for Verona's TOML config files.
 *
 * Loaders parse TOML, then validate via these schemas. Failure throws a
 * ConfigError with a path-pointing message.
 */

import { z } from "zod";

// -----------------------------------------------------------------------------
// Common
// -----------------------------------------------------------------------------

export const EffortSchema = z.enum(["low", "medium", "high", "max"]);

export const AdapterIdSchema = z.enum(["claude-cli", "anthropic-api", "openai", "openrouter"]);

const AgentNameSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z][a-z0-9-]*$/, "must be kebab-case starting with a letter");

const TaskIdSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z][a-z0-9-]*$/, "must be kebab-case starting with a letter");

// -----------------------------------------------------------------------------
// agent.toml
// -----------------------------------------------------------------------------

const TaskTriggerScheduleSchema = z.object({
  /** cron expression OR human-readable like "every 30m" (croner-compatible). */
  schedule: z.string().min(1),
});

const TaskTriggerMessageSchema = z.object({
  /** Fire when an inbound message routes to this agent. */
  on_message: z.literal(true),
});

export const TaskSchema = z
  .object({
    id: TaskIdSchema,
    prompt: z.string().min(1, "task prompt path is required"),
    effort: EffortSchema.optional(),
    budget_usd: z.number().positive().optional(),
    allowed_tools: z.array(z.string()).optional(),
    schedule: z.string().optional(),
    on_message: z.boolean().optional(),
  })
  .refine(
    (t) => Boolean(t.schedule) || Boolean(t.on_message),
    "task must declare at least one trigger: schedule, on_message, or both",
  );

export const AgentConfigSchema = z.object({
  agent: z.object({
    name: AgentNameSchema,
    description: z.string().optional(),
    adapter: AdapterIdSchema.default("claude-cli"),
    default_effort: EffortSchema.default("medium"),
  }),
  soul: z
    .object({
      file: z.string().default("./SOUL.md"),
    })
    .default({ file: "./SOUL.md" }),
  memory: z
    .object({
      index: z.string().default("./memory/INDEX.md"),
      self_learning: z.boolean().default(true),
      episodic_retention_days: z.number().int().positive().default(30),
      working_retention_days: z.number().int().positive().default(3),
    })
    .default({
      index: "./memory/INDEX.md",
      self_learning: true,
      episodic_retention_days: 30,
      working_retention_days: 3,
    }),
  connectors: z.record(z.string(), z.unknown()).default({}),
  tasks: z.array(TaskSchema).default([]),
});

export type AgentConfig = z.infer<typeof AgentConfigSchema>;
export type Task = z.infer<typeof TaskSchema>;

// -----------------------------------------------------------------------------
// verona.toml (daemon-level config, lives in state dir)
// -----------------------------------------------------------------------------

export const VeronaConfigSchema = z.object({
  daemon: z
    .object({
      log_level: z.enum(["error", "warn", "info", "debug"]).default("info"),
      /** Inbound HTTP listener for webhook connector. 0 = disabled. */
      webhook_listen_port: z.number().int().nonnegative().max(65535).default(0),
    })
    .default({ log_level: "info", webhook_listen_port: 0 }),
  adapters: z
    .object({
      /** Per-adapter effort → model overrides. Inner record is implicitly sparse. */
      effort_mapping: z.record(AdapterIdSchema, z.record(EffortSchema, z.string())).default({}),
    })
    .default({ effort_mapping: {} }),
  cost_tracker: z
    .object({
      rollup_interval_seconds: z.number().int().positive().default(300),
      rotate_invocations_at_mb: z.number().positive().default(50),
    })
    .default({ rollup_interval_seconds: 300, rotate_invocations_at_mb: 50 }),
});

export type VeronaConfig = z.infer<typeof VeronaConfigSchema>;
