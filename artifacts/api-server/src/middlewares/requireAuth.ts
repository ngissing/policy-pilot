import { clerkMiddleware, getAuth as clerkGetAuth } from "@clerk/express";
import type { Request, Response, NextFunction } from "express";

export { clerkGetAuth as getAuth };

// Attach Clerk's context to every request (does not block unauthenticated calls)
export const clerkContext = clerkMiddleware();

// Guard: return 401 JSON — never redirect — so the client always gets parseable JSON
export const requireAuth = (req: Request, res: Response, next: NextFunction): void => {
  const { userId } = clerkGetAuth(req);
  if (!userId) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  next();
};
