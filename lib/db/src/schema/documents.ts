import {
  pgTable,
  serial,
  text,
  timestamp,
  real,
  jsonb,
  index,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const RESOURCE_SCOPES = ["school", "department", "external", "unknown"] as const;
export type ResourceScope = (typeof RESOURCE_SCOPES)[number];

export const documents = pgTable(
  "documents",
  {
    id: serial("id").primaryKey(),
    filename: text("filename").notNull(),
    title: text("title"),
    fileType: text("file_type").notNull(),
    rawText: text("raw_text"),
    issuingAuthority: text("issuing_authority"),
    policyDomain: text("policy_domain"),
    documentType: text("document_type"),
    audience: text("audience"),
    confidenceScore: real("confidence_score"),
    sourceUrl: text("source_url"),
    resourceScope: text("resource_scope"),
    status: text("status").notNull().default("pending"),
    /**
     * Structured metadata extracted from DET PAL print-all pages.
     * Null for non-PAL documents. Shape: PalDocMetadata (see palCrawler.ts).
     */
    palMetadata: jsonb("pal_metadata"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [
    index("documents_status_idx").on(t.status),
    index("documents_domain_idx").on(t.policyDomain),
    index("documents_resource_scope_idx").on(t.resourceScope),
  ]
);

export const insertDocumentSchema = createInsertSchema(documents).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export type Document = typeof documents.$inferSelect;
export type InsertDocument = z.infer<typeof insertDocumentSchema>;
