import { getAuth as clerkGetAuth } from "@clerk/express";
import type { Request, Response, NextFunction } from "express";

export { clerkGetAuth as getAuth };

// Returns 401 JSON — never redirects.
// Must run after clerkMiddleware() has populated req.auth (done in app.ts).
// acceptsToken: "any" matches what the now-deprecated requireAuth() used internally.
export const requireAuth = (req: Request, res: Response, next: NextFunction): void => {
  const { userId } = clerkGetAuth(req, { acceptsToken: "any" } as Parameters<typeof clerkGetAuth>[1]);
  if (!userId) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  next();
};
