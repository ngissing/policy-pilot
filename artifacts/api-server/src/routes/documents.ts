import { Router } from "express";
import multer from "multer";
import { db } from "@workspace/db";
import { documents, documentChunks } from "@workspace/db";
import { eq, lt, desc } from "drizzle-orm";
import { parseFile, getFileType, chunkText } from "../lib/fileParser.js";
import { autoTagDocument } from "../lib/rag.js";
import { computeEmbedding } from "../lib/embeddings.js";
import { logger } from "../lib/logger.js";
import { requireAuth } from "../middlewares/requireAuth.js";

const router = Router();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024, files: 20 },
});

router.use(requireAuth);

router.get("/", async (req, res) => {
  try {
    const query = req.query;
    const domain = typeof query.domain === "string" ? query.domain : undefined;
    const documentType = typeof query.documentType === "string" ? query.documentType : undefined;
    const audience = typeof query.audience === "string" ? query.audience : undefined;
    const status = typeof query.status === "string" ? query.status : undefined;
    const search = typeof query.search === "string" ? query.search : undefined;

    let rows = await db
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
      .orderBy(desc(documents.createdAt));

    if (domain) rows = rows.filter((r) => r.policyDomain === domain);
    if (documentType) rows = rows.filter((r) => r.documentType === documentType);
    if (audience) rows = rows.filter((r) => r.audience === audience);
    if (status) rows = rows.filter((r) => r.status === status);
    if (search) {
      const q = search.toLowerCase();
      rows = rows.filter(
        (r) =>
          r.filename.toLowerCase().includes(q) ||
          (r.title ?? "").toLowerCase().includes(q) ||
          (r.issuingAuthority ?? "").toLowerCase().includes(q)
      );
    }

    res.json(rows);
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
      .where(lt(documents.confidenceScore, REVIEW_CONFIDENCE_THRESHOLD))
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
      const tags = await autoTagDocument(rawText);
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

      const chunks = chunkText(rawText);
      if (chunks.length > 0) {
        await db.insert(documentChunks).values(
          chunks.map((content, idx) => ({
            documentId: doc.id,
            chunkIndex: idx,
            content,
            embedding: computeEmbedding(content),
          }))
        );
      }

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
    message: "Document uploaded. AI tagging and indexing in progress.",
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
