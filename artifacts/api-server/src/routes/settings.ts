import { Router } from "express";
import { db } from "@workspace/db";
import { appSettings } from "@workspace/db";
import { eq } from "drizzle-orm";
import { requireAuth } from "../middlewares/requireAuth.js";
import { logger } from "../lib/logger.js";

const router = Router();

router.use(requireAuth);

const DEFAULTS = {
  responseLength: "detailed",
  responseTone: "formal",
  maxSources: 5,
  showFollowUpSuggestions: true,
  fallbackMessage:
    "I couldn't find a policy that covers this — consider uploading relevant documents.",
} as const;

async function getOrCreateSettings() {
  const [existing] = await db.select().from(appSettings).limit(1);
  if (existing) return existing;
  const [created] = await db.insert(appSettings).values(DEFAULTS).returning();
  return created;
}

router.get("/", async (_req, res) => {
  try {
    const settings = await getOrCreateSettings();
    res.json(settings);
  } catch (err) {
    logger.error(err, "Error fetching settings");
    res.status(500).json({ error: "Failed to fetch settings" });
  }
});

router.put("/", async (req, res) => {
  try {
    const body = req.body as Record<string, unknown>;
    const patch: Record<string, unknown> = { updatedAt: new Date() };

    if (
      typeof body.responseLength === "string" &&
      ["brief", "concise", "detailed"].includes(body.responseLength)
    ) {
      patch.responseLength = body.responseLength;
    }
    if (
      typeof body.responseTone === "string" &&
      ["formal", "friendly"].includes(body.responseTone)
    ) {
      patch.responseTone = body.responseTone;
    }
    if (typeof body.maxSources === "number" && [3, 5, 10].includes(body.maxSources)) {
      patch.maxSources = body.maxSources;
    }
    if (typeof body.showFollowUpSuggestions === "boolean") {
      patch.showFollowUpSuggestions = body.showFollowUpSuggestions;
    }
    if (typeof body.fallbackMessage === "string" && body.fallbackMessage.trim().length > 0) {
      patch.fallbackMessage = body.fallbackMessage.trim();
    }

    const existing = await getOrCreateSettings();
    const [updated] = await db
      .update(appSettings)
      .set(patch)
      .where(eq(appSettings.id, existing.id))
      .returning();

    res.json(updated);
  } catch (err) {
    logger.error(err, "Error updating settings");
    res.status(500).json({ error: "Failed to update settings" });
  }
});

export default router;
