import { Router } from "express";
import multer from "multer";
import { db } from "@workspace/db";
import { documents, documentChunks, wikiPages } from "@workspace/db";
import { and, eq, ilike, isNull, isNotNull, lt, or, desc, count } from "drizzle-orm";
import { parseFile, getFileType, chunkText } from "../lib/fileParser.js";
import { autoTagDocument } from "../lib/rag.js";
import { upsertWikiPage } from "../lib/wiki.js";
import { computeEmbedding } from "../lib/embeddings.js";
import { logger } from "../lib/logger.js";
import { requireAuth } from "../middlewares/requireAuth.js";

const router = Router();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024, files: 20 },
});

router.use(requireAuth);

// In-memory wiki regeneration job state (single concurrent job)
interface RegenJob {
  running: boolean;
  total: number;
  done: number;
  errors: number;
  startedAt: Date | null;
  finishedAt: Date | null;
}
const regenJob: RegenJob = {
  running: false,
  total: 0,
  done: 0,
  errors: 0,
  startedAt: null,
  finishedAt: null,
};

const PAGE_SIZE_DEFAULT = 25;
const PAGE_SIZE_MAX = 100;

router.get("/", async (req, res) => {
  try {
    const query = req.query;
    const domain = typeof query.domain === "string" ? query.domain : undefined;
    const documentType = typeof query.documentType === "string" ? query.documentType : undefined;
    const audience = typeof query.audience === "string" ? query.audience : undefined;
    const status = typeof query.status === "string" ? query.status : undefined;
    const search = typeof query.search === "string" ? query.search : undefined;

    const rawPage = parseInt(typeof query.page === "string" ? query.page : "1", 10);
    const rawLimit = parseInt(typeof query.limit === "string" ? query.limit : String(PAGE_SIZE_DEFAULT), 10);
    const page = isNaN(rawPage) || rawPage < 1 ? 1 : rawPage;
    const pageSize = isNaN(rawLimit) || rawLimit < 1 ? PAGE_SIZE_DEFAULT : Math.min(rawLimit, PAGE_SIZE_MAX);

    // Build all filters as SQL — never fetch the full table into Node memory
    const whereCondition = and(
      domain ? eq(documents.policyDomain, domain) : undefined,
      documentType ? eq(documents.documentType, documentType) : undefined,
      audience ? eq(documents.audience, audience) : undefined,
      status ? eq(documents.status, status) : undefined,
      search
        ? or(
            ilike(documents.filename, `%${search}%`),
            ilike(documents.title, `%${search}%`),
            ilike(documents.issuingAuthority, `%${search}%`)
          )
        : undefined
    );

    const selectedFields = {
      id: documents.id,
      filename: documents.filename,
      title: documents.title,
      fileType: documents.fileType,
      issuingAuthority: documents.issuingAuthority,
      policyDomain: documents.policyDomain,
      documentType: documents.documentType,
      audience: documents.audience,
      confidenceScore: documents.confidenceScore,
      sourceUrl: documents.sourceUrl,
      status: documents.status,
      createdAt: documents.createdAt,
      updatedAt: documents.updatedAt,
    };

    // Run count and paginated data fetch in parallel
    const [countResult, rows] = await Promise.all([
      db.select({ total: count() }).from(documents).where(whereCondition),
      db
        .select(selectedFields)
        .from(documents)
        .where(whereCondition)
        .orderBy(desc(documents.createdAt))
        .limit(pageSize)
        .offset((page - 1) * pageSize),
    ]);

    res.json({ data: rows, total: countResult[0]?.total ?? 0, page, pageSize });
  } catch (err) {
    logger.error(err, "Error listing documents");
    res.status(500).json({ error: "Failed to list documents" });
  }
});

const REVIEW_CONFIDENCE_THRESHOLD = 0.75;

