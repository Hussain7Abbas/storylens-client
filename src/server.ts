import { createHash, timingSafeEqual, randomUUID } from "node:crypto";
import Fastify from "fastify";
import type { SettingsStore } from "./config";
import type { PromptService } from "./service";
import { ClientError } from "./types";

const extensionOrigin = /^(chrome-extension|moz-extension):\/\/[a-z0-9-]+$/i;

export function createServer(settings: SettingsStore, service: PromptService) {
  const app = Fastify({ bodyLimit: 1_000_000, logger: false, requestTimeout: 250_000 });
  app.addHook("onRequest", async (request, reply) => {
    const expectedHost = `127.0.0.1:${settings.get().port}`;
    if (request.headers.host !== expectedHost) throw new ClientError("BAD_HOST", "Invalid Host header.", 403);
    const origin = request.headers.origin;
    if (origin && !extensionOrigin.test(origin)) throw new ClientError("BAD_ORIGIN", "Only browser extensions can connect.", 403);
    if (origin) {
      reply.header("Access-Control-Allow-Origin", origin);
      reply.header("Vary", "Origin");
      reply.header("Access-Control-Allow-Headers", "Authorization, Content-Type, Accept");
      reply.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    }
    reply.header("Cache-Control", "no-store");
    if (request.method === "OPTIONS") { reply.code(204).send(); return reply; }
    const bearer = request.headers.authorization?.replace(/^Bearer /, "");
    const actual = createHash("sha256").update(bearer ?? "").digest();
    const expected = createHash("sha256").update(settings.get().token).digest();
    if (!bearer || !timingSafeEqual(actual, expected)) throw new ClientError("UNAUTHORIZED", "Pairing token is invalid.", 401);
  });
  app.setErrorHandler((error, request, reply) => {
    const known = error instanceof ClientError ? error : undefined;
    const status = known?.status ?? (error && typeof error === "object" && "statusCode" in error && typeof error.statusCode === "number" ? error.statusCode : 500);
    reply.code(status === 499 ? 502 : status).send({ requestId: request.id, error: { code: known?.code ?? (status === 413 ? "BODY_TOO_LARGE" : "INTERNAL_ERROR"), message: known?.message ?? (status === 413 ? "Request is too large." : "Desktop client request failed."), retryable: status >= 429 } });
  });
  app.get("/capabilities", async () => service.catalog());
  app.post("/ExecutePrompt", async (request, reply) => {
    const controller = new AbortController();
    const disconnect = () => controller.abort();
    request.raw.on("aborted", disconnect);
    reply.raw.on("close", disconnect);
    if (!request.headers.accept?.includes("application/x-ndjson")) {
      try { return await service.executePrompt(request.body, controller.signal); }
      finally { request.raw.off("aborted", disconnect); reply.raw.off("close", disconnect); }
    }
    reply.hijack();
    reply.raw.writeHead(200, { "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-store", ...(request.headers.origin ? { "Access-Control-Allow-Origin": request.headers.origin, Vary: "Origin" } : {}) });
    const requestId = randomUUID();
    const send = (frame: unknown) => { if (!reply.raw.destroyed) reply.raw.write(`${JSON.stringify(frame)}\n`); };
    send({ type: "started", requestId });
    const interval = setInterval(() => send({ type: "heartbeat", requestId }), 10_000);
    try {
      const result = await service.executePrompt(request.body, controller.signal);
      send({ type: "result", ...result, requestId });
    } catch (error) {
      const known = error instanceof ClientError ? error : undefined;
      send({ type: "error", requestId, error: { code: known?.code ?? "INTERNAL_ERROR", message: known?.message ?? "Desktop client request failed.", retryable: (known?.status ?? 500) >= 429 } });
    } finally {
      clearInterval(interval);
      request.raw.off("aborted", disconnect);
      reply.raw.off("close", disconnect);
      reply.raw.end();
    }
  });
  return app;
}
