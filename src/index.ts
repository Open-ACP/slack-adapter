// src/index.ts
import type { AdapterFactory } from "@openacp/cli";
import { SlackAdapter } from "./adapter.js";
import type { SlackChannelConfig } from "./types.js";

export const adapterFactory: AdapterFactory = {
  name: "slack",
  createAdapter(core, config) {
    return new SlackAdapter(core, config as SlackChannelConfig);
  },
};

export { SlackAdapter } from "./adapter.js";
export type { SlackChannelConfig, SlackSessionMeta, SlackFileInfo } from "./types.js";
