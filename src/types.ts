// src/types.ts
import { z } from "zod";

/**
 * Slack channel configuration schema.
 * Defined locally (was previously part of OpenACP core config).
 */
export const SlackChannelConfigSchema = z.object({
  enabled: z.boolean().default(false),
  adapter: z.literal("slack").optional(),
  botToken: z.string().optional(),       // xoxb-...
  appToken: z.string().optional(),       // xapp-... (Socket Mode)
  signingSecret: z.string().optional(),
  notificationChannelId: z.string().optional(),
  allowedUserIds: z.array(z.string()).default([]),
  channelPrefix: z.string().default("openacp"),
  autoCreateSession: z.boolean().default(true),
  startupChannelId: z.string().optional(),
});

export type SlackChannelConfig = z.infer<typeof SlackChannelConfigSchema>;

// Per-session metadata stored in SessionRecord.platform
export interface SlackSessionMeta {
  channelId: string;     // Slack channel ID for this session (C...)
  channelSlug: string;   // e.g. "openacp-fix-auth-bug-a3k9"
}

/** Minimal file metadata extracted from Slack message events (subtype: file_share) */
export interface SlackFileInfo {
  id: string;
  name: string;
  mimetype: string;
  size: number;
  url_private: string;
}
