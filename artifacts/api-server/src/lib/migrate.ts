import { pool, db } from "@workspace/db";
import { documentChunks } from "@workspace/db";
import { isNull } from "drizzle-orm";
import { computeEmbedding } from "./embeddings.js";
import { logger } from "./logger.js";

const BACKFILL_BATCH_SIZE = 20;

export async function runMigrations(): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("CREATE EXTENSION IF NOT EXISTS vector;");
    logger.info("pgvector extension ready");

    const { rows: cols } = await client.query<{ data_type: string }>(
      `SELECT data_type
       FROM information_schema.columns
       WHERE table_name = 'document_chunks'
         AND column_name = 'embedding'`
    );

    if (cols.length === 0) {
      logger.info("Adding missing embedding column as vector(384)");
      await client.query(
        "ALTER TABLE document_chunks ADD COLUMN IF NOT EXISTS embedding vector(384) DEFAULT NULL"
      );
    } else if (cols[0].data_type !== "USER-DEFINED") {
      logger.info(
        { current: cols[0].data_type },
        "Migrating embedding column from jsonb to vector(384) — preserving existing values"
      );
      await client.query("BEGIN");
      try {
        await client.query(
          "ALTER TABLE document_chunks ALTER COLUMN embedding DROP DEFAULT"
        );
        await client.query(
          `ALTER TABLE document_chunks
           ALTER COLUMN embedding TYPE vector(384)
           USING CASE
             WHEN embedding IS NULL OR embedding = 'null'::jsonb THEN NULL
             ELSE (
               SELECT string_agg(val::text, ',') FROM jsonb_array_elements_text(embedding) val
             )::text::vector(384)
           END`
        );
        await client.query(
          "ALTER TABLE document_chunks ALTER COLUMN embedding SET DEFAULT NULL"
        );
        await client.query("COMMIT");
        logger.info("embedding column migrated to vector(384) — existing values preserved");
      } catch (err) {
        await client.query("ROLLBACK");
        logger.warn({ err }, "Preserve-migration failed, retrying with NULL cast");
        await client.query("BEGIN");
        try {
          await client.query(
            "ALTER TABLE document_chunks ALTER COLUMN embedding DROP DEFAULT"
          );
          await client.query(
            "ALTER TABLE document_chunks ALTER COLUMN embedding TYPE vector(384) USING NULL::vector(384)"
          );
          await client.query(
            "ALTER TABLE document_chunks ALTER COLUMN embedding SET DEFAULT NULL"
          );
          await client.query("COMMIT");
          logger.info("embedding column migrated to vector(384) via NULL cast (backfill will restore values)");
        } catch (err2) {
          await client.query("ROLLBACK");
          throw err2;
        }
      }
    }

    await client.query(
      `CREATE INDEX IF NOT EXISTS chunks_embedding_cosine_idx
       ON document_chunks USING hnsw (embedding vector_cosine_ops)`
    );
    logger.info("vector index ready");
  } finally {
    client.release();
  }
}

export async function backfillEmbeddings(): Promise<void> {
  const chunksWithoutEmbedding = await db
    .select({
      id: documentChunks.id,
      content: documentChunks.content,
      documentId: documentChunks.documentId,
    })
    .from(documentChunks)
    .where(isNull(documentChunks.embedding));

  const total = chunksWithoutEmbedding.length;
  if (total === 0) {
    return;
  }

  logger.info({ total }, "Starting embedding backfill for existing chunks");

  let succeeded = 0;
  let failed = 0;

  for (let i = 0; i < chunksWithoutEmbedding.length; i += BACKFILL_BATCH_SIZE) {
    const batch = chunksWithoutEmbedding.slice(i, i + BACKFILL_BATCH_SIZE);

    await Promise.allSettled(
      batch.map(async (chunk) => {
        try {
          const embedding = await computeEmbedding(chunk.content);
          const embeddingLiteral = `[${embedding.join(",")}]`;
          await pool.query(
            "UPDATE document_chunks SET embedding = $1::vector WHERE id = $2",
            [embeddingLiteral, chunk.id]
          );
          succeeded++;
        } catch (err) {
          failed++;
          logger.warn({ err, chunkId: chunk.id }, "Failed to backfill embedding for chunk");
        }
      })
    );

    logger.info(
      { processed: Math.min(i + BACKFILL_BATCH_SIZE, total), total, succeeded, failed },
      "Backfill progress"
    );
  }

  logger.info({ total, succeeded, failed }, "Embedding backfill complete");
}
