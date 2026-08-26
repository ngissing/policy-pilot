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

    // ── app_settings: school profile + AI provider columns ─────────────────
    await client.query(`ALTER TABLE app_settings ADD COLUMN IF NOT EXISTS school_name text`);
    await client.query(`ALTER TABLE app_settings ADD COLUMN IF NOT EXISTS school_type text`);
    await client.query(`ALTER TABLE app_settings ADD COLUMN IF NOT EXISTS school_state text`);
    await client.query(`ALTER TABLE app_settings ADD COLUMN IF NOT EXISTS student_count integer`);
    await client.query(`ALTER TABLE app_settings ADD COLUMN IF NOT EXISTS school_values text`);
    await client.query(`ALTER TABLE app_settings ADD COLUMN IF NOT EXISTS principal_name text`);
    await client.query(`ALTER TABLE app_settings ADD COLUMN IF NOT EXISTS learning_frameworks text`);
    await client.query(`ALTER TABLE app_settings ADD COLUMN IF NOT EXISTS ai_provider text NOT NULL DEFAULT 'cloud'`);
    await client.query(`ALTER TABLE app_settings ADD COLUMN IF NOT EXISTS ollama_base_url text NOT NULL DEFAULT 'http://localhost:11434'`);
    await client.query(`ALTER TABLE app_settings ADD COLUMN IF NOT EXISTS ollama_model text NOT NULL DEFAULT 'llama3.2'`);

    // ── pal_slugs: change-alert tracking columns ───────────────────────────
    await client.query(`ALTER TABLE pal_slugs ADD COLUMN IF NOT EXISTS change_detected_at timestamptz`);
    await client.query(`ALTER TABLE pal_slugs ADD COLUMN IF NOT EXISTS change_acknowledged_at timestamptz`);

    // ── documents: explicit school/department resource scope ─────────────────
    await client.query(`ALTER TABLE documents ADD COLUMN IF NOT EXISTS resource_scope text`);
    await client.query(`CREATE INDEX IF NOT EXISTS documents_resource_scope_idx ON documents (resource_scope)`);
    // Backfill records created before explicit scope existed. This preserves the
    // established authority heuristic for Department Chat while keeping crawler
    // imports out of the school corpus. New/failed AI classifications use the
    // explicit "unknown" value and are not changed by this migration.
    await client.query(`
      UPDATE documents
      SET resource_scope = CASE
        WHEN pal_metadata IS NOT NULL
          OR lower(coalesce(issuing_authority, '')) LIKE ANY (ARRAY[
            '%department%', '%ministry%', '%government%', '%board of education%',
            '%authority%', '%directorate%', '%commission%', '%nsw education%',
            '%vic education%', '%qld education%', '%sa education%',
            '%wa education%', '%tas education%', '%nt education%', '%act education%'
          ])
          OR lower(coalesce(source_url, '')) LIKE ANY (ARRAY[
            '%education.vic.gov.au%', '%vic.gov.au%', '%education.nsw.gov.au%',
            '%nsw.gov.au%', '%education.qld.gov.au%', '%qld.gov.au%',
            '%education.wa.edu.au%', '%wa.gov.au%', '%education.sa.gov.au%',
            '%sa.gov.au%', '%education.tas.gov.au%', '%tas.gov.au%',
            '%education.nt.gov.au%', '%nt.gov.au%', '%education.act.gov.au%', '%act.gov.au%'
          ])
          THEN 'department'
        WHEN coalesce(source_url, '') <> '' THEN 'external'
        ELSE 'school'
      END
      WHERE resource_scope IS NULL
    `);
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
