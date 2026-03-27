// src/index.ts
import type { AdapterFactory } from "@openacp/cli";
import { SlackAdapter } from "./adapter.js";
import type { SlackChannelConfig } from "./types.js";

export const adapterFactory: AdapterFactory = {
  name: "slack",
  displayName: "Slack",
  method: "Socket Mode",
  createAdapter(core, config) {
    return new SlackAdapter(core, config as SlackChannelConfig);
  },
  async setup(existing) {
    const { setupSlack } = await import("./setup.js");
    return setupSlack(existing);
  },
};

export { SlackAdapter } from "./adapter.js";
export type { SlackChannelConfig, SlackSessionMeta, SlackFileInfo } from "./types.js";
export { generateSlackManifest, validateSlackBotToken } from "./setup.js";
export type { SlackManifest } from "./setup.js";
