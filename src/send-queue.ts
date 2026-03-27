import PQueue from "p-queue";
import type { WebClient } from "@slack/web-api";

export type SlackMethod =
  | "chat.postMessage"
  | "chat.update"
  | "conversations.create"
  | "conversations.rename"
  | "conversations.archive"
  | "conversations.invite"
  | "conversations.join"
  | "conversations.unarchive"
  | "conversations.info";

const METHOD_RPM: Record<SlackMethod, number> = {
  "chat.postMessage":      50,
  "chat.update":           50,
  "conversations.create":  20,
  "conversations.rename":  20,
  "conversations.archive": 20,
  "conversations.invite":  20,
  "conversations.join":    20,
  "conversations.unarchive": 20,
  "conversations.info":      50,
};

export interface ISlackSendQueue {
  enqueue<T = unknown>(method: SlackMethod, params: Record<string, unknown>): Promise<T>;
}

export class SlackSendQueue implements ISlackSendQueue {
  private queues = new Map<SlackMethod, PQueue>();

  constructor(private client: WebClient) {
    for (const [method, rpm] of Object.entries(METHOD_RPM) as [SlackMethod, number][]) {
      this.queues.set(method, new PQueue({
        interval: Math.ceil(60_000 / rpm),
        intervalCap: 1,
        carryoverConcurrencyCount: true,
      }));
    }
  }

  async enqueue<T = unknown>(method: SlackMethod, params: Record<string, unknown>): Promise<T> {
    const queue = this.queues.get(method);
    if (!queue) throw new Error(`Unknown Slack method: ${method}`);
    return queue.add(() => this.client.apiCall(method, params) as Promise<T>);
  }
}
