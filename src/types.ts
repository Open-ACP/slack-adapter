// src/types.ts
import { z } from "zod";

export const SlackChannelConfigSchema = z.object({
  enabled: z.boolean().default(false),
  adapter: z.string().optional(),
  botToken: z.string().optional(),
  appToken: z.string().optional(),
  signingSecret: z.string().optional(),
  notificationChannelId: z.string().optional(),
  allowedUserIds: z.array(z.string()).default([]),
  channelPrefix: z.string().default("openacp"),
  autoCreateSession: z.boolean().default(true),
  startupChannelId: z.string().optional(),
});

export type SlackChannelConfig = z.infer<typeof SlackChannelConfigSchema>;

/** Per-session metadata stored in SessionRecord.platform */
export interface SlackSessionMeta {
  channelId: string;
  channelSlug: string;
}

/** Minimal file metadata extracted from Slack message events (subtype: file_share) */
export interface SlackFileInfo {
  id: string;
  name: string;
  mimetype: string;
  size: number;
  url_private: string;
}
