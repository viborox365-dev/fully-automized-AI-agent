/**
 * Kaira — persistent state schema.
 *
 * Everything Kaira knows and does lives here so execution survives
 * process restarts and can be resumed by any driver (worker or API).
 */
import {
  pgTable,
  pgEnum,
  uuid,
  text,
  integer,
  timestamp,
  jsonb,
  index,
} from "drizzle-orm/pg-core";

/* ---------------------------------- enums --------------------------------- */

export const objectiveStatus = pgEnum("objective_status", [
  "pending",
  "active",
  "paused",
  "completed",
  "failed",
  "archived",
]);

export const runStatus = pgEnum("run_status", [
  "queued",
  "planning",
  "running",
  "verifying",
  "completed",
  "failed",
  "stopped",
]);

export const stepKind = pgEnum("step_kind", [
  "plan",
  "thought",
  "action",
  "observation",
  "critic",
  "error",
  "final",
  "note",
]);

export const memoryKind = pgEnum("memory_kind", [
  "fact",
  "procedure",
  "feedback",
  "note",
]);

export const messageRole = pgEnum("message_role", [
  "brandon",
  "kaira",
  "system",
]);

/* --------------------------------- tables --------------------------------- */

/** A goal given to Kaira by her CEO (Brandon). */
export const objectives = pgTable(
  "objectives",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    title: text("title").notNull(),
    description: text("description").notNull().default(""),
    status: objectiveStatus("status").notNull().default("pending"),
    priority: integer("priority").notNull().default(0),
    createdBy: text("created_by").notNull().default("brandon"),
    result: text("result"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [index("objectives_status_idx").on(t.status)],
);

/** One execution attempt of an objective. Resumable; owned by a driver via lock. */
export const runs = pgTable(
  "runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    objectiveId: uuid("objective_id")
      .notNull()
      .references(() => objectives.id, { onDelete: "cascade" }),
    status: runStatus("status").notNull().default("queued"),
    plan: text("plan"),
    result: text("result"),
    error: text("error"),
    modelId: text("model_id").notNull().default(""),
    stepCount: integer("step_count").notNull().default(0),
    maxSteps: integer("max_steps").notNull().default(20),
    tokensIn: integer("tokens_in").notNull().default(0),
    tokensOut: integer("tokens_out").notNull().default(0),
    lockedAt: timestamp("locked_at", { withTimezone: true }),
    lockOwner: text("lock_owner"),
    startedAt: timestamp("started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [index("runs_status_idx").on(t.status), index("runs_objective_idx").on(t.objectiveId)],
);

/** Append-only event log of a run: plans, thoughts, tool calls, results, verdicts. */
export const steps = pgTable(
  "steps",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    runId: uuid("run_id")
      .notNull()
      .references(() => runs.id, { onDelete: "cascade" }),
    seq: integer("seq").notNull(),
    kind: stepKind("kind").notNull(),
    name: text("name"),
    input: jsonb("input"),
    output: jsonb("output"),
    latencyMs: integer("latency_ms"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [index("steps_run_seq_idx").on(t.runId, t.seq)],
);

/** Long-term memory. Keyword retrieval now; embedding column reserved for later. */
export const memories = pgTable(
  "memories",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    kind: memoryKind("kind").notNull().default("note"),
    content: text("content").notNull(),
    tags: text("tags").array().notNull().default([]),
    importance: integer("importance").notNull().default(1),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [index("memories_kind_idx").on(t.kind)],
);

/** Conversation / activity feed between Brandon and Kaira. */
export const messages = pgTable(
  "messages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    role: messageRole("role").notNull(),
    content: text("content").notNull(),
    objectiveId: uuid("objective_id").references(() => objectives.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [index("messages_created_idx").on(t.createdAt)],
);

/** Key-value store for settings and agent runtime state (e.g. worker heartbeat). */
export const kv = pgTable("kv", {
  key: text("key").primaryKey(),
  value: jsonb("value").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

/* ---------------------------------- types --------------------------------- */

export type Objective = typeof objectives.$inferSelect;
export type NewObjective = typeof objectives.$inferInsert;
export type Run = typeof runs.$inferSelect;
export type NewRun = typeof runs.$inferInsert;
export type Step = typeof steps.$inferSelect;
export type NewStep = typeof steps.$inferInsert;
export type Memory = typeof memories.$inferSelect;
export type Message = typeof messages.$inferSelect;
