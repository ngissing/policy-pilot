import { pgTable, serial, text, integer, boolean, timestamp } from "drizzle-orm/pg-core";

export const appSettings = pgTable("app_settings", {
  id: serial("id").primaryKey(),
  responseLength: text("response_length").notNull().default("detailed"),
  responseTone: text("response_tone").notNull().default("formal"),
  maxSources: integer("max_sources").notNull().default(5),
  showFollowUpSuggestions: boolean("show_follow_up_suggestions").notNull().default(true),
  fallbackMessage: text("fallback_message")
    .notNull()
    .default(
      "I couldn't find a policy that covers this — consider uploading relevant documents."
    ),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

export type AppSettings = typeof appSettings.$inferSelect;
