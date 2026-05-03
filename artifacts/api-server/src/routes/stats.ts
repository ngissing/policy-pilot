import { Router } from "express";
import { db } from "@workspace/db";
import { documents } from "@workspace/db";
import { sql, count } from "drizzle-orm";
import { logger } from "../lib/logger.js";

const router = Router();

router.get("/summary", async (req, res) => {
  try {
    const [totals] = await db.select({
      total: count(),
      approved: sql<number>`cast(sum(case when ${documents.status} = 'approved' then 1 else 0 end) as int)`,
      pending: sql<number>`cast(sum(case when ${documents.status} = 'pending' then 1 else 0 end) as int)`,
      processing: sql<number>`cast(sum(case when ${documents.status} = 'processing' then 1 else 0 end) as int)`,
    }).from(documents);

    res.json({
      total: totals.total ?? 0,
      approved: totals.approved ?? 0,
      pending: totals.pending ?? 0,
      processing: totals.processing ?? 0,
    });
  } catch (err) {
    logger.error(err, "Error fetching stats summary");
    res.status(500).json({ error: "Failed to fetch stats" });
  }
});

router.get("/by-domain", async (req, res) => {
  try {
    const rows = await db.select({
      domain: documents.policyDomain,
      count: count(),
    }).from(documents).groupBy(documents.policyDomain);

    const result = rows.map(r => ({
      domain: r.domain ?? "uncategorized",
      count: r.count,
    }));

    res.json(result);
  } catch (err) {
    logger.error(err, "Error fetching domain stats");
    res.status(500).json({ error: "Failed to fetch domain stats" });
  }
});

export default router;
