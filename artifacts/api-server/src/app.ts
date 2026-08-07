import express, { type Express } from "express";
import cors from "cors";
import pinoHttp from "pino-http";
import { clerkMiddleware } from "@clerk/express";
import { rateLimit } from "express-rate-limit";
import router from "./routes/index.js";
import { logger } from "./lib/logger.js";

const app: Express = express();

app.use(
  pinoHttp({
    logger,
    serializers: {
      req(req) {
        return {
          id: req.id,
          method: req.method,
          url: req.url?.split("?")[0],
        };
      },
      res(res) {
        return {
          statusCode: res.statusCode,
        };
      },
    },
  }),
);
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use(clerkMiddleware());

// Rate limiting — applied only to AI-heavy routes to prevent abuse.
// Generous limits since all users are authenticated; this is abuse protection, not metering.
const aiRateLimit = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  limit: 30, // 30 AI requests per minute per IP
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: { error: "Too many requests. Please slow down and try again in a moment." },
});
app.use("/api/chat", aiRateLimit);
app.use("/api/draft", aiRateLimit);

app.use("/api", router);

export default app;
