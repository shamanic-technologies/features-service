import { Router } from "express";
import { openApiDocument } from "../lib/openapi.js";

const router = Router();

router.get("/health", (_req, res) => {
  res.json({ status: "ok", service: "features-service" });
});

router.get("/openapi.json", (_req, res) => {
  res.json(openApiDocument);
});

export default router;
