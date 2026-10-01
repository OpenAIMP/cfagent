import { planNLQ, executeNLQQueryAsync } from "../src/agents/nlq";
import { DatabaseORM } from "../src/db/orm";
import { ETradeVoiceTradingService } from "../src/trading/voice/agent";

async function main() {
  const env = {};
  const query = "Screen tech stocks with RSI under 40";
  const plan = planNLQ(env, query);
  console.log("Plan:", JSON.stringify(plan, null, 2));

  const orm = new DatabaseORM({ exec: () => [] } as any);
  const result = await executeNLQQueryAsync(orm, "test-session", plan, env, "test-session");
  console.log("NLQ Result status:", result.status);
  console.log("NLQ Result count:", result.count);
  console.log("NLQ Result summary:", result.summary);
  console.log("NLQ Result rows count:", result.rows?.length);

  const voice = new ETradeVoiceTradingService({ env, orm, sessionId: "test-session" });
  const turn = await voice.handleVoiceNLQ(query, "did:key:user");
  console.log("Voice Turn spoken:", turn.spokenText);
  console.log("Voice Turn display:", turn.displayMarkdown);
}

main().catch(console.error);
