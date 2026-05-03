import { Router, type IRouter } from "express";
import healthRouter from "./health.js";
import documentsRouter from "./documents.js";
import chatRouter from "./chat.js";
import statsRouter from "./stats.js";
import settingsRouter from "./settings.js";
import scrapeRouter from "./scrape.js";

const router: IRouter = Router();

router.use(healthRouter);
router.use("/documents", documentsRouter);
router.use("/chat", chatRouter);
router.use("/stats", statsRouter);
router.use("/settings", settingsRouter);
router.use("/scrape", scrapeRouter);

export default router;
