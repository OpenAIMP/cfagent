/**
 * Node test stub for the Think base class, whose Worker build imports
 * cloudflare:workers. Aliased for `@cloudflare/think` by vite.config.
 *
 * The stub backs the session accessors with a lazy in-memory store
 * (lazy so Object.create(prototype) test instances work without a
 * constructor run) and drives the class's real beforeTurn /
 * onChatResponse hooks from runTurn, returning a stubbed assistant
 * message — the provider boundary is stubbed, the lifecycle is not.
 * Schedule methods are inert; chat-turn state hooks are no-ops.
 */
export class Think<Env = unknown> {
  env!: Env;
  ctx: any;
  maxSteps?: number;

  constructor(ctx?: any, env?: Env) {
    this.ctx = ctx;
    this.env = env as Env;
  }

  private __store(): any[] {
    const self = this as any;
    if (!Array.isArray(self.__messages)) self.__messages = [];
    return self.__messages;
  }

  async getMessages(): Promise<any[]> {
    return [...this.__store()];
  }

  /** Session append/upsert by id, mirroring Think.addMessages. */
  async addMessages(messages: any[]): Promise<void> {
    const store = this.__store();
    for (const message of messages ?? []) {
      if (!message || typeof message.id !== "string") continue;
      const at = store.findIndex((m) => m.id === message.id);
      if (at >= 0) store[at] = message;
      else store.push(message);
    }
  }

  async saveMessages(messagesOrFactory: any, _options?: unknown): Promise<any> {
    const resolved =
      typeof messagesOrFactory === "function"
        ? messagesOrFactory([...this.__store()])
        : messagesOrFactory;
    await this.addMessages(resolved ?? []);
    const lastUser = [...(resolved ?? [])]
      .reverse()
      .find((m: any) => m?.role === "user");
    const text = (lastUser?.parts ?? [])
      .filter((p: any) => p?.type === "text")
      .map((p: any) => p.text)
      .join("");
    const turn = await this.runTurn({ input: text });
    return { requestId: (turn as any)?.requestId, messages: resolved };
  }

  async clearMessages(): Promise<void> {
    this.__store().length = 0;
  }

  get activeTurnMetadata(): Record<string, unknown> | undefined {
    return (this as any).__activeTurnMetadata;
  }

  /**
   * Drives the subclass's beforeTurn with a TurnContext built from
   * the stored session, records the applied TurnConfig on
   * `__turnConfig` for assertions, appends the stub assistant
   * message, fires onChatResponse, and returns a TurnResult.
   * `input.configOverride` short-circuits beforeTurn (the class's own
   * submit/continuation paths use it in other suites).
   */
  async runTurn(options: any): Promise<any> {
    const self = this as any;
    const requestId = `stub-req-${Math.random().toString(36).slice(2, 10)}`;
    const input = options?.input;
    if (typeof input === "string" && input) {
      await this.addMessages([
        { id: `stub-user-${requestId}`, role: "user", parts: [{ type: "text", text: input }] },
      ]);
    } else if (typeof input === "function") {
      // Factory form: receives current history, returns the new list;
      // upsert-by-id applies only the delta (Think's saveMessages
      // semantics).
      await this.addMessages(input(await this.getMessages()));
    } else if (Array.isArray(input)) {
      await this.addMessages(input);
    }
    const stored = await this.getMessages();
    const modelMessages = stored.map((m: any) => ({
      role: m.role,
      content: (m.parts ?? [])
        .filter((p: any) => p?.type === "text")
        .map((p: any) => p.text)
        .join(""),
    }));
    let config: any;
    if (input && typeof input === "object" && !Array.isArray(input) && input.configOverride) {
      config = input.configOverride;
    } else if (typeof self.beforeTurn === "function") {
      config = await self.beforeTurn({
        body: {
          turnId: requestId,
          trigger: "user_message",
          additions: [],
          messages: stored,
          userId: undefined,
          channel: undefined,
        },
        messages: modelMessages,
        requestId,
      });
    }
    self.__turnConfig = config;
    const message = {
      id: `stub-assistant-${requestId}`,
      role: "assistant",
      parts: [{ type: "text", text: "Stub assistant reply." }],
      metadata: {},
    };
    await this.addMessages([message]);
    const result = { message, requestId, continuation: false, status: "completed" };
    if (typeof self.onChatResponse === "function") {
      await self.onChatResponse(result);
    }
    return result;
  }

  async schedule(when: unknown, callback: string, payload?: unknown, options?: unknown): Promise<any> {
    return { id: `stub-schedule-${Math.random().toString(36).slice(2, 8)}`, when, callback, payload, options };
  }

  async scheduleEvery(intervalSeconds: number, callback: string, payload?: unknown): Promise<any> {
    return { id: `stub-schedule-${Math.random().toString(36).slice(2, 8)}`, intervalSeconds, callback, payload };
  }

  async cancelSchedule(_id: string): Promise<boolean> {
    return true;
  }

  async listSchedules(): Promise<any[]> {
    return [];
  }

  protected async waitUntilStable(_options?: { timeout?: number }): Promise<boolean> {
    return true;
  }

  protected resetTurnState(): void {}

  protected abortAllRequests(_reason?: unknown): void {}
}