router.get("/review-queue", async (req, res) => {
  try {
    const rows = await db
      .select({
        id: documents.id,
        filename: documents.filename,
        title: documents.title,
        fileType: documents.fileType,
        issuingAuthority: documents.issuingAuthority,
        policyDomain: documents.policyDomain,
        documentType: documents.documentType,
        audience: documents.audience,
        confidenceScore: documents.confidenceScore,
        status: documents.status,
        createdAt: documents.createdAt,
        updatedAt: documents.updatedAt,
      })
      .from(documents)
      .where(
        and(
          eq(documents.status, "pending"),
          or(
            lt(documents.confidenceScore, REVIEW_CONFIDENCE_THRESHOLD),
            isNull(documents.confidenceScore)
          )
        )
      )
      .orderBy(desc(documents.createdAt));

    res.json(rows);
  } catch (err) {
    logger.error(err, "Error fetching review queue");
    res.status(500).json({ error: "Failed to fetch review queue" });
  }
});

async function processUploadedFile(file: Express.Multer.File): Promise<{
  id: number;
  filename: string;
  status: string;
  message: string;
}> {
  const fileType = getFileType(file.mimetype, file.originalname);
  if (fileType === "unknown") {
    throw new Error(`Unsupported file type for ${file.originalname}. Upload PDF, DOCX, or TXT.`);
  }

  const rawText = await parseFile(file.buffer, file.mimetype, file.originalname);

  const [doc] = await db
    .insert(documents)
    .values({
      filename: file.originalname,
      fileType,
      rawText,
      status: "processing",
    })
    .returning();

  setImmediate(async () => {
    try {
      // Auto-tag and wiki generation in parallel
      const [tags] = await Promise.all([
        autoTagDocument(rawText),
      ]);

      const newStatus =
        tags.confidenceScore >= REVIEW_CONFIDENCE_THRESHOLD ? "approved" : "pending";

      await db
        .update(documents)
        .set({
          title: tags.title,
          issuingAuthority: tags.issuingAuthority,
          policyDomain: tags.policyDomain,
          documentType: tags.documentType,
          audience: tags.audience,
          confidenceScore: tags.confidenceScore,
          status: newStatus,
          updatedAt: new Date(),
        })
        .where(eq(documents.id, doc.id));

      // Chunk + embed + wiki in parallel
      const chunks = chunkText(rawText);
      await Promise.all([
        // Chunk embeddings
        (async () => {
          if (chunks.length > 0) {
            const embeddings = await Promise.all(chunks.map((c) => computeEmbedding(c)));
            await db.insert(documentChunks).values(
              chunks.map((content, idx) => ({
                documentId: doc.id,
                chunkIndex: idx,
                content,
                embedding: embeddings[idx],
              }))
            );
          }
        })(),
        // Wiki page generation
        upsertWikiPage(doc.id, rawText).catch((err) => {
          logger.warn({ err, docId: doc.id }, "Wiki generation failed (non-fatal)");
        }),
      ]);

      logger.info(
        { docId: doc.id, status: newStatus, confidence: tags.confidenceScore, chunks: chunks.length },
        "Document tagged and indexed"
      );
    } catch (err) {
      logger.error(err, "Error during AI tagging");
      await db
        .update(documents)
        .set({ status: "pending", updatedAt: new Date() })
        .where(eq(documents.id, doc.id));
    }
  });

  return {
    id: doc.id,
    filename: doc.filename,
    status: doc.status,
    message: "Document uploaded. AI tagging and wiki generation in progress.",
  };
}

router.post("/upload", upload.array("files", 20), async (req, res) => {
  try {
    const uploadedFiles = req.files as Express.Multer.File[] | undefined;
    if (!uploadedFiles || uploadedFiles.length === 0) {
      res.status(400).json({ error: "No files uploaded. Send files under the 'files' field." });
      return;
    }

    const results: Array<{ id: number; filename: string; status: string; message: string }> = [];
    const errors: Array<{ filename: string; error: string }> = [];

    for (const file of uploadedFiles) {
      try {
        const result = await processUploadedFile(file);
        results.push(result);
      } catch (err) {
        const message = err instanceof Error ? err.message : "Processing failed";
        errors.push({ filename: file.originalname, error: message });
      }
    }

    if (results.length === 0) {
      res.status(400).json({ error: errors[0]?.error ?? "All files failed to upload", errors });
      return;
    }

    res.status(202).json({ results, errors });
  } catch (err) {
    logger.error(err, "Upload failed");
    res.status(500).json({ error: "Upload failed" });
  }
});

// GET /api/documents/wiki-regen-status — poll bulk wiki regen progress
router.get("/wiki-regen-status", (_req, res) => {
  res.json({ ...regenJob });
});

