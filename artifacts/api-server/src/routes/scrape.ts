import { Router } from "express";
import { db } from "@workspace/db";
import { scrapeJobs } from "@workspace/db";
import { eq, desc } from "drizzle-orm";
import { requireAuth } from "../middlewares/requireAuth.js";
import { runScrapeJob } from "../lib/scraper.js";
import { logger } from "../lib/logger.js";

const router = Router();
router.use(requireAuth);

// List all jobs
router.get("/jobs", async (_req, res) => {
  try {
    const jobs = await db
      .select()
      .from(scrapeJobs)
      .orderBy(desc(scrapeJobs.createdAt))
      .limit(50);
    res.json(jobs);
  } catch (err) {
    logger.error(err, "Error listing scrape jobs");
    res.status(500).json({ error: "Failed to list scrape jobs" });
  }
});

// Get a single job
router.get("/jobs/:id", async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }
  try {
    const [job] = await db.select().from(scrapeJobs).where(eq(scrapeJobs.id, id));
    if (!job) { res.status(404).json({ error: "Job not found" }); return; }
    res.json(job);
  } catch (err) {
    logger.error(err, "Error fetching scrape job");
    res.status(500).json({ error: "Failed to fetch job" });
  }
});

// Create + start a new job
router.post("/jobs", async (req, res) => {
  const body = req.body as Record<string, unknown>;
  const seedUrl = typeof body.seedUrl === "string" ? body.seedUrl.trim() : "";
  if (!seedUrl) { res.status(400).json({ error: "seedUrl is required" }); return; }

  try { new URL(seedUrl); } catch {
    res.status(400).json({ error: "seedUrl must be a valid URL" });
    return;
  }

  const maxDepth = typeof body.maxDepth === "number"
    ? Math.min(Math.max(1, Math.round(body.maxDepth)), 10)
    : 3;
  const maxPages = typeof body.maxPages === "number"
    ? Math.min(Math.max(1, Math.round(body.maxPages)), 2000)
    : 200;

  try {
    const [job] = await db
      .insert(scrapeJobs)
      .values({ seedUrl, maxDepth, maxPages, status: "pending" })
      .returning();

    // Start in background — do not await
    setImmediate(() => {
      runScrapeJob(job.id).catch((err) =>
        logger.error({ jobId: job.id, err }, "Unhandled scrape job error")
      );
    });

    res.status(201).json(job);
  } catch (err) {
    logger.error(err, "Error creating scrape job");
    res.status(500).json({ error: "Failed to create scrape job" });
  }
});

// Cancel a running job
router.patch("/jobs/:id/cancel", async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }
  try {
    const [job] = await db.select().from(scrapeJobs).where(eq(scrapeJobs.id, id));
    if (!job) { res.status(404).json({ error: "Job not found" }); return; }
    if (!["pending", "running"].includes(job.status)) {
      res.status(400).json({ error: "Job is not running" });
      return;
    }
    const [updated] = await db
      .update(scrapeJobs)
      .set({ status: "cancelled", updatedAt: new Date(), completedAt: new Date() })
      .where(eq(scrapeJobs.id, id))
      .returning();
    res.json(updated);
  } catch (err) {
    logger.error(err, "Error cancelling scrape job");
    res.status(500).json({ error: "Failed to cancel job" });
  }
});

// Delete a job record
router.delete("/jobs/:id", async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }
  try {
    const [job] = await db.select().from(scrapeJobs).where(eq(scrapeJobs.id, id));
    if (!job) { res.status(404).json({ error: "Job not found" }); return; }
    if (job.status === "running") {
      res.status(400).json({ error: "Cancel the job before deleting" });
      return;
    }
    await db.delete(scrapeJobs).where(eq(scrapeJobs.id, id));
    res.status(204).send();
  } catch (err) {
    logger.error(err, "Error deleting scrape job");
    res.status(500).json({ error: "Failed to delete job" });
  }
});

export default router;
