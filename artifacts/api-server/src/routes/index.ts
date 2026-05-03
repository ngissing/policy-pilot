import { Router, type IRouter } from "express";
import healthRouter from "./health.js";
import documentsRouter from "./documents.js";
import chatRouter from "./chat.js";
import statsRouter from "./stats.js";

const router: IRouter = Router();

router.use(healthRouter);
router.use("/documents", documentsRouter);
router.use("/chat", chatRouter);
router.use("/stats", statsRouter);

export default router;