// POST /api/documents/regenerate-all-wikis — regenerate wiki for documents missing one
router.post("/regenerate-all-wikis", async (_req, res) => {
  if (regenJob.running) {
    res.status(409).json({ error: "A regeneration job is already running.", ...regenJob });
    return;
  }

  try {
    // Only select documents that have no wiki page yet (or an empty one).
    // Documents that already have a valid wiki page are skipped so a re-run
    // after a partial completion only processes the remainder, not the full set.
    const allDocs = await db
      .select({ id: documents.id, rawText: documents.rawText })
      .from(documents)
      .leftJoin(wikiPages, eq(wikiPages.documentId, documents.id))
      .where(
        and(
          isNotNull(documents.rawText),
          or(
            isNull(wikiPages.id),
            isNull(wikiPages.markdownContent),
            eq(wikiPages.markdownContent, "")
          )
        )
      );

    const eligible = allDocs.filter((d) => d.rawText && d.rawText.length > 0);

    regenJob.running = true;
    regenJob.total = eligible.length;
    regenJob.done = 0;
    regenJob.errors = 0;
    regenJob.startedAt = new Date();
    regenJob.finishedAt = null;

    res.status(202).json({ message: "Wiki regeneration started", total: eligible.length });

    // Process in batches of 3 to stay within rate limits
    setImmediate(async () => {
      const BATCH = 3;
      for (let i = 0; i < eligible.length; i += BATCH) {
        const batch = eligible.slice(i, i + BATCH);
        await Promise.all(
          batch.map(async (doc) => {
            try {
              await upsertWikiPage(doc.id, doc.rawText!);
              regenJob.done++;
            } catch (err) {
              logger.warn({ err, docId: doc.id }, "Wiki regen failed for document");
              regenJob.errors++;
            }
          })
        );
      }
      regenJob.running = false;
      regenJob.finishedAt = new Date();
      logger.info(
        { total: regenJob.total, done: regenJob.done, errors: regenJob.errors },
        "Bulk wiki regeneration complete"
      );
    });
  } catch (err) {
    regenJob.running = false;
    logger.error(err, "Failed to start wiki regeneration");
    res.status(500).json({ error: "Failed to start wiki regeneration" });
  }
});

// GET /api/documents/:id/wiki — return the wiki page for a document
router.get("/:id/wiki", async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) { res.status(400).json({ error: "Invalid document id" }); return; }

    const [wiki] = await db
      .select()
      .from(wikiPages)
      .where(eq(wikiPages.documentId, id));

    if (!wiki) {
      res.status(404).json({ error: "Wiki page not found. The document may still be processing." });
      return;
    }

    const { embedding: _emb, ...rest } = wiki;
    res.json(rest);
  } catch (err) {
    logger.error(err, "Error fetching wiki page");
    res.status(500).json({ error: "Failed to fetch wiki page" });
  }
});

