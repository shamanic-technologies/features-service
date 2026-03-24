import { Router } from "express";

const router = Router();

router.get("/health", (_req, res) => {
  res.json({ status: "ok", service: "features-service" });
});

export default router;
