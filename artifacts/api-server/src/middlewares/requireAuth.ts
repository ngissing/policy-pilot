import { requireAuth as clerkRequireAuth, getAuth } from "@clerk/express";
import type { Request, Response, NextFunction } from "express";

export { getAuth };

export const requireAuth = clerkRequireAuth();