// POST /api/documents/:id/reprocess — regenerate wiki + chunks for a document
router.post("/:id/reprocess", async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) { res.status(400).json({ error: "Invalid document id" }); return; }

    const [doc] = await db
      .select({ id: documents.id, rawText: documents.rawText, status: documents.status })
      .from(documents)
      .where(eq(documents.id, id));

    if (!doc) { res.status(404).json({ error: "Document not found" }); return; }
    if (!doc.rawText) { res.status(400).json({ error: "No raw text available to reprocess" }); return; }

    // Mark as processing
    await db.update(documents).set({ status: "processing", updatedAt: new Date() }).where(eq(documents.id, id));

    res.status(202).json({ message: "Reprocessing started" });

    setImmediate(async () => {
      try {
        const rawText = doc.rawText!;

        // Run auto-tagging, chunk regeneration, and wiki regeneration in parallel.
        // Chunk regeneration must delete before re-inserting (sequential internally),
        // but is independent of tagging and wiki generation.
        const [tags] = await Promise.all([
          autoTagDocument(rawText),
          (async () => {
            await db.delete(documentChunks).where(eq(documentChunks.documentId, id));
            const chunks = chunkText(rawText);
            if (chunks.length > 0) {
              const embeddings = await Promise.all(chunks.map((c) => computeEmbedding(c)));
              await db.insert(documentChunks).values(
                chunks.map((content, idx) => ({
                  documentId: id,
                  chunkIndex: idx,
                  content,
                  embedding: embeddings[idx],
                }))
              );
            }
          })(),
          upsertWikiPage(id, rawText),
        ]);

        // Set status based on the fresh confidence score — never force-approve
        const newStatus =
          (tags.confidenceScore ?? 0) >= REVIEW_CONFIDENCE_THRESHOLD ? "approved" : "pending";

        await db
          .update(documents)
          .set({
            title: tags.title,
            issuingAuthority: tags.issuingAuthority,
            policyDomain: tags.policyDomain,
            documentType: tags.documentType,
            audience: tags.audience,
            confidenceScore: tags.confidenceScore,
            status: newStatus,
            updatedAt: new Date(),
          })
          .where(eq(documents.id, id));

        logger.info({ docId: id, status: newStatus, confidence: tags.confidenceScore }, "Document reprocessed");
      } catch (err) {
        logger.error(err, "Error during reprocessing");
        await db.update(documents).set({ status: "pending", updatedAt: new Date() }).where(eq(documents.id, id));
      }
    });
  } catch (err) {
    logger.error(err, "Error starting reprocess");
    res.status(500).json({ error: "Failed to start reprocessing" });
  }
});

router.get("/:id/download", async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) { res.status(400).json({ error: "Invalid document id" }); return; }

    const [doc] = await db
      .select({
        filename: documents.filename,
        fileType: documents.fileType,
        rawText: documents.rawText,
        sourceUrl: documents.sourceUrl,
      })
      .from(documents)
      .where(eq(documents.id, id));

    if (!doc) { res.status(404).json({ error: "Document not found" }); return; }

    if (doc.sourceUrl) {
      res.redirect(302, doc.sourceUrl);
      return;
    }

    if (!doc.rawText) { res.status(404).json({ error: "No content available for download" }); return; }

    const base = doc.filename.replace(/\.[^.]+$/, "");
    const downloadName = doc.fileType === "txt" ? doc.filename : `${base}.txt`;
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="${downloadName}"`);
    res.send(doc.rawText);
  } catch (err) {
    logger.error(err, "Error downloading document");
    res.status(500).json({ error: "Failed to download document" });
  }
});

router.get("/:id", async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) {
      res.status(400).json({ error: "Invalid document id" });
      return;
    }
    const [doc] = await db.select().from(documents).where(eq(documents.id, id));
    if (!doc) {
      res.status(404).json({ error: "Document not found" });
      return;
    }
    const { rawText: _raw, ...rest } = doc;
    res.json(rest);
  } catch (err) {
    logger.error(err, "Error fetching document");
    res.status(500).json({ error: "Failed to fetch document" });
  }
});

router.patch("/:id", async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) {
      res.status(400).json({ error: "Invalid document id" });
      return;
    }
    const body: Record<string, unknown> =
      typeof req.body === "object" && req.body !== null ? req.body : {};

    const allowedFields = [
      "title",
      "issuingAuthority",
      "policyDomain",
      "documentType",
      "audience",
      "status",
    ] as const;

    const updates: Partial<typeof documents.$inferInsert> = {};
    for (const field of allowedFields) {
      if (field in body && (typeof body[field] === "string" || body[field] === null)) {
        (updates as Record<string, unknown>)[field] = body[field];
      }
    }

    const [doc] = await db
      .update(documents)
      .set({ ...updates, updatedAt: new Date() })
      .where(eq(documents.id, id))
      .returning();

    if (!doc) {
      res.status(404).json({ error: "Document not found" });
      return;
    }
    const { rawText: _raw, ...rest } = doc;
    res.json(rest);
  } catch (err) {
    logger.error(err, "Error updating document");
    res.status(500).json({ error: "Failed to update document" });
  }
});

router.delete("/:id", async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) {
      res.status(400).json({ error: "Invalid document id" });
      return;
    }
    await db.delete(documents).where(eq(documents.id, id));
    res.status(204).send();
  } catch (err) {
    logger.error(err, "Error deleting document");
    res.status(500).json({ error: "Failed to delete document" });
  }
});

export default router;
