import {
  pgTable,
  serial,
  text,
  timestamp,
  integer,
  index,
} from "drizzle-orm/pg-core";
import { customType } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { documents } from "./documents";

const EMBEDDING_DIM = 384;

const vector = customType<{ data: number[]; driverData: string }>({
  dataType() {
    return `vector(${EMBEDDING_DIM})`;
  },
  toDriver(value: number[]): string {
    return `[${value.join(",")}]`;
  },
  fromDriver(value: string): number[] {
    return value
      .replace(/^\[|\]$/g, "")
      .split(",")
      .map(Number);
  },
});

export const wikiPages = pgTable(
  "wiki_pages",
  {
    id: serial("id").primaryKey(),
    documentId: integer("document_id")
      .notNull()
      .references(() => documents.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    slug: text("slug").notNull(),
    markdownContent: text("markdown_content").notNull(),
    summary: text("summary"),
    relatedTopics: text("related_topics").array(),
    embedding: vector("embedding"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [
    index("wiki_document_idx").on(t.documentId),
  ]
);

export const insertWikiPageSchema = createInsertSchema(wikiPages).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export type WikiPage = typeof wikiPages.$inferSelect;
export type InsertWikiPage = z.infer<typeof insertWikiPageSchema>;
