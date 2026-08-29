import { domainMigration, init } from "./editor.mjs";
import { installAgentGlobals } from "./agent-commands.mjs";

export function start() {
  window.carouselBotDomainMigration = domainMigration;
  installAgentGlobals();
  return init();
}
