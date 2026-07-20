/**
 * Minimal JSON-RPC (JSONL over stdio) driver for `codex app-server`.
 *
 * Contract-test infrastructure for #321 — NOT shipped library code. The real
 * CodexRunner adapter (#326+) will own a production-grade client; this driver
 * exists so the contract tests can speak the protocol directly and assert on
 * raw wire shapes.
 *
 * Protocol facts this driver encodes (verified against codex-cli 0.144.6):
 * - transport: newline-delimited JSON (JSONL) over stdio; `codex app-server`
 *   with no flags defaults to `--listen stdio://`.
 * - handshake: client sends `initialize` (clientInfo required) then the
 *   `initialized` notification; server responds with userAgent + codexHome.
 * - bidirectional: the server issues its own requests (approvals, tool calls)
 *   that the client must answer via a JSON-RPC *response* carrying the same id.
 * - ids: plain integers work; request/response correlation is by id only.
 */
import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { createInterface } from "node:readline";

export interface JsonRpcRequest {
  jsonrpc?: "2.0";
  id: number | string;
  method: string;
  params?: unknown;
}

export interface JsonRpcNotification {
  jsonrpc?: "2.0";
  method: string;
  params?: unknown;
}

export interface CapturedMessage {
  dir: "send" | "recv";
  at: number;
  msg: Record<string, unknown>;
}

export type ServerRequestHandler = (
  params: unknown,
  respond: (result: unknown) => void,
  raw: JsonRpcRequest,
) => void | Promise<void>;

export interface AppServerOptions {
  codexHome: string;
  cwd?: string;
  env?: Record<string, string>;
  /** extra -c key=value config overrides */
  configOverrides?: string[];
  binary?: string;
}

export class AppServerClient {
  readonly proc: ChildProcessWithoutNullStreams;
  readonly capture: CapturedMessage[] = [];
  readonly notifications: Array<{ method: string; params: unknown }> = [];
  readonly serverRequests: JsonRpcRequest[] = [];
  readonly stderr: string[] = [];

  private nextId = 1;
  private pending = new Map<
    number | string,
    { resolve: (v: unknown) => void; reject: (e: Error) => void }
  >();
  private requestHandlers = new Map<string, ServerRequestHandler>();
  private notificationWaiters: Array<{
    predicate: (n: { method: string; params: unknown }) => boolean;
    resolve: (n: { method: string; params: unknown }) => void;
  }> = [];
  private serverRequestWaiters: Array<{
    predicate: (r: JsonRpcRequest) => boolean;
    resolve: (r: JsonRpcRequest) => void;
  }> = [];
  private exited: Promise<{ code: number | null; signal: string | null }>;

  constructor(opts: AppServerOptions) {
    const args = ["app-server", ...(opts.configOverrides ?? []).flatMap((o) => ["-c", o])];
    this.proc = spawn(opts.binary ?? "codex", args, {
      cwd: opts.cwd,
      env: {
        ...process.env,
        CODEX_HOME: opts.codexHome,
        ...opts.env,
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const rl = createInterface({ input: this.proc.stdout });
    rl.on("line", (line) => this.onLine(line));
    const rlErr = createInterface({ input: this.proc.stderr });
    rlErr.on("line", (line) => this.stderr.push(line));
    this.exited = new Promise((resolve) => {
      this.proc.on("exit", (code, signal) => resolve({ code, signal }));
    });
  }

  private onLine(line: string): void {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(line) as Record<string, unknown>;
    } catch {
      this.stderr.push(`[non-json stdout] ${line}`);
      return;
    }
    this.capture.push({ dir: "recv", at: Date.now(), msg });

    if ("id" in msg && ("result" in msg || "error" in msg)) {
      // response to one of our requests
      const entry = this.pending.get(msg.id as number | string);
      if (entry) {
        this.pending.delete(msg.id as number | string);
        if ("error" in msg) {
          entry.reject(new Error(`rpc error: ${JSON.stringify(msg.error)}`));
        } else {
          entry.resolve(msg.result);
        }
      }
      return;
    }
    if ("id" in msg && "method" in msg) {
      // server-initiated request
      const req = msg as unknown as JsonRpcRequest;
      this.serverRequests.push(req);
      for (let i = 0; i < this.serverRequestWaiters.length; i++) {
        const waiter = this.serverRequestWaiters[i];
        if (waiter?.predicate(req)) {
          this.serverRequestWaiters.splice(i, 1);
          waiter.resolve(req);
          break;
        }
      }
      const handler = this.requestHandlers.get(req.method);
      if (handler) {
        void handler(req.params, (result) => this.respond(req.id, result), req);
      }
      return;
    }
    if ("method" in msg) {
      const note = { method: msg.method as string, params: msg.params };
      this.notifications.push(note);
      for (let i = 0; i < this.notificationWaiters.length; i++) {
        const waiter = this.notificationWaiters[i];
        if (waiter?.predicate(note)) {
          this.notificationWaiters.splice(i, 1);
          waiter.resolve(note);
        }
      }
    }
  }

  private write(msg: Record<string, unknown>): void {
    this.capture.push({ dir: "send", at: Date.now(), msg });
    this.proc.stdin.write(`${JSON.stringify(msg)}\n`);
  }

  request<T = unknown>(method: string, params?: unknown, timeoutMs = 120_000): Promise<T> {
    const id = this.nextId++;
    const p = new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`timeout waiting for response to ${method} (id ${id})`));
        }
      }, timeoutMs);
    });
    this.write({ jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) });
    return p;
  }

  notify(method: string, params?: unknown): void {
    this.write({ jsonrpc: "2.0", method, ...(params === undefined ? {} : { params }) });
  }

  respond(id: number | string, result: unknown): void {
    this.write({ jsonrpc: "2.0", id, result });
  }

  respondError(id: number | string, code: number, message: string): void {
    this.write({ jsonrpc: "2.0", id, error: { code, message } });
  }

  /** Register a handler for server-initiated requests of a given method. */
  onServerRequest(method: string, handler: ServerRequestHandler): void {
    this.requestHandlers.set(method, handler);
  }

  waitForNotification(
    predicate: (n: { method: string; params: unknown }) => boolean,
    timeoutMs = 120_000,
    label = "notification",
  ): Promise<{ method: string; params: unknown }> {
    const existing = this.notifications.find(predicate);
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve, reject) => {
      this.notificationWaiters.push({ predicate, resolve });
      setTimeout(() => reject(new Error(`timeout waiting for ${label}`)), timeoutMs);
    });
  }

  waitForServerRequest(
    predicate: (r: JsonRpcRequest) => boolean,
    timeoutMs = 120_000,
    label = "server request",
  ): Promise<JsonRpcRequest> {
    const existing = this.serverRequests.find(predicate);
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve, reject) => {
      this.serverRequestWaiters.push({ predicate, resolve });
      setTimeout(() => reject(new Error(`timeout waiting for ${label}`)), timeoutMs);
    });
  }

  /** Standard handshake. Returns the initialize result. */
  async initialize(experimentalApi = false): Promise<Record<string, unknown>> {
    const result = (await this.request("initialize", {
      clientInfo: { name: "agentic-patterns-contract-tests", version: "0.0.0" },
      capabilities: { experimentalApi },
    })) as Record<string, unknown>;
    this.notify("initialized");
    return result;
  }

  async close(): Promise<{ code: number | null; signal: string | null }> {
    this.proc.stdin.end();
    const result = await Promise.race([
      this.exited,
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 3000)),
    ]);
    if (result === null) {
      this.proc.kill("SIGKILL");
      return this.exited;
    }
    return result;
  }
}
