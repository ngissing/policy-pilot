import {
  pgTable,
  serial,
  text,
  timestamp,
  integer,
  index,
} from "drizzle-orm/pg-core";
import { customType } from "drizzle-orm/pg-core";
import { documents } from "./documents";
import { wikiPages } from "./wikiPages";

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

export const wikiSections = pgTable(
  "wiki_sections",
  {
    id: serial("id").primaryKey(),
    wikiPageId: integer("wiki_page_id")
      .notNull()
      .references(() => wikiPages.id, { onDelete: "cascade" }),
    documentId: integer("document_id")
      .notNull()
      .references(() => documents.id, { onDelete: "cascade" }),
    heading: text("heading").notNull(),
    content: text("content").notNull(),
    embedding: vector("embedding"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [
    index("wiki_section_wiki_idx").on(t.wikiPageId),
    index("wiki_section_doc_idx").on(t.documentId),
  ]
);

export type WikiSection = typeof wikiSections.$inferSelect;
