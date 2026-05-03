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

export const documentChunks = pgTable(
  "document_chunks",
  {
    id: serial("id").primaryKey(),
    documentId: integer("document_id")
      .notNull()
      .references(() => documents.id, { onDelete: "cascade" }),
    chunkIndex: integer("chunk_index").notNull(),
    content: text("content").notNull(),
    embedding: vector("embedding"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [index("chunks_document_idx").on(t.documentId)]
);

export const insertDocumentChunkSchema = createInsertSchema(documentChunks).omit({
  id: true,
  createdAt: true,
});

export type DocumentChunk = typeof documentChunks.$inferSelect;
export type InsertDocumentChunk = z.infer<typeof insertDocumentChunkSchema>;
