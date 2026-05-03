import { Router } from "express";
import { db } from "@workspace/db";
import { chatSessions, chatMessages } from "@workspace/db";
import { eq, desc } from "drizzle-orm";
import { ragChat } from "../lib/rag.js";
import { logger } from "../lib/logger.js";

const router = Router();

router.get("/sessions", async (req, res) => {
  try {
    const userId = (req as any).auth?.userId ?? "anonymous";
    const sessions = await db
      .select()
      .from(chatSessions)
      .where(eq(chatSessions.userId, userId))
      .orderBy(desc(chatSessions.updatedAt));
    res.json(sessions);
  } catch (err) {
    logger.error(err, "Error listing sessions");
    res.status(500).json({ error: "Failed to list sessions" });
  }
});

router.post("/sessions", async (req, res) => {
  try {
    const userId = (req as any).auth?.userId ?? "anonymous";
    const { title } = req.body;
    const [session] = await db.insert(chatSessions).values({
      userId,
      title: title ?? "New Chat",
    }).returning();
    res.status(201).json(session);
  } catch (err) {
    logger.error(err, "Error creating session");
    res.status(500).json({ error: "Failed to create session" });
  }
});

router.get("/sessions/:id", async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const [session] = await db.select().from(chatSessions).where(eq(chatSessions.id, id));
    if (!session) {
      res.status(404).json({ error: "Session not found" });
      return;
    }
    const messages = await db
      .select()
      .from(chatMessages)
      .where(eq(chatMessages.sessionId, id))
      .orderBy(chatMessages.createdAt);
    res.json({ ...session, messages });
  } catch (err) {
    logger.error(err, "Error fetching session");
    res.status(500).json({ error: "Failed to fetch session" });
  }
});

router.post("/sessions/:id/messages", async (req, res) => {
  try {
    const sessionId = parseInt(req.params.id);
    const { question } = req.body;

    if (!question?.trim()) {
      res.status(400).json({ error: "Question is required" });
      return;
    }

    const [session] = await db.select().from(chatSessions).where(eq(chatSessions.id, sessionId));
    if (!session) {
      res.status(404).json({ error: "Session not found" });
      return;
    }

    await db.insert(chatMessages).values({
      sessionId,
      role: "user",
      content: question,
    });

    const history = await db
      .select()
      .from(chatMessages)
      .where(eq(chatMessages.sessionId, sessionId))
      .orderBy(chatMessages.createdAt);

    const { answer, citations } = await ragChat(
      question,
      history.slice(-10).map(m => ({ role: m.role, content: m.content }))
    );

    const [assistantMsg] = await db.insert(chatMessages).values({
      sessionId,
      role: "assistant",
      content: answer,
      citations,
    }).returning();

    if (history.length <= 1) {
      const shortTitle = question.slice(0, 60) + (question.length > 60 ? "…" : "");
      await db.update(chatSessions).set({ title: shortTitle, updatedAt: new Date() }).where(eq(chatSessions.id, sessionId));
    } else {
      await db.update(chatSessions).set({ updatedAt: new Date() }).where(eq(chatSessions.id, sessionId));
    }

    res.json(assistantMsg);
  } catch (err) {
    logger.error(err, "Error sending message");
    res.status(500).json({ error: "Failed to send message" });
  }
});

export default router;
