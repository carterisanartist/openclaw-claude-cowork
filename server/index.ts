#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type {
  CallToolResult,
  ServerNotification,
  ServerRequest,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import { AuditTee } from "./audit.js";
import { loadConfig } from "./config.js";
import { Dispatcher, type DispatchResult } from "./dispatcher.js";
import { EscalationManager } from "./escalation.js";
import { log } from "./logger.js";
import { StateStore } from "./state.js";
import { SuperviseTools } from "./supervise.js";
import { TelegramClient } from "./telegram.js";

/**
 * MCPB entry point for the Company Claw Bridge.
 *
 * Lifecycle:
 *   1. Load and validate config (env populated from user_config by Claude Desktop).
 *   2. Load on-disk state.
 *   3. Construct the Telegram client, dispatcher, escalation manager, supervise wrappers, audit tee.
 *   4. Register MCP tools and connect over stdio.
 *   5. On SIGINT/SIGTERM: stop polling, flush state, exit cleanly.
 *
 * MUST NOT write to stdout outside of JSON-RPC frames. All diagnostic output
 * goes via the stderr logger.
 */

async function main(): Promise<void> {
  const config = loadConfig();
  const state = new StateStore(config.stateDir);
  await state.load();

  // Acquire the cross-process lock BEFORE any I/O that mutates shared state.
  // If another bridge instance is already running against the same state dir
  // (e.g. user has us installed in both Claude Desktop and Claude Code), the
  // second copy would race the first for Telegram getUpdates - the first
  // long-poll consumer wins and the second silently drops messages. We bail
  // out cleanly instead.
  await state.acquireLock();
  state.garbageCollect(7 * 24 * 60 * 60 * 1000);

  const telegram = new TelegramClient({
    token: config.telegramBotToken,
    state,
    chatId: config.clawChatId,
  });
  const audit = new AuditTee({ config, telegram });
  const dispatcher = new Dispatcher({ config, state, telegram, audit });
  const escalation = new EscalationManager({ state, telegram, dispatcher, audit });
  escalation.install();
  const supervise = new SuperviseTools(dispatcher);

  // Eager bot-token probe so a misconfigured token fails fast at startup with
  // a clear error in the MCP host log, rather than mysteriously timing out on
  // the first tool call.
  try {
    const me = await telegram.getMe();
    log.info("telegram.bot_identified", { username: me.username, id: me.id });
  } catch (err) {
    log.error("telegram.getme_failed", { error: String(err) });
    throw new Error(
      `Telegram getMe failed - check the bot token in extension settings. Underlying error: ${String(err)}`,
    );
  }

  // Start the Telegram poll loop NOW (not lazily on first dispatch) so:
  //   - Escalations Claw raises proactively are captured immediately,
  //     and `claw_check_escalations` returns them on first call.
  //   - The lastUpdateId watermark advances during quiet periods, so a
  //     restart after >24h doesn't miss messages Telegram has aged out.
  dispatcher.start();

  // Optional deep health probe gated by env (off by default to keep startup
  // fast). When on, we round-trip a /status through Claw so the MCP host log
  // contains a clear "Claw is reachable" or "Claw isn't reachable" verdict
  // before any tool call.
  if (config.startupHealthCheck) {
    try {
      const start = Date.now();
      const reply = await supervise.health();
      log.info("claw.startup_health_ok", {
        round_trip_ms: Date.now() - start,
        reply_preview: reply.reply.slice(0, 80),
      });
    } catch (err) {
      log.warn("claw.startup_health_failed", { error: String(err) });
      // Don't crash - the bridge can still serve supervise tools etc.
    }
  }

  const server = new McpServer(
    { name: "company-claw-bridge", version: "0.1.0" },
    {
      capabilities: {
        tools: { listChanged: false },
        logging: {},
      },
      // Keep instructions short. Tool names change; tool descriptions are the
      // authoritative discovery surface so we don't repeat them here.
      instructions:
        "Bridge to the company's central OpenClaw assistant over Telegram. Dispatch work, supervise running sessions, and answer escalations Claw raises with the configured marker.",
    },
  );

  registerTools({ server, dispatcher, escalation, supervise, state });

  const transport = new StdioServerTransport();
  await server.connect(transport);
  log.info("mcp.connected");

  const shutdown = async (signal: string): Promise<void> => {
    log.info("mcp.shutting_down", { signal });
    try {
      await dispatcher.stop();
      await telegram.drain();
      await state.drain();
      await state.releaseLock();
      await server.close();
    } catch (err) {
      log.warn("mcp.shutdown_error", { error: String(err) });
    } finally {
      process.exit(0);
    }
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

function registerTools(args: {
  server: McpServer;
  dispatcher: Dispatcher;
  escalation: EscalationManager;
  supervise: SuperviseTools;
  state: StateStore;
}): void {
  const { server, dispatcher, escalation, supervise } = args;

  server.registerTool(
    "claw_dispatch",
    {
      title: "Dispatch a task to Claw",
      description:
        "Send a task to the company's OpenClaw assistant over Telegram and wait for the full reply. Returns the reply text. If Claw escalates (asks Claude for help), the result includes escalation_id and escalation_question; answer it with claw_answer_escalation.",
      inputSchema: {
        task: z
          .string()
          .min(1)
          .describe("The task or instruction to send to Claw."),
        thinking: z
          .enum(["low", "medium", "high"])
          .optional()
          .describe("Optional /think level prefix Claw will use for this task."),
        timeout_ms: z
          .number()
          .int()
          .min(5_000)
          .max(3_600_000)
          .optional()
          .describe("Override the default Claw reply timeout (ms)."),
      },
    },
    async (input, extra) => {
      const command = input.thinking ? `/think ${input.thinking}` : undefined;
      const onProgress = makeProgressForwarder(extra);
      const result = await dispatcher.dispatch(input.task, {
        timeoutMs: input.timeout_ms,
        command,
        signal: extra.signal,
        onProgress,
      });
      return toToolResult(result);
    },
  );

  server.registerTool(
    "claw_dispatch_async",
    {
      title: "Dispatch a task to Claw (async)",
      description:
        "Send a task to Claw without waiting. Returns a request_id. Use claw_poll(request_id) to fetch incremental progress, or claw_cancel(request_id) to cancel.",
      inputSchema: {
        task: z.string().min(1),
        thinking: z.enum(["low", "medium", "high"]).optional(),
        timeout_ms: z.number().int().min(5_000).max(3_600_000).optional(),
      },
    },
    async (input) => {
      const command = input.thinking ? `/think ${input.thinking}` : undefined;
      const requestId = await dispatcher.dispatchAsync(input.task, {
        timeoutMs: input.timeout_ms,
        command,
      });
      return jsonResult({
        request_id: requestId,
        message: "Dispatched. Use claw_poll to read progress.",
      });
    },
  );

  server.registerTool(
    "claw_poll",
    {
      title: "Poll an async dispatch",
      description:
        "Return what Claw has produced so far for a previously-dispatched async task.",
      inputSchema: {
        request_id: z.string().min(1),
      },
    },
    async (input) => {
      const result = dispatcher.pollAsync(input.request_id);
      if (!result) {
        return errorResult(`Unknown request_id ${input.request_id}`);
      }
      return jsonResult(result);
    },
  );

  server.registerTool(
    "claw_cancel",
    {
      title: "Cancel an async dispatch",
      description:
        "Cancel an in-flight async dispatch by request_id. Sends /reset to Claw if it is currently working on the task.",
      inputSchema: {
        request_id: z.string().min(1),
      },
    },
    async (input) => {
      const ok = await dispatcher.cancelAsync(input.request_id);
      if (!ok) {
        return errorResult(`No cancellable request with id ${input.request_id}`);
      }
      return jsonResult({ request_id: input.request_id, cancelled: true });
    },
  );

  server.registerTool(
    "claw_status",
    {
      title: "Get Claw's /status",
      description: "Run /status on Claw and return the response.",
      inputSchema: {},
    },
    async () => jsonResult(await supervise.status()),
  );

  server.registerTool(
    "claw_health",
    {
      title: "Claw health probe",
      description:
        "Probe Claw with a /status round-trip to confirm Telegram routing and Claw responsiveness.",
      inputSchema: {},
    },
    async () => {
      const start = Date.now();
      try {
        const reply = await supervise.health();
        return jsonResult({
          healthy: true,
          round_trip_ms: Date.now() - start,
          reply: reply.reply,
        });
      } catch (err) {
        return jsonResult({
          healthy: false,
          round_trip_ms: Date.now() - start,
          error: String(err),
        });
      }
    },
  );

  server.registerTool(
    "claw_list_sessions",
    {
      title: "List Claw sessions",
      description: "Call Claw's sessions_list tool and return its session list.",
      inputSchema: {},
    },
    async () => jsonResult(await supervise.listSessions()),
  );

  server.registerTool(
    "claw_session_history",
    {
      title: "Read Claw session history",
      description: "Call Claw's sessions_history tool.",
      inputSchema: {
        session_id: z.string().min(1),
        limit: z.number().int().min(1).max(500).optional(),
      },
    },
    async (input) =>
      jsonResult(await supervise.sessionHistory(input.session_id, input.limit)),
  );

  server.registerTool(
    "claw_send_to_session",
    {
      title: "Send a message to a Claw session",
      description: "Call Claw's sessions_send tool to deliver a message to a specific session.",
      inputSchema: {
        session_id: z.string().min(1),
        message: z.string().min(1),
      },
    },
    async (input) =>
      jsonResult(await supervise.sendToSession(input.session_id, input.message)),
  );

  server.registerTool(
    "claw_set_verbosity",
    {
      title: "Set Claw verbosity",
      description:
        "Toggle Claw's /verbose, /trace, and /usage chat commands. At least one of the fields must be supplied.",
      inputSchema: {
        verbose: z.boolean().optional(),
        trace: z.boolean().optional(),
        usage: z.enum(["off", "tokens", "full"]).optional(),
      },
    },
    async (input) => jsonResult(await supervise.setVerbosity(input)),
  );

  server.registerTool(
    "claw_compact",
    {
      title: "Compact Claw context",
      description: "Send /compact to Claw to trim its current session context.",
      inputSchema: {},
    },
    async () => jsonResult(await supervise.compact()),
  );

  server.registerTool(
    "claw_new_session",
    {
      title: "Start a new Claw session",
      description: "Send /new to Claw to start a fresh session.",
      inputSchema: {},
    },
    async () => jsonResult(await supervise.newSession()),
  );

  server.registerTool(
    "claw_restart",
    {
      title: "Restart Claw session",
      description: "Send /restart to Claw.",
      inputSchema: {},
    },
    async () => jsonResult(await supervise.restart()),
  );

  server.registerTool(
    "claw_check_escalations",
    {
      title: "List pending escalations",
      description:
        "Return any pending escalations Claw has raised but Claude has not yet answered.",
      inputSchema: {},
    },
    async () => {
      const items = escalation.list();
      return jsonResult({
        count: items.length,
        escalations: items.map((e) => ({
          escalation_id: e.escalationId,
          request_id: e.requestId,
          question: e.question,
          raised_at: new Date(e.raisedAt).toISOString(),
        })),
      });
    },
  );

  server.registerTool(
    "claw_answer_escalation",
    {
      title: "Answer a Claw escalation",
      description:
        "Reply to a specific escalation by id. Posts [CLAUDE-REPLY:<id>] into the Telegram thread so Claw can continue.\n\n" +
        "IMPORTANT: This call closes the original dispatch from Claude's side - the returned object only confirms the answer was posted, it does NOT contain Claw's eventual follow-up reply. To collect what Claw produces after your answer, follow up with claw_dispatch_async / claw_poll or use claw_list_sessions + claw_session_history. The original request_id remains as historical reference; do not poll it for new content.",
      inputSchema: {
        escalation_id: z.string().min(1),
        answer: z.string().min(1),
      },
    },
    async (input) => {
      const result = await escalation.answer(input.escalation_id, input.answer);
      return jsonResult(result);
    },
  );
}

/**
 * Builds an onProgress callback for a dispatch that forwards each chunk to
 * the MCP client as a notifications/progress message keyed on the request's
 * progressToken. If the client did not request progress (no token), we just
 * no-op.
 */
function makeProgressForwarder(
  extra: RequestHandlerExtra<ServerRequest, ServerNotification>,
):
  | ((chunk: {
      text: string;
      delta: string;
      messageId: number;
      escalation: boolean;
    }) => Promise<void>)
  | undefined {
  const token = extra._meta?.progressToken;
  if (token === undefined) return undefined;
  let progress = 0;
  return async (chunk) => {
    progress += 1;
    try {
      await extra.sendNotification({
        method: "notifications/progress",
        params: {
          progressToken: token,
          progress,
          message:
            (chunk.escalation ? "[escalation] " : "") + chunk.delta.slice(0, 200),
        },
      });
    } catch (err) {
      log.warn("mcp.progress_send_failed", { error: String(err) });
    }
  };
}

function toToolResult(result: DispatchResult): CallToolResult {
  const payload: Record<string, unknown> = {
    request_id: result.requestId,
    reply: result.reply,
    escalated: result.escalated,
    outbound_message_id: result.outboundMessageId,
    inbound_message_ids: result.inboundMessageIds,
  };
  if (result.escalated) {
    payload.escalation_id = result.escalationId;
    payload.escalation_question = result.escalationQuestion;
    payload.next_step =
      `Claw is waiting on you. Answer with claw_answer_escalation(escalation_id="${result.escalationId}", answer="...").`;
  }
  return jsonResult(payload);
}

function jsonResult(obj: unknown): CallToolResult {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(obj, null, 2),
      },
    ],
  };
}

function errorResult(message: string): CallToolResult {
  return {
    isError: true,
    content: [{ type: "text", text: message }],
  };
}

main().catch((err) => {
  log.error("mcp.fatal", { error: String(err), stack: (err as Error)?.stack });
  process.exit(1);
});
