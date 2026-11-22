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
  must_change_password: number;
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

/** Random password a staff member must change at their next sign-in, e.g. "fern-7Q4K-tide". */
export function temporaryPassword(): string {
  const words = ["fern", "tide", "maple", "river", "quartz", "ember", "cedar", "harbour", "wattle", "basalt", "kestrel", "marlin"];
  const pick = () => words[crypto.randomInt(words.length)];
  return `${pick()}-${crypto.randomBytes(3).toString("hex").toUpperCase()}-${pick()}`;
}

/** The platform owner is set by OWNER_EMAIL when present; otherwise the first account becomes owner. */
export function ownerEmail(): string | null {
  return process.env.OWNER_EMAIL?.trim().toLowerCase() || null;
}

/** New schools: "invite" (default, needs a link from the owner) or "open" (anyone can set one up). */
export function schoolSignup(): "open" | "invite" {
  return process.env.SCHOOL_SIGNUP === "open" ? "open" : "invite";
}

/** Optional ALLOWED_EMAIL_DOMAINS, e.g. "education.vic.gov.au,schools.vic.edu.au". The owner is always allowed. */
export function emailAllowed(email: string): boolean {
  const domains = (process.env.ALLOWED_EMAIL_DOMAINS ?? "").split(",").map((d) => d.trim().toLowerCase().replace(/^@/, "")).filter(Boolean);
  if (!domains.length || email.toLowerCase() === ownerEmail()) return true;
  const host = email.toLowerCase().split("@")[1] ?? "";
  return domains.some((d) => host === d || host.endsWith(`.${d}`));
}

/** Keep the owner flag in step with OWNER_EMAIL. */
export function applyOwnerEmail() {
  const owner = ownerEmail();
  if (owner) run("UPDATE users SET is_owner = CASE WHEN lower(email) = ? THEN 1 ELSE 0 END", owner);
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
    // Secure whenever the request came over HTTPS (behind Railway's proxy too, as "trust proxy" is on).
    secure: res.req.secure,
    maxAge: SESSION_DAYS * 86_400_000,
    path: "/",
  });
}

export function sessionToken(req: Request): string | undefined {
  return parseCookies(req.headers.cookie)[COOKIE];
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
      `SELECT u.id, u.school_id, u.email, u.name, u.role, u.is_owner, u.must_change_password
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
applyOwnerEmail();
