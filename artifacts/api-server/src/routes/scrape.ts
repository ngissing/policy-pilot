import { Router } from "express";
import { db } from "@workspace/db";
import { scrapeJobs, palSlugs } from "@workspace/db";
import { eq, desc } from "drizzle-orm";
import { requireAuth } from "../middlewares/requireAuth.js";
import { runScrapeJob } from "../lib/scraper.js";
import {
  runPalFullCrawl,
  runPalMaintenanceCrawl,
  runPalFallbackCrawl,
  getPalSlugStats,
} from "../lib/palCrawler.js";
import { logger } from "../lib/logger.js";

const router = Router();
router.use(requireAuth);

// ─── Generic scrape jobs ───────────────────────────────────────────────────────

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

// Create + start a new generic job
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
      .values({ seedUrl, maxDepth, maxPages, status: "pending", jobType: "generic" })
      .returning();

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

// ─── PAL-specific routes ───────────────────────────────────────────────────────

/**
 * GET /api/scrape/pal/stats
 * Returns the current state of the PAL slug index.
 */
router.get("/pal/stats", async (_req, res) => {
  try {
    const stats = await getPalSlugStats();
    res.json(stats);
  } catch (err) {
    logger.error(err, "Error fetching PAL stats");
    res.status(500).json({ error: "Failed to fetch PAL stats" });
  }
});

/**
 * GET /api/scrape/pal/slugs
 * Returns the full slug index (active and retired).
 */
router.get("/pal/slugs", async (_req, res) => {
  try {
    const slugs = await db
      .select()
      .from(palSlugs)
      .orderBy(palSlugs.slug);
    res.json(slugs);
  } catch (err) {
    logger.error(err, "Error fetching PAL slugs");
    res.status(500).json({ error: "Failed to fetch slugs" });
  }
});

/**
 * POST /api/scrape/pal/start
 * Start a PAL ingestion job.
 *
 * Body:
 *   mode: 'full'        — two-pass print-all crawl (recommended)
 *          'maintenance' — re-crawl recently-updated topics only
 *          'fallback'    — link-graph BFS from enrolment hub
 *   sinceDate?: string  — ISO date for maintenance mode (default: 7 days ago)
 *   maxDepth?: number   — fallback mode only (default: 5)
 *   maxPages?: number   — fallback mode only (default: 4000)
 */
router.post("/pal/start", async (req, res) => {
  const body = req.body as Record<string, unknown>;
  const mode = typeof body.mode === "string" ? body.mode : "full";

  if (!["full", "maintenance", "fallback"].includes(mode)) {
    res.status(400).json({ error: "mode must be 'full', 'maintenance', or 'fallback'" });
    return;
  }

  const jobTypeMap: Record<string, string> = {
    full: "pal-full",
    maintenance: "pal-maintenance",
    fallback: "pal-fallback",
  };

  // For maintenance mode, parse the since date
  let sinceDate = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000); // default: 7 days ago
  if (mode === "maintenance" && typeof body.sinceDate === "string") {
    const parsed = new Date(body.sinceDate);
    if (!isNaN(parsed.getTime())) sinceDate = parsed;
  }

  const maxDepth = mode === "fallback" && typeof body.maxDepth === "number"
    ? Math.min(Math.max(1, Math.round(body.maxDepth)), 8)
    : 5;
  const maxPages = mode === "fallback" && typeof body.maxPages === "number"
    ? Math.min(Math.max(1, Math.round(body.maxPages)), 5000)
    : 4000;

  // Seed URL is informational for PAL jobs (not used by the crawler directly)
  const seedUrl = mode === "fallback"
    ? "https://www2.education.vic.gov.au/pal/enrolment/policy"
    : "https://www2.education.vic.gov.au/pal";

  try {
    const [job] = await db
      .insert(scrapeJobs)
      .values({
        seedUrl,
        maxDepth,
        maxPages,
        status: "pending",
        jobType: jobTypeMap[mode],
      })
      .returning();

    setImmediate(() => {
      const runner =
        mode === "full"
          ? () => runPalFullCrawl(job.id)
          : mode === "maintenance"
          ? () => runPalMaintenanceCrawl(job.id, sinceDate)
          : () => runPalFallbackCrawl(job.id, maxDepth, maxPages);

      runner().catch((err) =>
        logger.error({ jobId: job.id, err }, "Unhandled PAL job error")
      );
    });

    res.status(201).json(job);
  } catch (err) {
    logger.error(err, "Error creating PAL job");
    res.status(500).json({ error: "Failed to create PAL job" });
  }
});

export default router;
