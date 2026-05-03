import { Router } from "express";
import multer from "multer";
import { db } from "@workspace/db";
import { documents, documentChunks } from "@workspace/db";
import { eq, and, like, ilike, or, lte, desc } from "drizzle-orm";
import { parseFile, getFileType, chunkText } from "../lib/fileParser.js";
import { autoTagDocument } from "../lib/rag.js";
import { logger } from "../lib/logger.js";

const router = Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });

router.get("/", async (req, res) => {
  try {
    const { domain, documentType, audience, status, search } = req.query as Record<string, string>;

    let rows = await db.select({
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
    }).from(documents).orderBy(desc(documents.createdAt));

    if (domain) rows = rows.filter(r => r.policyDomain === domain);
    if (documentType) rows = rows.filter(r => r.documentType === documentType);
    if (audience) rows = rows.filter(r => r.audience === audience);
    if (status) rows = rows.filter(r => r.status === status);
    if (search) {
      const q = search.toLowerCase();
      rows = rows.filter(r =>
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
      .where(eq(documents.status, "pending"))
      .orderBy(desc(documents.createdAt));

    res.json(rows);
  } catch (err) {
    logger.error(err, "Error fetching review queue");
    res.status(500).json({ error: "Failed to fetch review queue" });
  }
});

router.post("/upload", upload.single("file"), async (req, res) => {
  try {
    const file = req.file;
    if (!file) {
      res.status(400).json({ error: "No file uploaded" });
      return;
    }

    const fileType = getFileType(file.mimetype, file.originalname);
    if (fileType === "unknown") {
      res.status(400).json({ error: "Unsupported file type. Upload PDF, DOCX, or TXT." });
      return;
    }

    const rawText = await parseFile(file.buffer, file.mimetype, file.originalname);

    const [doc] = await db.insert(documents).values({
      filename: file.originalname,
      fileType,
      rawText,
      status: "processing",
    }).returning();

    res.status(202).json({
      id: doc.id,
      filename: doc.filename,
      status: doc.status,
      message: "Document uploaded. AI tagging in progress.",
    });

    setImmediate(async () => {
      try {
        const tags = await autoTagDocument(rawText);
        const status = tags.confidenceScore >= 0.7 ? "approved" : "pending";

        await db.update(documents).set({
          title: tags.title,
          issuingAuthority: tags.issuingAuthority,
          policyDomain: tags.policyDomain,
          documentType: tags.documentType,
          audience: tags.audience,
          confidenceScore: tags.confidenceScore,
          status,
          updatedAt: new Date(),
        }).where(eq(documents.id, doc.id));

        const chunks = chunkText(rawText);
        if (chunks.length > 0) {
          await db.insert(documentChunks).values(
            chunks.map((content, idx) => ({
              documentId: doc.id,
              chunkIndex: idx,
              content,
            }))
          );
        }

        logger.info({ docId: doc.id, status, confidence: tags.confidenceScore }, "Document tagged");
      } catch (err) {
        logger.error(err, "Error during AI tagging");
        await db.update(documents).set({ status: "pending", updatedAt: new Date() }).where(eq(documents.id, doc.id));
      }
    });
  } catch (err) {
    logger.error(err, "Error uploading document");
    res.status(500).json({ error: "Upload failed" });
  }
});

router.get("/:id", async (req, res) => {
  try {
    const id = parseInt(req.params.id);
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
    const id = parseInt(req.params.id);
    const { title, issuingAuthority, policyDomain, documentType, audience, status } = req.body;

    const [doc] = await db.update(documents).set({
      ...(title !== undefined && { title }),
      ...(issuingAuthority !== undefined && { issuingAuthority }),
      ...(policyDomain !== undefined && { policyDomain }),
      ...(documentType !== undefined && { documentType }),
      ...(audience !== undefined && { audience }),
      ...(status !== undefined && { status }),
      updatedAt: new Date(),
    }).where(eq(documents.id, id)).returning();

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
    const id = parseInt(req.params.id);
    await db.delete(documents).where(eq(documents.id, id));
    res.status(204).send();
  } catch (err) {
    logger.error(err, "Error deleting document");
    res.status(500).json({ error: "Failed to delete document" });
  }
});

export default router;
