import * as Sentry from "@sentry/node";

if (process.env.SENTRY_DSN) {
  Sentry.init({
    dsn: process.env.SENTRY_DSN,
    environment: process.env.NODE_ENV || "development",
    tracesSampleRate: 0.1,
    // Sentry v11 removed `sendDefaultPii`; its `dataCollection` default equals the old `sendDefaultPii: true`.
  });
  Sentry.setTag("service", "features-service");
}
