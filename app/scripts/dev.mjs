// Runs the API server and the Vite dev server together.
import { spawn } from "node:child_process";

const procs = [
  spawn(process.execPath, ["--watch", "--env-file-if-exists=.env", "server/index.ts"], { stdio: "inherit", env: { ...process.env, PORT: process.env.API_PORT ?? "3011" } }),
  spawn(process.execPath, ["node_modules/vite/bin/vite.js"], { stdio: "inherit" }),
];
const stop = () => procs.forEach((p) => p.kill());
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
procs.forEach((p) => p.on("exit", (code) => { if (code) { stop(); process.exit(code); } }));
