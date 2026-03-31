import type { App, BlockAction, ButtonAction } from "@slack/bolt";
import type { ISlackSendQueue } from "./send-queue.js";

export type PermissionResponseCallback = (requestId: string, optionId: string) => void;

export interface ISlackPermissionHandler {
  register(app: App): void;
  trackPendingMessage(requestId: string, channelId: string, messageTs: string): void;
  cleanupSession(channelId: string): Promise<void>;
}

export class SlackPermissionHandler implements ISlackPermissionHandler {
  private pendingMessages = new Map<string, { channelId: string; messageTs: string }>();

  constructor(
    private queue: ISlackSendQueue,
    private onResponse: PermissionResponseCallback,
  ) {}

  trackPendingMessage(requestId: string, channelId: string, messageTs: string): void {
    this.pendingMessages.set(requestId, { channelId, messageTs });
  }

  async cleanupSession(channelId: string): Promise<void> {
    for (const [requestId, info] of this.pendingMessages) {
      if (info.channelId !== channelId) continue;
      await this.queue.enqueue("chat.update", {
        channel: info.channelId,
        ts: info.messageTs,
        blocks: [],
      });
      this.pendingMessages.delete(requestId);
    }
  }

  register(app: App): void {
    // Match any action starting with "perm_action_"
    app.action<BlockAction<ButtonAction>>(
      /^perm_action_/,
      async ({ ack, body, action }) => {
        await ack();

        const value: string = action.value ?? "";
        const colonIdx = value.indexOf(":");
        if (colonIdx === -1) return;

        const requestId = value.slice(0, colonIdx);
        const optionId  = value.slice(colonIdx + 1);

        this.onResponse(requestId, optionId);

        // Remove from pending tracking since the user has responded
        this.pendingMessages.delete(requestId);

        // Update message: remove buttons, show resolved state
        const isAllow = optionId.includes("allow") || optionId.includes("yes");
        const icon = isAllow ? "✅" : "❌";
        const label = isAllow ? "Allowed" : "Denied";
        const userName = body.user?.name ?? body.user?.id ?? "unknown";

        try {
          await this.queue.enqueue("chat.update", {
            channel: body.channel?.id,
            ts: body.message?.ts,
            blocks: [
              {
                type: "context",
                elements: [
                  {
                    type: "mrkdwn",
                    text: `🔐 Permission — ${icon} ${label} by @${userName}`,
                  },
                ],
              },
            ],
            text: `Permission ${label}`,
          });
        } catch (err) {
          // Non-critical: log but don't fail
        }
      }
    );
  }
}
