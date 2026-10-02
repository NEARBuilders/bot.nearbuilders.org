import { Agent as HttpsAgent } from "node:https";

export const telegramAgent = new HttpsAgent({
  family: 4,
  keepAlive: true,
  keepAliveMsecs: 10_000,
});
