import express from "express";
import type { Request, Response, NextFunction } from "express";
import path from "node:path";
import fs from "node:fs";
import { loadUser } from "./auth.ts";
import { api } from "./api.ts";
import { loadIndex, embed } from "./embed.ts";
import { resumeQueue } from "./ingest.ts";
import { scheduleWeeklySync } from "./pal.ts";

const app = express();
app.disable("x-powered-by");
app.set("trust proxy", 1);
app.use(loadUser);
app.use("/api", api);
app.use("/api", (_req, res) => res.status(404).json({ error: "Not found." }));

// Serve the built front end in production.
const dist = path.resolve("dist");
if (fs.existsSync(dist)) {
  app.use(express.static(dist, { index: false, maxAge: "1h" }));
  app.get(/^(?!\/api\/).*/, (_req, res) => res.sendFile(path.join(dist, "index.html")));
} else {
  // In development the app is served by Vite on port 5173; point people there if they open this port.
  app.get("/", (_req, res) =>
    res
      .type("html")
      .send(
        `<p style="font:16px system-ui;margin:40px">This is PolicyPilot's API server. Open the app on port <strong>5173</strong> instead` +
          ` (in GitHub Codespaces: the Ports tab, then the globe icon on the 5173 row).</p>`
      )
  );
}

app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  console.error(err);
  if (res.headersSent) return res.end();
  const message = (err as any)?.code === "LIMIT_FILE_SIZE" ? "Files must be under 30 MB." : "Something went wrong on the server.";
  res.status(500).json({ error: message });
});

const port = Number(process.env.PORT ?? 3011);
app.listen(port, () => {
  console.log(`PolicyPilot API on http://localhost:${port}`);
  console.log(`Loaded ${loadIndex()} passages into the search index.`);
  resumeQueue();
  scheduleWeeklySync();
  // Warm the embedding model so the first question isn't slow.
  embed(["warm up"]).then(() => console.log("Embedding model ready.")).catch((e) => console.error("Embedding model failed to load:", e));
});
