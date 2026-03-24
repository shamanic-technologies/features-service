import { Request, Response, NextFunction } from "express";

export interface AuthenticatedRequest extends Request {
  orgId?: string;
  userId?: string;
  runId?: string;
}

/**
 * API key auth for service-to-service calls.
 * Features are global (not per-org), but we still accept identity headers for logging/run tracking.
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

  // Capture identity headers for logging (not required since features are global)
  req.orgId = req.headers["x-org-id"] as string | undefined;
  req.userId = req.headers["x-user-id"] as string | undefined;
  req.runId = req.headers["x-run-id"] as string | undefined;

  next();
}
