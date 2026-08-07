import { pgTable, serial, text, integer, boolean, timestamp } from "drizzle-orm/pg-core";

export const appSettings = pgTable("app_settings", {
  id: serial("id").primaryKey(),
  // Chat behaviour
  responseLength: text("response_length").notNull().default("detailed"),
  responseTone: text("response_tone").notNull().default("formal"),
  maxSources: integer("max_sources").notNull().default(5),
  showFollowUpSuggestions: boolean("show_follow_up_suggestions").notNull().default(true),
  fallbackMessage: text("fallback_message")
    .notNull()
    .default(
      "I couldn't find a policy that covers this — consider uploading relevant documents."
    ),
  // School profile — used by the Policy Drafter when school context is requested
  schoolName: text("school_name"),
  schoolType: text("school_type"),         // primary | secondary | p12 | other
  schoolState: text("school_state"),       // VIC | NSW | QLD | SA | WA | TAS | NT | ACT
  studentCount: integer("student_count"),
  schoolValues: text("school_values"),
  principalName: text("principal_name"),
  learningFrameworks: text("learning_frameworks"),
  // AI provider
  aiProvider: text("ai_provider").notNull().default("cloud"), // cloud | offline
  ollamaBaseUrl: text("ollama_base_url").notNull().default("http://localhost:11434"),
  ollamaModel: text("ollama_model").notNull().default("llama3.2"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

export type AppSettings = typeof appSettings.$inferSelect;
