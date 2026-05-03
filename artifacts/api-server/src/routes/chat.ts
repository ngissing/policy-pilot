import { Router } from "express";
import { db } from "@workspace/db";
import { chatSessions, chatMessages } from "@workspace/db";
import { eq, desc, and } from "drizzle-orm";
import { ragChat } from "../lib/rag.js";
import { logger } from "../lib/logger.js";
import { requireAuth, getAuth } from "../middlewares/requireAuth.js";

const router = Router();

router.use(requireAuth);

router.get("/sessions", async (req, res) => {
  try {
    const { userId } = getAuth(req);
    if (!userId) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
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
    const { userId } = getAuth(req);
    if (!userId) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    const title: string = typeof req.body?.title === "string" ? req.body.title : "New Chat";
    const [session] = await db
      .insert(chatSessions)
      .values({ userId, title })
      .returning();
    res.status(201).json(session);
  } catch (err) {
    logger.error(err, "Error creating session");
    res.status(500).json({ error: "Failed to create session" });
  }
});

router.get("/sessions/:id", async (req, res) => {
  try {
    const { userId } = getAuth(req);
    if (!userId) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) {
      res.status(400).json({ error: "Invalid session id" });
      return;
    }
    const [session] = await db
      .select()
      .from(chatSessions)
      .where(and(eq(chatSessions.id, id), eq(chatSessions.userId, userId)));
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

router.get("/sessions/:id/messages", async (req, res) => {
  try {
    const { userId } = getAuth(req);
    if (!userId) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) {
      res.status(400).json({ error: "Invalid session id" });
      return;
    }
    const [session] = await db
      .select()
      .from(chatSessions)
      .where(and(eq(chatSessions.id, id), eq(chatSessions.userId, userId)));
    if (!session) {
      res.status(404).json({ error: "Session not found" });
      return;
    }
    const messages = await db
      .select()
      .from(chatMessages)
      .where(eq(chatMessages.sessionId, id))
      .orderBy(chatMessages.createdAt);
    res.json(messages);
  } catch (err) {
    logger.error(err, "Error fetching messages");
    res.status(500).json({ error: "Failed to fetch messages" });
  }
});

router.post("/sessions/:id/messages", async (req, res) => {
  try {
    const { userId } = getAuth(req);
    if (!userId) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    const sessionId = parseInt(req.params.id, 10);
    if (isNaN(sessionId)) {
      res.status(400).json({ error: "Invalid session id" });
      return;
    }
    const question: string = typeof req.body?.question === "string" ? req.body.question.trim() : "";
    if (!question) {
      res.status(400).json({ error: "Question is required" });
      return;
    }

    const [session] = await db
      .select()
      .from(chatSessions)
      .where(and(eq(chatSessions.id, sessionId), eq(chatSessions.userId, userId)));
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
      history.slice(-10).map((m) => ({ role: m.role, content: m.content }))
    );

    const [assistantMsg] = await db
      .insert(chatMessages)
      .values({ sessionId, role: "assistant", content: answer, citations })
      .returning();

    const isFirstExchange = history.filter((m) => m.role === "user").length <= 1;
    const newTitle = isFirstExchange
      ? question.slice(0, 60) + (question.length > 60 ? "…" : "")
      : session.title;
    await db
      .update(chatSessions)
      .set({ title: newTitle, updatedAt: new Date() })
      .where(eq(chatSessions.id, sessionId));

    res.json(assistantMsg);
  } catch (err) {
    logger.error(err, "Error sending message");
    res.status(500).json({ error: "Failed to send message" });
  }
});

export default router;
