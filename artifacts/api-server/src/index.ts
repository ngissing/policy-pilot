import app from "./app";
import { logger } from "./lib/logger";
import { warmupEmbeddings } from "./lib/embeddings";
import { runMigrations, backfillEmbeddings } from "./lib/migrate";
import { db } from "@workspace/db";
import { documents } from "@workspace/db";
import { eq } from "drizzle-orm";

const rawPort = process.env["PORT"];

if (!rawPort) {
  throw new Error(
    "PORT environment variable is required but was not provided.",
  );
}

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

async function recoverStuckDocuments(): Promise<void> {
  // Any document left in "processing" at startup means the server crashed or
  // restarted mid-job. Reset them to "pending" so they appear in the review
  // queue and can be manually reprocessed rather than staying invisible forever.
  const result = await db
    .update(documents)
    .set({ status: "pending", updatedAt: new Date() })
    .where(eq(documents.status, "processing"))
    .returning({ id: documents.id });

  if (result.length > 0) {
    logger.warn(
      { count: result.length, ids: result.map((r) => r.id) },
      "Recovered stuck processing documents — reset to pending"
    );
  }
}

runMigrations()
  .then(() => recoverStuckDocuments())
  .then(() => {
    app.listen(port, (err) => {
      if (err) {
        logger.error({ err }, "Error listening on port");
        process.exit(1);
      }

      logger.info({ port }, "Server listening");

      warmupEmbeddings()
        .then(() => {
          logger.info("Embedding model ready");
          return backfillEmbeddings();
        })
        .catch((e) => logger.warn({ err: e }, "Embedding model warmup failed"));
    });
  })
  .catch((err) => {
    logger.error({ err }, "Startup failed — aborting");
    process.exit(1);
  });
