import { Request, Response, NextFunction, RequestHandler } from "express";

export interface AuthenticatedRequest extends Request {
  orgId: string;
  userId: string;
  runId: string;
  brandId?: string;
  campaignId?: string;
  featureSlug?: string;
}

/**
 * API key auth for service-to-service calls.
 * Requires x-org-id, x-user-id, and x-run-id on every authenticated endpoint.
 */
export const apiKeyAuth: RequestHandler = (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  const apiKey = req.headers["x-api-key"] as string;

  if (!apiKey || apiKey !== process.env.FEATURES_SERVICE_API_KEY) {
    res.status(401).json({ error: "Invalid or missing API key" });
    return;
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
    res.status(400).json({ error: `Missing required headers: ${missing.join(", ")}` });
    return;
  }

  (req as AuthenticatedRequest).orgId = orgId!;
  (req as AuthenticatedRequest).userId = userId!;
  (req as AuthenticatedRequest).runId = runId!;

  const brandId = req.headers["x-brand-id"] as string | undefined;
  const campaignId = req.headers["x-campaign-id"] as string | undefined;
  const featureSlug = req.headers["x-feature-slug"] as string | undefined;
  if (brandId) (req as AuthenticatedRequest).brandId = brandId;
  if (campaignId) (req as AuthenticatedRequest).campaignId = campaignId;
  if (featureSlug) (req as AuthenticatedRequest).featureSlug = featureSlug;

  next();
};
