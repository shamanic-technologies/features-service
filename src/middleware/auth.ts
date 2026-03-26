import { Request, Response, NextFunction } from "express";

export interface AuthenticatedRequest extends Request {
  orgId: string;
  userId: string;
  runId: string;
}

/**
 * API key auth for service-to-service calls.
 * Requires x-org-id, x-user-id, and x-run-id on every authenticated endpoint.
 */
export function apiKeyAuth(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
) {
  const apiKey = req.headers["x-api-key"] as string;

  if (!apiKey || apiKey !== process.env.FEATURES_SERVICE_API_KEY) {
    return res.status(401).json({ error: "Invalid or missing API key" });
  }

  const orgId = req.headers["x-org-id"] as string | undefined;
  const userId = req.headers["x-user-id"] as string | undefined;
  const runId = req.headers["x-run-id"] as string | undefined;

  const missing = [
    !orgId && "x-org-id",
    !userId && "x-user-id",
    !runId && "x-run-id",
  ].filter(Boolean);

  if (missing.length > 0) {
    return res.status(400).json({ error: `Missing required headers: ${missing.join(", ")}` });
  }

  req.orgId = orgId!;
  req.userId = userId!;
  req.runId = runId!;

  next();
}
