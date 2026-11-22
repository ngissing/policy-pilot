import crypto from "node:crypto";
import type { Request, Response, NextFunction } from "express";
import { one, run } from "./db.ts";

const SESSION_DAYS = 30;
const COOKIE = "pp_session";

export interface User {
  id: number;
  school_id: number;
  email: string;
  name: string;
  role: "admin" | "staff";
  is_owner: number;
}

declare global {
  namespace Express {
    interface Request {
      user?: User;
    }
  }
}

export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 64);
  return `scrypt$${salt.toString("base64")}$${hash.toString("base64")}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [scheme, saltB64, hashB64] = stored.split("$");
  if (scheme !== "scrypt" || !saltB64 || !hashB64) return false;
  const expected = Buffer.from(hashB64, "base64");
  const actual = crypto.scryptSync(password, Buffer.from(saltB64, "base64"), expected.length);
  return crypto.timingSafeEqual(expected, actual);
}

export function newJoinCode(): string {
  // Readable code without look-alike characters, e.g. "K7QM-4XPD".
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const pick = () => Array.from(crypto.randomBytes(4), (b) => alphabet[b % alphabet.length]).join("");
  return `${pick()}-${pick()}`;
}

function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (header ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

export function startSession(res: Response, userId: number) {
  const token = crypto.randomBytes(32).toString("base64url");
  const expires = Date.now() + SESSION_DAYS * 86_400_000;
  run("INSERT INTO sessions(token, user_id, expires_at) VALUES (?, ?, ?)", token, userId, expires);
  res.cookie(COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    maxAge: SESSION_DAYS * 86_400_000,
    path: "/",
  });
}

export function endSession(req: Request, res: Response) {
  const token = parseCookies(req.headers.cookie)[COOKIE];
  if (token) run("DELETE FROM sessions WHERE token = ?", token);
  res.clearCookie(COOKIE, { path: "/" });
}

export function loadUser(req: Request, _res: Response, next: NextFunction) {
  const token = parseCookies(req.headers.cookie)[COOKIE];
  if (token) {
    const user = one<User>(
      `SELECT u.id, u.school_id, u.email, u.name, u.role, u.is_owner
       FROM sessions s JOIN users u ON u.id = s.user_id
       WHERE s.token = ? AND s.expires_at > ?`,
      token,
      Date.now()
    );
    if (user) req.user = user;
  }
  next();
}

export function requireUser(req: Request, res: Response, next: NextFunction) {
  if (!req.user) return res.status(401).json({ error: "Sign in to continue." });
  next();
}

export function requireAdmin(req: Request, res: Response, next: NextFunction) {
  if (!req.user) return res.status(401).json({ error: "Sign in to continue." });
  if (req.user.role !== "admin") return res.status(403).json({ error: "Only school admins can do this." });
  next();
}

/** The platform owner (first account created) manages the shared PAL library and the AI key. */
export function requireOwner(req: Request, res: Response, next: NextFunction) {
  if (!req.user) return res.status(401).json({ error: "Sign in to continue." });
  if (!req.user.is_owner) return res.status(403).json({ error: "Only the platform owner can do this." });
  next();
}

run("DELETE FROM sessions WHERE expires_at < ?", Date.now());
