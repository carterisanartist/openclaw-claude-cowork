import type { Dispatcher } from "./dispatcher.js";

/**
 * Thin wrappers around Claw's built-in chat commands and session tools.
 *
 * Every supervise call is a dispatcher.dispatch under the hood. We keep the
 * timeouts short because these are interactive operator commands; if Claw
 * isn't responsive within ~30s something is wrong and the user wants to
 * know immediately, not wait three minutes.
 *
 * For commands where Claw's reply is structured but free-form (status,
 * sessions_list), we return the raw text to Claude and let the LLM do the
 * parsing. Hard-parsing here would just lose information.
 */

const SHORT_TIMEOUT_MS = 30_000;

export interface SuperviseReply {
  command: string;
  reply: string;
  requestId: string;
}

export class SuperviseTools {
  constructor(private readonly dispatcher: Dispatcher) {}

  async status(): Promise<SuperviseReply> {
    return this.runCommand("/status");
  }

  async health(): Promise<SuperviseReply> {
    // Same wire effect as status() but tagged as a health probe so logs are
    // distinguishable. Claw's /status is the closest thing to a heartbeat
    // exposed over chat.
    return this.runCommand("/status", { tag: "health" });
  }

  async listSessions(): Promise<SuperviseReply> {
    return this.runCommand("sessions_list");
  }

  async sessionHistory(sessionId: string, limit?: number): Promise<SuperviseReply> {
    const args = limit !== undefined ? ` limit=${limit}` : "";
    return this.runCommand(`sessions_history session_id=${sessionId}${args}`);
  }

  async sendToSession(sessionId: string, message: string): Promise<SuperviseReply> {
    const safe = message.replaceAll('"', '\\"');
    return this.runCommand(`sessions_send session_id=${sessionId} message="${safe}"`);
  }

  async setVerbosity(opts: {
    verbose?: boolean;
    trace?: boolean;
    usage?: "off" | "tokens" | "full";
  }): Promise<SuperviseReply[]> {
    const calls: SuperviseReply[] = [];
    if (opts.verbose !== undefined) {
      calls.push(await this.runCommand(`/verbose ${opts.verbose ? "on" : "off"}`));
    }
    if (opts.trace !== undefined) {
      calls.push(await this.runCommand(`/trace ${opts.trace ? "on" : "off"}`));
    }
    if (opts.usage !== undefined) {
      calls.push(await this.runCommand(`/usage ${opts.usage}`));
    }
    if (calls.length === 0) {
      throw new Error(
        "claw_set_verbosity requires at least one of verbose, trace, or usage to be set.",
      );
    }
    return calls;
  }

  async compact(): Promise<SuperviseReply> {
    return this.runCommand("/compact");
  }

  async newSession(): Promise<SuperviseReply> {
    return this.runCommand("/new");
  }

  async restart(): Promise<SuperviseReply> {
    return this.runCommand("/restart");
  }

  private async runCommand(
    command: string,
    _opts: { tag?: string } = {},
  ): Promise<SuperviseReply> {
    // The dispatcher always wraps with [req:<id>] for correlation; supervise
    // commands benefit from that just like dispatches do, because a noisy
    // chat with multiple overlapping requests would otherwise mis-attribute
    // replies.
    const result = await this.dispatcher.dispatch(command, {
      timeoutMs: SHORT_TIMEOUT_MS,
    });
    return {
      command,
      reply: result.reply,
      requestId: result.requestId,
    };
  }
}
