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
  schoolName: null as string | null,
  schoolType: null as string | null,
  schoolState: null as string | null,
  studentCount: null as number | null,
  schoolValues: null as string | null,
  principalName: null as string | null,
  learningFrameworks: null as string | null,
  aiProvider: "cloud",
  ollamaBaseUrl: "http://localhost:11434",
  ollamaModel: "llama3.2",
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

    // ─── Chat behaviour ───────────────────────────────────────────────────────
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

    // ─── School profile ───────────────────────────────────────────────────────
    if ("schoolName" in body) {
      patch.schoolName =
        typeof body.schoolName === "string" && body.schoolName.trim()
          ? body.schoolName.trim()
          : null;
    }
    if ("schoolType" in body) {
      const valid = ["primary", "secondary", "p12", "combined", "other"];
      patch.schoolType =
        typeof body.schoolType === "string" && valid.includes(body.schoolType)
          ? body.schoolType
          : null;
    }
    if ("schoolState" in body) {
      const valid = ["VIC", "NSW", "QLD", "SA", "WA", "TAS", "NT", "ACT"];
      patch.schoolState =
        typeof body.schoolState === "string" && valid.includes(body.schoolState)
          ? body.schoolState
          : null;
    }
    if ("studentCount" in body) {
      patch.studentCount =
        typeof body.studentCount === "number" && body.studentCount > 0
          ? Math.round(body.studentCount)
          : null;
    }
    if ("schoolValues" in body) {
      patch.schoolValues =
        typeof body.schoolValues === "string" && body.schoolValues.trim()
          ? body.schoolValues.trim()
          : null;
    }
    if ("principalName" in body) {
      patch.principalName =
        typeof body.principalName === "string" && body.principalName.trim()
          ? body.principalName.trim()
          : null;
    }
    if ("learningFrameworks" in body) {
      patch.learningFrameworks =
        typeof body.learningFrameworks === "string" && body.learningFrameworks.trim()
          ? body.learningFrameworks.trim()
          : null;
    }

    // ─── AI provider ──────────────────────────────────────────────────────────
    if (
      typeof body.aiProvider === "string" &&
      ["cloud", "offline"].includes(body.aiProvider)
    ) {
      patch.aiProvider = body.aiProvider;
    }
    if (typeof body.ollamaBaseUrl === "string" && body.ollamaBaseUrl.trim()) {
      patch.ollamaBaseUrl = body.ollamaBaseUrl.trim();
    }
    if (typeof body.ollamaModel === "string" && body.ollamaModel.trim()) {
      patch.ollamaModel = body.ollamaModel.trim();
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
