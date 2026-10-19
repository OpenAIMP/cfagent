/** Node test stub for the Think base class, whose Worker build imports cloudflare:workers. */
export class Think<Env = unknown> {
  env!: Env;
  ctx: any;

  constructor(ctx?: any, env?: Env) {
    this.ctx = ctx;
    this.env = env as Env;
  }
}
