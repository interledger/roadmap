import "dotenv/config";
import Fastify from "fastify";
import cors from "@fastify/cors";
import rawBody from "fastify-raw-body";
import { roadmapRoutes } from "./routes/roadmap.js";
import { webhookRoutes } from "./routes/webhook.js";
import { prisma } from "./db/client.js";

const app = Fastify({
  logger: {
    transport:
      process.env.NODE_ENV === "development"
        ? { target: "pino-pretty" }
        : undefined,
  },
});

await app.register(rawBody, { global: false });

// Allow Astro sites to fetch from this service during development
await app.register(cors, {
  origin: process.env.ALLOWED_ORIGINS?.split(",") ?? "*",
  methods: ["GET", "POST"],
});

// Routes
await app.register(roadmapRoutes);
await app.register(webhookRoutes);

// Graceful shutdown
const shutdown = async () => {
  app.log.info("Shutting down...");
  await app.close();
  await prisma.$disconnect();
  process.exit(0);
};

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

// Start
const port = Number(process.env.PORT ?? 3100);
const host = process.env.HOST ?? "0.0.0.0";

try {
  await app.listen({ port, host });
  app.log.info(`Linear roadmap service running on http://${host}:${port}`);
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
