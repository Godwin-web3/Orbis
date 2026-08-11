import { FileCandidateSource } from "./discovery/index";
import { FixtureSimulator } from "./simulation/fixture";
import { buildRuntime } from "./app/runtime";

const mode = process.env.ENGINE_MODE ?? "dry-run";
const engine = mode === "live-readonly" ? buildRuntime() : new (await import("./app/engine")).MintEngine({
  sources: [new FileCandidateSource()],
  classifier: new (await import("./core/classifier")).RuleClassifier(),
  opportunities: new (await import("./core/opportunity")).DefaultOpportunityEngine(),
  simulator: new FixtureSimulator(),
  policy: new (await import("./execution/policy")).DefaultPolicyEngine(),
  store: new (await import("./storage/memory")).MemoryCandidateStore(),
  notifications: new (await import("./notifications/console")).ConsoleNotificationSink(),
});
const result = await engine.run();
console.log(`processed ${result.count} candidates in ${mode} mode`);
