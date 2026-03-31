# Slack Output Mode & Thread-Based Rendering — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement output modes (low/medium/high) with thread-based rendering and Slack modals for the Slack adapter.

**Architecture:** Rewrite the Slack adapter's rendering layer to use core adapter-primitives (`ToolStateMap`, `DisplaySpecBuilder`, `OutputModeResolver`, `ToolCardState`, `ThoughtBuffer`). Each prompt turn gets a main message (edited with progress) and a thread for tool card details. Final text and permissions go directly in the channel. `/outputmode` opens a Slack modal.

**Tech Stack:** TypeScript, @slack/bolt, @slack/web-api, @openacp/plugin-sdk, Slack Block Kit, Slack Modals (views.open)

**Spec:** `docs/superpowers/specs/2026-03-31-slack-output-mode-design.md`

---

## Prerequisite: Export Core Primitives from Plugin SDK

The following core primitives are used by the Telegram adapter internally but are **not exported** from `@openacp/plugin-sdk`:

- `ToolStateMap`, `ThoughtBuffer` (from `stream-accumulator.ts`)
- `DisplaySpecBuilder`, `ToolDisplaySpec` (from `display-spec-builder.ts`)
- `OutputModeResolver` (from `output-mode-resolver.ts`)
- `ToolCardState`, `ToolCardSnapshot`, `UsageData` (from `primitives/tool-card-state.ts`)
- `OutputMode` type (from `format-types.ts`)

**These must be exported before the Slack adapter can use them.** This requires changes in the **OpenACP repo** (not the slack-adapter repo):

1. `src/core/adapter-primitives/index.ts` — add exports for `ToolStateMap`, `ThoughtBuffer`, `DisplaySpecBuilder`, `OutputModeResolver`, `ToolCardState`, `ToolCardSnapshot`, `OutputMode`
2. `packages/plugin-sdk/src/index.ts` — re-export these from `@openacp/cli`
3. Publish new `@openacp/plugin-sdk` version

**This prerequisite is out of scope for this plan.** It must be completed first in the OpenACP repo. Once done, update `@openacp/plugin-sdk` peer dependency version in this repo's `package.json`.

---

## File Structure

### New Files
| File | Responsibility |
|------|---------------|
| `src/activity-tracker.ts` | `SlackActivityTracker` — wraps core primitives, manages main message + thread per turn |
| `src/tool-card-renderer.ts` | `SlackToolCardRenderer` — converts `ToolCardSnapshot` → Slack Block Kit blocks |
| `src/modal-handler.ts` | `SlackModalHandler` — `/outputmode` modal: open, render, handle submit |

### Modified Files
| File | Changes |
|------|---------|
| `src/adapter.ts` | Add `OutputModeResolver`, wire `SlackActivityTracker`, thread management, override `handleToolCall`/`handleToolUpdate`/`handleThought`/`handlePlan`/`handleUsage`/`handleText` |
| `src/formatter.ts` | Remove tool_call/tool_update/thought/plan/usage rendering from `formatOutgoing()`. Keep `markdownToMrkdwn()`, `formatPermissionRequest()`, `section()`, `context()`, text formatting |
| `src/renderer.ts` | Remove `renderToolCall`/`renderToolUpdate`/`renderThought`/`renderPlan`/`renderUsage` (delegate to ActivityTracker). Keep `renderText`, `renderError`, `renderSessionEnd`, `renderPermission`, `renderNotification`, etc. |
| `src/send-queue.ts` | Add `"chat.update"` to `SlackMethod` type and `METHOD_RPM` map |
| `src/permission-handler.ts` | Update resolved message format to use Block Kit context block after user clicks |
| `src/types.ts` | Add `TurnState` interface, `OutputMode` re-export |
| `src/index.ts` | Register modal handler, `/outputmode` slash command |

### Unchanged Files
| File | Reason |
|------|--------|
| `src/text-buffer.ts` | Still flushes text to channel (not thread) |
| `src/channel-manager.ts` | Channel lifecycle unchanged |
| `src/event-router.ts` | Incoming message routing unchanged |
| `src/slug.ts` | Slug generation unchanged |
| `src/utils.ts` | Utilities unchanged |
| `src/setup.ts` | Setup wizard unchanged |

---

## Task 1: Add `chat.update` to SendQueue

**Files:**
- Modify: `src/send-queue.ts`
- Test: `src/__tests__/send-queue.test.ts`

- [ ] **Step 1: Write test for chat.update method support**

```typescript
// In send-queue.test.ts, add:
it("should accept chat.update as a valid method", async () => {
  const mockClient = {
    apiCall: vi.fn().mockResolvedValue({ ok: true, ts: "123.456" }),
  } as unknown as WebClient;
  const queue = new SlackSendQueue(mockClient);

  const result = await queue.enqueue("chat.update", {
    channel: "C123",
    ts: "111.222",
    blocks: [],
  });

  expect(mockClient.apiCall).toHaveBeenCalledWith("chat.update", {
    channel: "C123",
    ts: "111.222",
    blocks: [],
  });
  expect(result).toEqual({ ok: true, ts: "123.456" });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/lucas/openacp-workspace/slack-adapter && npx vitest run src/__tests__/send-queue.test.ts -t "chat.update"`
Expected: TypeScript compile error — `"chat.update"` not in `SlackMethod` union type.

- [ ] **Step 3: Add chat.update to SlackMethod and METHOD_RPM**

In `src/send-queue.ts`, add `"chat.update"` to the `SlackMethod` type union and `METHOD_RPM` map:

```typescript
export type SlackMethod =
  | "chat.postMessage"
  | "chat.update"          // <-- add this
  | "conversations.create"
  // ... rest unchanged

const METHOD_RPM: Record<SlackMethod, number> = {
  "chat.postMessage": 50,
  "chat.update": 50,       // <-- add this (Tier 3, same as postMessage)
  "conversations.create": 20,
  // ... rest unchanged
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /Users/lucas/openacp-workspace/slack-adapter && npx vitest run src/__tests__/send-queue.test.ts`
Expected: All tests pass.

- [ ] **Step 5: Commit**

```bash
cd /Users/lucas/openacp-workspace/slack-adapter
git add src/send-queue.ts src/__tests__/send-queue.test.ts
git commit -m "feat: add chat.update method to SlackSendQueue"
```

---

## Task 2: Add TurnState type to types.ts

**Files:**
- Modify: `src/types.ts`

- [ ] **Step 1: Add TurnState interface**

Add to `src/types.ts`:

```typescript
/** State for a single prompt turn within a session */
export interface TurnState {
  /** Timestamp of the main progress message (used for editing and as thread parent) */
  mainMessageTs: string;
  /** Same as mainMessageTs — thread replies use this as thread_ts */
  threadTs: string;
  /** Timestamp of current aggregated tool card message in thread */
  currentToolCardTs?: string;
  /** Whether this turn has been finalized */
  isFinalized: boolean;
}
```

- [ ] **Step 2: Commit**

```bash
cd /Users/lucas/openacp-workspace/slack-adapter
git add src/types.ts
git commit -m "feat: add TurnState interface for thread-based rendering"
```

---

## Task 3: SlackToolCardRenderer — Block Kit rendering

**Files:**
- Create: `src/tool-card-renderer.ts`
- Test: `src/__tests__/tool-card-renderer.test.ts`

- [ ] **Step 1: Write failing tests for tool card rendering**

Create `src/__tests__/tool-card-renderer.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { SlackToolCardRenderer } from "../tool-card-renderer.js";
import type { ToolCardSnapshot, ToolDisplaySpec } from "@openacp/plugin-sdk";

function makeSpec(overrides: Partial<ToolDisplaySpec> = {}): ToolDisplaySpec {
  return {
    id: "tool-1",
    kind: "edit",
    icon: "✏️",
    title: "src/auth.ts",
    description: "Fixed validation logic",
    command: null,
    inputContent: null,
    outputSummary: null,
    outputContent: null,
    diffStats: { added: 5, removed: 2 },
    viewerLinks: undefined,
    outputViewerLink: undefined,
    outputFallbackContent: undefined,
    status: "completed",
    isNoise: false,
    isHidden: false,
    ...overrides,
  };
}

function makeSnapshot(overrides: Partial<ToolCardSnapshot> = {}): ToolCardSnapshot {
  return {
    specs: [makeSpec()],
    totalVisible: 1,
    completedVisible: 1,
    allComplete: true,
    ...overrides,
  };
}

describe("SlackToolCardRenderer", () => {
  const renderer = new SlackToolCardRenderer();

  describe("renderToolCard", () => {
    it("renders a completed tool as Block Kit blocks", () => {
      const blocks = renderer.renderToolCard(makeSnapshot());

      // Should have at least a context block with icon+title and description
      expect(blocks.length).toBeGreaterThanOrEqual(1);
      const text = JSON.stringify(blocks);
      expect(text).toContain("✏️");
      expect(text).toContain("src/auth.ts");
      expect(text).toContain("Fixed validation logic");
      expect(text).toContain("+5/-2");
    });

    it("hides hidden specs", () => {
      const blocks = renderer.renderToolCard(
        makeSnapshot({
          specs: [makeSpec({ isHidden: true })],
          totalVisible: 0,
          completedVisible: 0,
        }),
      );

      const text = JSON.stringify(blocks);
      expect(text).not.toContain("src/auth.ts");
    });

    it("renders inline output content on high mode", () => {
      const blocks = renderer.renderToolCard(
        makeSnapshot({
          specs: [makeSpec({ outputContent: 'console.log("hello")' })],
        }),
      );

      const text = JSON.stringify(blocks);
      expect(text).toContain('console.log("hello")');
    });

    it("renders viewer links as mrkdwn links", () => {
      const blocks = renderer.renderToolCard(
        makeSnapshot({
          specs: [
            makeSpec({
              viewerLinks: { file: "https://example.com/file", diff: "https://example.com/diff" },
              outputViewerLink: "https://example.com/output",
            }),
          ],
        }),
      );

      const text = JSON.stringify(blocks);
      expect(text).toContain("https://example.com/file");
      expect(text).toContain("https://example.com/diff");
      expect(text).toContain("https://example.com/output");
    });

    it("renders multiple tools aggregated", () => {
      const blocks = renderer.renderToolCard(
        makeSnapshot({
          specs: [
            makeSpec({ id: "t1", title: "file1.ts" }),
            makeSpec({ id: "t2", title: "file2.ts", status: "running" }),
          ],
          totalVisible: 2,
          completedVisible: 1,
          allComplete: false,
        }),
      );

      const text = JSON.stringify(blocks);
      expect(text).toContain("file1.ts");
      expect(text).toContain("file2.ts");
    });

    it("renders usage data when present", () => {
      const blocks = renderer.renderToolCard(
        makeSnapshot({
          usage: { tokensUsed: 12500, cost: 0.03 },
        }),
      );

      const text = JSON.stringify(blocks);
      expect(text).toContain("12.5k");
      expect(text).toContain("0.03");
    });
  });

  describe("renderMainMessage", () => {
    it("renders in-progress state", () => {
      const blocks = renderer.renderMainMessage(
        makeSnapshot({ allComplete: false, completedVisible: 1, totalVisible: 3 }),
        false,
      );

      const text = JSON.stringify(blocks);
      expect(text).toContain("Processing");
      expect(text).toContain("1/3");
    });

    it("renders completed state", () => {
      const blocks = renderer.renderMainMessage(makeSnapshot(), true);

      const text = JSON.stringify(blocks);
      expect(text).toContain("Done");
    });

    it("renders low mode completed (minimal)", () => {
      const blocks = renderer.renderMainMessageLow(true);

      const text = JSON.stringify(blocks);
      expect(text).toContain("Done");
      // Should NOT contain tool counts or usage
      expect(text).not.toContain("tokens");
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/lucas/openacp-workspace/slack-adapter && npx vitest run src/__tests__/tool-card-renderer.test.ts`
Expected: FAIL — `../tool-card-renderer.js` does not exist.

- [ ] **Step 3: Implement SlackToolCardRenderer**

Create `src/tool-card-renderer.ts`:

```typescript
import type { KnownBlock } from "@slack/bolt";
import type { ToolCardSnapshot, ToolDisplaySpec } from "@openacp/plugin-sdk";

const DONE_STATUSES = new Set(["completed", "done", "failed", "error"]);

function statusIcon(status: string): string {
  if (status === "error" || status === "failed") return "❌";
  if (DONE_STATUSES.has(status)) return "✅";
  return "🔄";
}

function formatTokens(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

function section(text: string): KnownBlock {
  return { type: "section", text: { type: "mrkdwn", text } };
}

function ctx(text: string): KnownBlock {
  return { type: "context", elements: [{ type: "mrkdwn", text }] };
}

function renderSpecBlocks(spec: ToolDisplaySpec): KnownBlock[] {
  const blocks: KnownBlock[] = [];

  // Title line: status + icon + title + diff stats
  let titleParts = `${statusIcon(spec.status)} ${spec.icon} *${spec.title}*`;
  if (spec.diffStats) {
    titleParts += `  |  _+${spec.diffStats.added}/-${spec.diffStats.removed}_`;
  }
  blocks.push(ctx(titleParts));

  // Description
  if (spec.description) {
    blocks.push(ctx(`_${spec.description}_`));
  }

  // Command
  if (spec.command) {
    blocks.push(ctx(`\`${spec.command}\``));
  }

  // Output summary
  if (spec.outputSummary) {
    blocks.push(ctx(spec.outputSummary));
  }

  // Inline output content (high mode, short output)
  if (spec.outputContent) {
    blocks.push(section("```\n" + spec.outputContent + "\n```"));
  }

  // Fallback content (high mode, no tunnel)
  if (!spec.outputContent && spec.outputFallbackContent) {
    blocks.push(section("```\n" + spec.outputFallbackContent + "\n```"));
  }

  // Viewer links
  const links: string[] = [];
  if (spec.viewerLinks?.file) links.push(`<${spec.viewerLinks.file}|View File>`);
  if (spec.viewerLinks?.diff) links.push(`<${spec.viewerLinks.diff}|View Diff>`);
  if (spec.outputViewerLink) links.push(`<${spec.outputViewerLink}|View Output>`);
  if (links.length > 0) {
    blocks.push(ctx(links.join("  ·  ")));
  }

  return blocks;
}

export class SlackToolCardRenderer {
  /**
   * Render a full tool card snapshot as Block Kit blocks for a thread reply.
   */
  renderToolCard(snapshot: ToolCardSnapshot): KnownBlock[] {
    const visible = snapshot.specs.filter((s) => !s.isHidden);
    if (visible.length === 0) return [];

    const blocks: KnownBlock[] = [];

    // Completed tools first, then running
    const completed = visible.filter((s) => DONE_STATUSES.has(s.status));
    const running = visible.filter((s) => !DONE_STATUSES.has(s.status));

    for (const spec of completed) {
      blocks.push(...renderSpecBlocks(spec));
    }
    for (const spec of running) {
      blocks.push(...renderSpecBlocks(spec));
    }

    // Usage footer
    if (snapshot.usage) {
      const parts: string[] = [];
      if (snapshot.usage.tokensUsed) parts.push(`${formatTokens(snapshot.usage.tokensUsed)} tokens`);
      if (snapshot.usage.cost != null) parts.push(`$${snapshot.usage.cost.toFixed(2)}`);
      if (parts.length > 0) {
        blocks.push({ type: "divider" } as KnownBlock);
        blocks.push(ctx(`📊 ${parts.join(" · ")}`));
      }
    }

    return blocks;
  }

  /**
   * Render the main progress message (medium/high mode).
   */
  renderMainMessage(snapshot: ToolCardSnapshot, isComplete: boolean): KnownBlock[] {
    const visible = snapshot.specs.filter((s) => !s.isHidden);

    if (isComplete) {
      const blocks: KnownBlock[] = [section("✅ *Done*")];

      // Tool count summary by kind
      if (visible.length > 0) {
        const kindCounts = new Map<string, number>();
        for (const s of visible) {
          const icon = s.icon || "🔧";
          kindCounts.set(icon, (kindCounts.get(icon) || 0) + 1);
        }
        const summary = [...kindCounts.entries()].map(([icon, n]) => `${icon} ×${n}`).join("  ");
        blocks.push(ctx(summary));
      }

      // Usage
      if (snapshot.usage) {
        const parts: string[] = [];
        if (snapshot.usage.tokensUsed) parts.push(`${formatTokens(snapshot.usage.tokensUsed)} tokens`);
        if (snapshot.usage.cost != null) parts.push(`$${snapshot.usage.cost.toFixed(2)}`);
        if (parts.length > 0) blocks.push(ctx(`📊 ${parts.join(" · ")}`));
      }

      return blocks;
    }

    // In-progress
    const blocks: KnownBlock[] = [section("🔧 *Processing...*")];

    // Show completed + current tool
    for (const spec of visible) {
      const icon = statusIcon(spec.status);
      blocks.push(ctx(`${icon} ${spec.title}`));
    }

    blocks.push(ctx(`${snapshot.completedVisible}/${snapshot.totalVisible} tools`));
    return blocks;
  }

  /**
   * Render main message for low mode (minimal).
   */
  renderMainMessageLow(isComplete: boolean): KnownBlock[] {
    if (isComplete) {
      return [section("✅ *Done*")];
    }
    return [section("🔧 *Processing...*")];
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd /Users/lucas/openacp-workspace/slack-adapter && npx vitest run src/__tests__/tool-card-renderer.test.ts`
Expected: All tests pass.

- [ ] **Step 5: Commit**

```bash
cd /Users/lucas/openacp-workspace/slack-adapter
git add src/tool-card-renderer.ts src/__tests__/tool-card-renderer.test.ts
git commit -m "feat: add SlackToolCardRenderer for Block Kit tool cards"
```

---

## Task 4: SlackActivityTracker — Turn management + core primitives

**Files:**
- Create: `src/activity-tracker.ts`
- Test: `src/__tests__/activity-tracker.test.ts`

- [ ] **Step 1: Write failing tests**

Create `src/__tests__/activity-tracker.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { SlackActivityTracker } from "../activity-tracker.js";

// Mock the send queue
function mockQueue() {
  return {
    enqueue: vi.fn().mockResolvedValue({ ok: true, ts: "100.001" }),
  };
}

describe("SlackActivityTracker", () => {
  let tracker: SlackActivityTracker;
  let queue: ReturnType<typeof mockQueue>;

  beforeEach(() => {
    vi.useFakeTimers();
    queue = mockQueue();
    tracker = new SlackActivityTracker({
      channelId: "C123",
      sessionId: "sess-1",
      queue: queue as any,
      outputMode: "medium",
    });
  });

  afterEach(() => {
    tracker.destroy();
    vi.useRealTimers();
  });

  describe("onNewPrompt", () => {
    it("creates a main message on new prompt", async () => {
      await tracker.onNewPrompt();

      expect(queue.enqueue).toHaveBeenCalledWith(
        "chat.postMessage",
        expect.objectContaining({
          channel: "C123",
          text: expect.any(String),
        }),
      );
    });

    it("returns the turn state with mainMessageTs", async () => {
      const turn = await tracker.onNewPrompt();
      expect(turn.mainMessageTs).toBe("100.001");
      expect(turn.threadTs).toBe("100.001");
      expect(turn.isFinalized).toBe(false);
    });
  });

  describe("onToolCall", () => {
    it("posts tool card as thread reply after debounce", async () => {
      await tracker.onNewPrompt();
      queue.enqueue.mockClear();

      await tracker.onToolCall(
        { id: "t1", name: "Edit", kind: "edit", rawInput: { file_path: "auth.ts" } },
        "edit",
        { file_path: "auth.ts" },
      );

      // First flush is immediate
      await vi.advanceTimersByTimeAsync(0);

      // Should have posted thread reply + updated main message
      const calls = queue.enqueue.mock.calls;
      const threadReply = calls.find(
        (c: any[]) => c[0] === "chat.postMessage" && c[1]?.thread_ts,
      );
      expect(threadReply).toBeDefined();
    });
  });

  describe("onToolUpdate", () => {
    it("updates existing tool card in thread", async () => {
      await tracker.onNewPrompt();
      await tracker.onToolCall(
        { id: "t1", name: "Edit", kind: "edit" },
        "edit",
        { file_path: "auth.ts" },
      );
      await vi.advanceTimersByTimeAsync(0);
      queue.enqueue.mockClear();

      await tracker.onToolUpdate("t1", "completed");
      await vi.advanceTimersByTimeAsync(600); // debounce

      expect(queue.enqueue).toHaveBeenCalled();
    });
  });

  describe("finalize", () => {
    it("updates main message to done state", async () => {
      await tracker.onNewPrompt();
      await tracker.onToolCall(
        { id: "t1", name: "Edit", kind: "edit" },
        "edit",
        { file_path: "auth.ts" },
      );
      await vi.advanceTimersByTimeAsync(0);
      queue.enqueue.mockClear();

      await tracker.finalize();

      const updateCall = queue.enqueue.mock.calls.find(
        (c: any[]) => c[0] === "chat.update",
      );
      expect(updateCall).toBeDefined();
    });
  });

  describe("low mode", () => {
    it("does not post thread replies in low mode", async () => {
      tracker.destroy();
      tracker = new SlackActivityTracker({
        channelId: "C123",
        sessionId: "sess-1",
        queue: queue as any,
        outputMode: "low",
      });

      await tracker.onNewPrompt();
      queue.enqueue.mockClear();

      await tracker.onToolCall(
        { id: "t1", name: "Edit", kind: "edit" },
        "edit",
        { file_path: "auth.ts" },
      );
      await vi.advanceTimersByTimeAsync(600);

      // Should update main message but no thread reply
      const threadReplies = queue.enqueue.mock.calls.filter(
        (c: any[]) => c[0] === "chat.postMessage" && c[1]?.thread_ts,
      );
      expect(threadReplies.length).toBe(0);
    });
  });

  describe("onThought", () => {
    it("posts thinking indicator as thread reply in high mode", async () => {
      tracker.destroy();
      tracker = new SlackActivityTracker({
        channelId: "C123",
        sessionId: "sess-1",
        queue: queue as any,
        outputMode: "high",
      });

      await tracker.onNewPrompt();
      queue.enqueue.mockClear();

      await tracker.onThought("Analyzing the code...");

      const threadReply = queue.enqueue.mock.calls.find(
        (c: any[]) => c[0] === "chat.postMessage" && c[1]?.thread_ts,
      );
      expect(threadReply).toBeDefined();
    });

    it("does not post thinking in medium mode", async () => {
      await tracker.onNewPrompt();
      queue.enqueue.mockClear();

      await tracker.onThought("Analyzing...");

      const threadReplies = queue.enqueue.mock.calls.filter(
        (c: any[]) => c[0] === "chat.postMessage" && c[1]?.thread_ts,
      );
      expect(threadReplies.length).toBe(0);
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/lucas/openacp-workspace/slack-adapter && npx vitest run src/__tests__/activity-tracker.test.ts`
Expected: FAIL — `../activity-tracker.js` does not exist.

- [ ] **Step 3: Implement SlackActivityTracker**

Create `src/activity-tracker.ts`:

```typescript
import type { KnownBlock } from "@slack/bolt";
import {
  ToolStateMap,
  ThoughtBuffer,
  DisplaySpecBuilder,
  ToolCardState,
  OutputModeResolver,
} from "@openacp/plugin-sdk";
import type {
  ToolDisplaySpec,
  ToolCardSnapshot,
  OutputMode,
  ToolCallMeta,
  ViewerLinks,
  TunnelServiceInterface,
} from "@openacp/plugin-sdk";
import type { ISlackSendQueue } from "./send-queue.js";
import type { TurnState } from "./types.js";
import { SlackToolCardRenderer } from "./tool-card-renderer.js";

export interface SlackActivityTrackerConfig {
  channelId: string;
  sessionId: string;
  queue: ISlackSendQueue;
  outputMode: OutputMode;
  tunnelService?: TunnelServiceInterface;
  sessionContext?: { id: string; workingDirectory: string };
}

export class SlackActivityTracker {
  private channelId: string;
  private sessionId: string;
  private queue: ISlackSendQueue;
  private outputMode: OutputMode;
  private renderer = new SlackToolCardRenderer();

  private toolStateMap: ToolStateMap;
  private specBuilder: DisplaySpecBuilder;
  private toolCardState: ToolCardState | null = null;
  private thoughtBuffer: ThoughtBuffer;
  private sessionContext?: { id: string; workingDirectory: string };

  private turn: TurnState | null = null;
  private thoughtMessageTs?: string;
  private lastSnapshot: ToolCardSnapshot = { specs: [], totalVisible: 0, completedVisible: 0, allComplete: false };

  constructor(config: SlackActivityTrackerConfig) {
    this.channelId = config.channelId;
    this.sessionId = config.sessionId;
    this.queue = config.queue;
    this.outputMode = config.outputMode;
    this.sessionContext = config.sessionContext;

    this.toolStateMap = new ToolStateMap();
    this.specBuilder = new DisplaySpecBuilder(config.tunnelService);
    this.thoughtBuffer = new ThoughtBuffer();
  }

  setOutputMode(mode: OutputMode): void {
    this.outputMode = mode;
  }

  /**
   * Start a new prompt turn. Posts the initial "Processing..." main message.
   */
  async onNewPrompt(): Promise<TurnState> {
    // Finalize previous turn if exists
    if (this.turn && !this.turn.isFinalized) {
      await this.finalize();
    }

    // Reset state
    this.toolStateMap.clear();
    this.thoughtBuffer.reset();
    this.thoughtMessageTs = undefined;
    if (this.toolCardState) {
      this.toolCardState.destroy();
      this.toolCardState = null;
    }

    // Post initial main message
    const blocks =
      this.outputMode === "low"
        ? this.renderer.renderMainMessageLow(false)
        : this.renderer.renderMainMessage(
            { specs: [], totalVisible: 0, completedVisible: 0, allComplete: false },
            false,
          );

    const result = await this.queue.enqueue<{ ts?: string }>("chat.postMessage", {
      channel: this.channelId,
      blocks,
      text: "🔧 Processing...",
    });

    const ts = result?.ts ?? "";
    this.turn = {
      mainMessageTs: ts,
      threadTs: ts,
      isFinalized: false,
    };

    return this.turn;
  }

  /**
   * Handle a thought event. In high mode, posts to thread. Otherwise buffered silently.
   */
  async onThought(text: string): Promise<void> {
    if (!this.turn) return;
    this.thoughtBuffer.append(text);

    if (this.outputMode === "high") {
      // Post or update thinking message in thread
      const content = this.thoughtBuffer.getText();
      const blocks: KnownBlock[] = [
        {
          type: "context",
          elements: [{ type: "mrkdwn", text: `💭 _${content.slice(0, 2900)}_` }],
        } as KnownBlock,
      ];

      if (this.thoughtMessageTs) {
        await this.queue.enqueue("chat.update", {
          channel: this.channelId,
          ts: this.thoughtMessageTs,
          blocks,
          text: "💭 Thinking...",
        });
      } else {
        const result = await this.queue.enqueue<{ ts?: string }>("chat.postMessage", {
          channel: this.channelId,
          thread_ts: this.turn.threadTs,
          blocks,
          text: "💭 Thinking...",
        });
        this.thoughtMessageTs = result?.ts;
      }
    }
  }

  /**
   * Handle a tool_call event. Creates tool entry, builds spec, updates card.
   */
  async onToolCall(
    meta: Partial<ToolCallMeta> & { id: string; name: string },
    kind: string,
    rawInput: unknown,
  ): Promise<void> {
    if (!this.turn) return;

    // Seal thought buffer on first tool
    if (!this.thoughtBuffer.isSealed()) {
      this.thoughtBuffer.seal();
    }

    const entry = this.toolStateMap.upsert(
      meta as ToolCallMeta,
      kind,
      rawInput,
    );
    const spec = this.specBuilder.buildToolSpec(entry, this.outputMode, this.sessionContext);

    if (spec.isHidden) return;

    this.ensureToolCardState();
    this.toolCardState!.updateFromSpec(spec);

    // Update main message with progress
    await this.updateMainMessage(false);
  }

  /**
   * Handle a tool_update event. Merges update, re-renders card.
   */
  async onToolUpdate(
    id: string,
    status: string,
    viewerLinks?: ViewerLinks,
    viewerFilePath?: string,
    content?: string | null,
    rawInput?: unknown,
    diffStats?: { added: number; removed: number },
  ): Promise<void> {
    if (!this.turn) return;

    const entry = this.toolStateMap.merge(
      id,
      status,
      rawInput,
      content,
      viewerLinks,
      diffStats,
    );
    if (!entry) return; // out-of-order, buffered

    const spec = this.specBuilder.buildToolSpec(entry, this.outputMode, this.sessionContext);

    if (spec.isHidden) return;

    this.ensureToolCardState();
    this.toolCardState!.updateFromSpec(spec);

    // Update main message with progress
    await this.updateMainMessage(false);
  }

  /**
   * Handle plan entries update.
   */
  async onPlan(entries: Array<{ content: string; status: string }>): Promise<void> {
    if (!this.turn) return;
    this.ensureToolCardState();
    this.toolCardState!.updatePlan(entries);
  }

  /**
   * Handle usage stats.
   */
  async onUsage(usage: { tokensUsed?: number; contextSize?: number; cost?: number }): Promise<void> {
    if (!this.turn) return;
    this.ensureToolCardState();
    this.toolCardState!.appendUsage(usage);
  }

  /**
   * Finalize the current turn. Updates main message to "Done" state.
   */
  async finalize(): Promise<void> {
    if (!this.turn || this.turn.isFinalized) return;

    // Finalize tool card (flush remaining)
    if (this.toolCardState) {
      this.toolCardState.finalize();
    }

    // Update main message to done
    await this.updateMainMessage(true);

    this.turn.isFinalized = true;
  }

  destroy(): void {
    if (this.toolCardState) {
      this.toolCardState.destroy();
      this.toolCardState = null;
    }
  }

  /** Get current turn state (for text buffer to know thread context) */
  getTurn(): TurnState | null {
    return this.turn;
  }

  // --- Private ---

  private ensureToolCardState(): void {
    if (this.toolCardState) return;

    this.toolCardState = new ToolCardState({
      onFlush: (snapshot) => {
        this.lastSnapshot = snapshot; // track for main message updates
        void this.flushToolCard(snapshot);
      },
    });
  }

  private async flushToolCard(snapshot: ToolCardSnapshot): Promise<void> {
    if (!this.turn) return;

    // Low mode: no thread replies
    if (this.outputMode === "low") return;

    const blocks = this.renderer.renderToolCard(snapshot);
    if (blocks.length === 0) return;

    if (this.turn.currentToolCardTs) {
      // Edit existing tool card message
      await this.queue.enqueue("chat.update", {
        channel: this.channelId,
        ts: this.turn.currentToolCardTs,
        blocks,
        text: "🔧 Tools",
      });
    } else {
      // Post new tool card as thread reply
      const result = await this.queue.enqueue<{ ts?: string }>("chat.postMessage", {
        channel: this.channelId,
        thread_ts: this.turn.threadTs,
        blocks,
        text: "🔧 Tools",
      });
      this.turn.currentToolCardTs = result?.ts;
    }
  }

  private async updateMainMessage(isComplete: boolean): Promise<void> {
    if (!this.turn) return;

    const snapshot = { ...this.lastSnapshot, allComplete: isComplete };

    const blocks =
      this.outputMode === "low"
        ? this.renderer.renderMainMessageLow(isComplete)
        : this.renderer.renderMainMessage(snapshot, isComplete);

    await this.queue.enqueue("chat.update", {
      channel: this.channelId,
      ts: this.turn.mainMessageTs,
      blocks,
      text: isComplete ? "✅ Done" : "🔧 Processing...",
    });
  }
}
```

**Note:** The imports from `@openacp/plugin-sdk` for `ToolStateMap`, `ThoughtBuffer`, `DisplaySpecBuilder`, `OutputModeResolver` depend on the prerequisite being completed. If these are not yet exported, the implementation will need to temporarily use local implementations or wait for the SDK update.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd /Users/lucas/openacp-workspace/slack-adapter && npx vitest run src/__tests__/activity-tracker.test.ts`
Expected: All tests pass.

- [ ] **Step 5: Commit**

```bash
cd /Users/lucas/openacp-workspace/slack-adapter
git add src/activity-tracker.ts src/__tests__/activity-tracker.test.ts
git commit -m "feat: add SlackActivityTracker with thread-based tool rendering"
```

---

## Task 5: SlackModalHandler — `/outputmode` modal

**Files:**
- Create: `src/modal-handler.ts`
- Test: `src/__tests__/modal-handler.test.ts`

- [ ] **Step 1: Write failing tests**

Create `src/__tests__/modal-handler.test.ts`:

```typescript
import { describe, it, expect, vi } from "vitest";
import { SlackModalHandler } from "../modal-handler.js";

describe("SlackModalHandler", () => {
  describe("buildOutputModeModal", () => {
    it("returns a valid Slack modal view", () => {
      const handler = new SlackModalHandler();
      const view = handler.buildOutputModeModal("medium", "sess-1");

      expect(view.type).toBe("modal");
      expect(view.title.text).toContain("Output Mode");
      expect(view.submit).toBeDefined();
      expect(view.blocks.length).toBeGreaterThan(0);

      // Should have radio buttons block
      const radioBlock = view.blocks.find(
        (b: any) => b.element?.type === "radio_buttons",
      );
      expect(radioBlock).toBeDefined();

      // Should have scope selector
      const selectBlock = view.blocks.find(
        (b: any) => b.element?.type === "static_select",
      );
      expect(selectBlock).toBeDefined();
    });

    it("pre-selects the current mode", () => {
      const handler = new SlackModalHandler();
      const view = handler.buildOutputModeModal("high", "sess-1");

      const radioBlock = view.blocks.find(
        (b: any) => b.element?.type === "radio_buttons",
      ) as any;

      expect(radioBlock.element.initial_option.value).toBe("high");
    });
  });

  describe("parseSubmission", () => {
    it("extracts mode and scope from view state", () => {
      const handler = new SlackModalHandler();
      const viewState = {
        values: {
          output_mode_block: {
            output_mode_action: {
              type: "radio_buttons",
              selected_option: { value: "low" },
            },
          },
          output_scope_block: {
            output_scope_action: {
              type: "static_select",
              selected_option: { value: "session" },
            },
          },
        },
      };

      const result = handler.parseSubmission(viewState as any, "sess-1");
      expect(result).toEqual({ mode: "low", scope: "session", sessionId: "sess-1" });
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/lucas/openacp-workspace/slack-adapter && npx vitest run src/__tests__/modal-handler.test.ts`
Expected: FAIL — `../modal-handler.js` does not exist.

- [ ] **Step 3: Implement SlackModalHandler**

Create `src/modal-handler.ts`:

```typescript
import type { OutputMode } from "@openacp/plugin-sdk";

interface ModalView {
  type: "modal";
  callback_id: string;
  title: { type: "plain_text"; text: string };
  submit: { type: "plain_text"; text: string };
  close: { type: "plain_text"; text: string };
  private_metadata: string;
  blocks: any[];
}

interface SubmissionResult {
  mode: OutputMode;
  scope: "session" | "adapter";
  sessionId?: string;
}

const MODE_OPTIONS = [
  {
    value: "low",
    label: "🔇 Low",
    description: "Summary only, no tool details",
  },
  {
    value: "medium",
    label: "📊 Medium",
    description: "Tool summaries + viewer links",
  },
  {
    value: "high",
    label: "🔍 High",
    description: "Full details, thinking, output",
  },
] as const;

export class SlackModalHandler {
  /**
   * Build the output mode modal view.
   */
  buildOutputModeModal(currentMode: OutputMode, sessionId?: string): ModalView {
    const options = MODE_OPTIONS.map((opt) => ({
      text: { type: "plain_text" as const, text: opt.label },
      description: { type: "plain_text" as const, text: opt.description },
      value: opt.value,
    }));

    const initialOption = options.find((o) => o.value === currentMode) ?? options[1];

    const scopeOptions = [
      {
        text: { type: "plain_text" as const, text: "This session" },
        value: "session",
      },
      {
        text: { type: "plain_text" as const, text: "All sessions (adapter default)" },
        value: "adapter",
      },
    ];

    return {
      type: "modal",
      callback_id: "output_mode_modal",
      title: { type: "plain_text", text: "⚙️ Output Mode" },
      submit: { type: "plain_text", text: "Save" },
      close: { type: "plain_text", text: "Cancel" },
      private_metadata: JSON.stringify({ sessionId }),
      blocks: [
        {
          type: "input",
          block_id: "output_mode_block",
          label: { type: "plain_text", text: "Output Mode" },
          element: {
            type: "radio_buttons",
            action_id: "output_mode_action",
            options,
            initial_option: initialOption,
          },
        },
        {
          type: "input",
          block_id: "output_scope_block",
          label: { type: "plain_text", text: "Apply to" },
          element: {
            type: "static_select",
            action_id: "output_scope_action",
            options: scopeOptions,
            initial_option: sessionId ? scopeOptions[0] : scopeOptions[1],
          },
        },
      ],
    };
  }

  /**
   * Parse the modal submission view state.
   */
  parseSubmission(
    viewState: { values: Record<string, Record<string, any>> },
    sessionId?: string,
  ): SubmissionResult {
    const modeValue =
      viewState.values?.output_mode_block?.output_mode_action?.selected_option?.value;
    const scopeValue =
      viewState.values?.output_scope_block?.output_scope_action?.selected_option?.value;

    const mode: OutputMode = ["low", "medium", "high"].includes(modeValue)
      ? (modeValue as OutputMode)
      : "medium";
    const scope = scopeValue === "adapter" ? "adapter" : "session";

    return { mode, scope, sessionId };
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd /Users/lucas/openacp-workspace/slack-adapter && npx vitest run src/__tests__/modal-handler.test.ts`
Expected: All tests pass.

- [ ] **Step 5: Commit**

```bash
cd /Users/lucas/openacp-workspace/slack-adapter
git add src/modal-handler.ts src/__tests__/modal-handler.test.ts
git commit -m "feat: add SlackModalHandler for /outputmode modal"
```

---

## Task 6: Rewrite formatter.ts — Remove tool rendering

**Files:**
- Modify: `src/formatter.ts`
- Modify: `src/__tests__/formatter.test.ts`

- [ ] **Step 1: Update tests to reflect new formatter scope**

In `src/__tests__/formatter.test.ts`, remove or update tests for `tool_call`, `tool_update`, `thought`, `plan`, `usage` cases in `formatOutgoing()`. Keep tests for `text`, `session_end`, `error` cases. Keep all `formatPermissionRequest()` and `markdownToMrkdwn()` tests.

Add a test verifying tool types return empty:

```typescript
it("returns empty blocks for tool_call (handled by ActivityTracker)", () => {
  const blocks = formatter.formatOutgoing({
    type: "tool_call",
    text: "",
    metadata: { name: "Edit", id: "t1" },
  });
  expect(blocks).toEqual([]);
});

it("returns empty blocks for thought (handled by ActivityTracker)", () => {
  const blocks = formatter.formatOutgoing({ type: "thought", text: "thinking..." });
  expect(blocks).toEqual([]);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /Users/lucas/openacp-workspace/slack-adapter && npx vitest run src/__tests__/formatter.test.ts`
Expected: FAIL — tool_call still returns blocks.

- [ ] **Step 3: Update formatter.ts**

In `src/formatter.ts`, modify `formatOutgoing()` to return empty blocks for types now handled by ActivityTracker:

```typescript
formatOutgoing(message: OutgoingMessage): KnownBlock[] {
  switch (message.type) {
    case "text":
      return this.formatText(message);
    case "error":
      return [section(`⚠️ ${markdownToMrkdwn(message.text)}`)];
    case "session_end":
      return this.formatSessionEnd(message.metadata?.stopReason);
    case "system_message":
      return [section(markdownToMrkdwn(message.text))];
    case "current_mode_update":
      return [ctx(`🔄 Mode: *${(message.metadata as any)?.modeId ?? "unknown"}*`)];
    case "config_option_update":
      return [ctx("⚙️ Configuration updated")];
    case "model_update":
      return [ctx(`🤖 Model: *${(message.metadata as any)?.modelId ?? "unknown"}*`)];
    // These are now handled by SlackActivityTracker:
    case "thought":
    case "tool_call":
    case "tool_update":
    case "plan":
    case "usage":
      return [];
    default:
      return message.text ? [section(markdownToMrkdwn(message.text))] : [];
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd /Users/lucas/openacp-workspace/slack-adapter && npx vitest run src/__tests__/formatter.test.ts`
Expected: All tests pass.

- [ ] **Step 5: Commit**

```bash
cd /Users/lucas/openacp-workspace/slack-adapter
git add src/formatter.ts src/__tests__/formatter.test.ts
git commit -m "refactor: remove tool rendering from formatter (delegated to ActivityTracker)"
```

---

## Task 7: Update renderer.ts — Delegate to ActivityTracker

**Files:**
- Modify: `src/renderer.ts`

- [ ] **Step 1: Update renderer methods**

In `src/renderer.ts`, simplify methods that are now handled by ActivityTracker. These methods should return empty/no-op rendered messages since the adapter will route these event types to ActivityTracker instead:

```typescript
// These methods are kept for interface compliance but return empty.
// The adapter routes tool_call/tool_update/thought/plan/usage
// directly to SlackActivityTracker, bypassing the renderer.

renderThought(_content: OutgoingMessage, _verbosity: DisplayVerbosity): RenderedMessage {
  return { body: "", format: "structured", components: [] };
}

renderToolCall(_content: OutgoingMessage, _verbosity: DisplayVerbosity): RenderedMessage {
  return { body: "", format: "structured", components: [] };
}

renderToolUpdate(_content: OutgoingMessage, _verbosity: DisplayVerbosity): RenderedMessage {
  return { body: "", format: "structured", components: [] };
}

renderPlan(_content: OutgoingMessage): RenderedMessage {
  return { body: "", format: "structured", components: [] };
}

renderUsage(_content: OutgoingMessage, _verbosity: DisplayVerbosity): RenderedMessage {
  return { body: "", format: "structured", components: [] };
}
```

- [ ] **Step 2: Verify build passes**

Run: `cd /Users/lucas/openacp-workspace/slack-adapter && npx tsc --noEmit`
Expected: No type errors.

- [ ] **Step 3: Commit**

```bash
cd /Users/lucas/openacp-workspace/slack-adapter
git add src/renderer.ts
git commit -m "refactor: simplify renderer, delegate tool/thought/plan/usage to ActivityTracker"
```

---

## Task 8: Wire everything in adapter.ts

**Files:**
- Modify: `src/adapter.ts`
- Test: `src/__tests__/adapter-integration.test.ts`

- [ ] **Step 1: Write integration test for thread-based flow**

Create `src/__tests__/adapter-integration.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { SlackActivityTracker } from "../activity-tracker.js";

/**
 * Integration test: verify the full flow from adapter handler calls
 * through ActivityTracker to send queue.
 */
describe("Adapter → ActivityTracker integration", () => {
  let tracker: SlackActivityTracker;
  let queue: { enqueue: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    vi.useFakeTimers();
    queue = {
      enqueue: vi.fn().mockResolvedValue({ ok: true, ts: "100.001" }),
    };
    tracker = new SlackActivityTracker({
      channelId: "C123",
      sessionId: "sess-1",
      queue: queue as any,
      outputMode: "medium",
    });
  });

  afterEach(() => {
    tracker.destroy();
    vi.useRealTimers();
  });

  it("full turn: prompt → tool_call → tool_update → finalize", async () => {
    // 1. New prompt
    const turn = await tracker.onNewPrompt();
    expect(turn.mainMessageTs).toBe("100.001");

    // 2. Tool call
    await tracker.onToolCall(
      { id: "t1", name: "Edit", kind: "edit" },
      "edit",
      { file_path: "auth.ts" },
    );
    await vi.advanceTimersByTimeAsync(0);

    // Should have: 1 main message post + 1 thread reply + 1 main message update
    const postCalls = queue.enqueue.mock.calls.filter(
      (c: any[]) => c[0] === "chat.postMessage",
    );
    expect(postCalls.length).toBeGreaterThanOrEqual(2); // main + thread

    // 3. Tool update
    queue.enqueue.mockClear();
    await tracker.onToolUpdate("t1", "completed");
    await vi.advanceTimersByTimeAsync(600);

    // 4. Finalize
    queue.enqueue.mockClear();
    await tracker.finalize();

    const updateCalls = queue.enqueue.mock.calls.filter(
      (c: any[]) => c[0] === "chat.update",
    );
    expect(updateCalls.length).toBeGreaterThanOrEqual(1); // main message → done
  });
});
```

- [ ] **Step 2: Run test to verify it passes (testing ActivityTracker directly)**

Run: `cd /Users/lucas/openacp-workspace/slack-adapter && npx vitest run src/__tests__/adapter-integration.test.ts`
Expected: PASS (this tests ActivityTracker which is already implemented).

- [ ] **Step 3: Update adapter.ts — Add OutputModeResolver and ActivityTracker**

Key changes to `src/adapter.ts`:

```typescript
// Add imports
import { OutputModeResolver } from "@openacp/plugin-sdk";
import type { OutputMode, ToolCallMeta, ToolUpdateMeta, ViewerLinks } from "@openacp/plugin-sdk";
import { SlackActivityTracker } from "./activity-tracker.js";
import { SlackModalHandler } from "./modal-handler.js";

// Add to class properties:
private outputModeResolver = new OutputModeResolver();
private sessionTrackers = new Map<string, SlackActivityTracker>();
private modalHandler = new SlackModalHandler();

// Add helper method:
private getOrCreateTracker(sessionId: string, channelId: string): SlackActivityTracker {
  let tracker = this.sessionTrackers.get(sessionId);
  if (!tracker) {
    const mode = this.outputModeResolver.resolve(
      this.core.configManager,
      "slack",
      sessionId,
      this.core.sessionManager as any,
    );
    tracker = new SlackActivityTracker({
      channelId,
      sessionId,
      queue: this.queue,
      outputMode: mode,
    });
    this.sessionTrackers.set(sessionId, tracker);
  } else {
    const mode = this.outputModeResolver.resolve(
      this.core.configManager,
      "slack",
      sessionId,
      this.core.sessionManager as any,
    );
    tracker.setOutputMode(mode);
  }
  return tracker;
}

// Override handler methods:
protected async handleThought(sessionId: string, content: OutgoingMessage): Promise<void> {
  const meta = this.sessions.get(sessionId);
  if (!meta) return;
  const tracker = this.getOrCreateTracker(sessionId, meta.channelId);
  await tracker.onThought(content.text);
}

protected async handleToolCall(sessionId: string, content: OutgoingMessage): Promise<void> {
  const meta = this.sessions.get(sessionId);
  if (!meta) return;
  const tracker = this.getOrCreateTracker(sessionId, meta.channelId);
  const m = (content.metadata ?? {}) as Partial<ToolCallMeta>;

  // Flush text buffer before tool card
  const buf = this.textBuffers.get(sessionId);
  if (buf) await buf.flush();

  // Ensure we have a turn
  if (!tracker.getTurn()) {
    await tracker.onNewPrompt();
  }

  await tracker.onToolCall(
    { id: m.id ?? "", name: m.name ?? "unknown", kind: m.kind, status: m.status, rawInput: m.rawInput, viewerLinks: m.viewerLinks },
    String(m.kind ?? ""),
    m.rawInput,
  );
}

protected async handleToolUpdate(sessionId: string, content: OutgoingMessage): Promise<void> {
  const meta = this.sessions.get(sessionId);
  if (!meta) return;
  const tracker = this.getOrCreateTracker(sessionId, meta.channelId);
  const m = (content.metadata ?? {}) as Partial<ToolUpdateMeta>;

  await tracker.onToolUpdate(
    m.id ?? "",
    m.status ?? "completed",
    m.viewerLinks as ViewerLinks | undefined,
    m.viewerFilePath as string | undefined,
    typeof m.content === "string" ? m.content : null,
    m.rawInput ?? undefined,
    (m as any).diffStats as { added: number; removed: number } | undefined,
  );
}

protected async handlePlan(sessionId: string, content: OutgoingMessage): Promise<void> {
  const meta = this.sessions.get(sessionId);
  if (!meta) return;
  const tracker = this.getOrCreateTracker(sessionId, meta.channelId);
  const entries = (content.metadata as any)?.planEntries ?? [];
  await tracker.onPlan(entries);
}

protected async handleUsage(sessionId: string, content: OutgoingMessage): Promise<void> {
  const meta = this.sessions.get(sessionId);
  if (!meta) return;
  const tracker = this.getOrCreateTracker(sessionId, meta.channelId);
  const m = content.metadata as any;
  await tracker.onUsage({
    tokensUsed: m?.tokensUsed ?? m?.tokens,
    contextSize: m?.contextSize,
    cost: m?.cost,
  });
}

// On text start, create turn if not exists:
protected async handleText(sessionId: string, content: OutgoingMessage): Promise<void> {
  const meta = this.sessions.get(sessionId);
  if (!meta) return;
  const tracker = this.getOrCreateTracker(sessionId, meta.channelId);

  // Finalize activity tracker (mark turn as done)
  await tracker.finalize();

  // Post text in channel (not thread) via existing text buffer
  // ... keep existing text buffer logic
  const buf = this.getOrCreateTextBuffer(sessionId, meta.channelId);
  buf.append(content.text);
}

// On session end, cleanup tracker:
protected async handleSessionEnd(sessionId: string, content: OutgoingMessage): Promise<void> {
  const tracker = this.sessionTrackers.get(sessionId);
  if (tracker) {
    await tracker.finalize();
    tracker.destroy();
    this.sessionTrackers.delete(sessionId);
  }
  // ... keep existing session end logic
  await super.handleSessionEnd(sessionId, content);
}
```

- [ ] **Step 4: Verify build passes**

Run: `cd /Users/lucas/openacp-workspace/slack-adapter && npx tsc --noEmit`
Expected: No type errors.

- [ ] **Step 5: Run all tests**

Run: `cd /Users/lucas/openacp-workspace/slack-adapter && npx vitest run`
Expected: All tests pass.

- [ ] **Step 6: Commit**

```bash
cd /Users/lucas/openacp-workspace/slack-adapter
git add src/adapter.ts src/__tests__/adapter-integration.test.ts
git commit -m "feat: wire ActivityTracker + OutputModeResolver into SlackAdapter"
```

---

## Task 9: Register modal + `/outputmode` slash command

**Files:**
- Modify: `src/adapter.ts`
- Modify: `src/index.ts`

- [ ] **Step 1: Add modal registration and slash command handler in adapter.ts**

Add to `SlackAdapter.start()`, after `this.permissionHandler.register(this.app)`:

```typescript
// Register /outputmode slash command
this.app.command("/outputmode", async ({ command, ack, client }) => {
  await ack();

  const args = command.text.trim().toLowerCase();

  // Inline shortcut: /outputmode low|medium|high
  if (args === "low" || args === "medium" || args === "high") {
    // Find session by channel
    const channelId = command.channel_id;
    const sessionMeta = this.findSessionByChannel(channelId);
    if (sessionMeta) {
      await this.core.sessionManager.patchRecord(sessionMeta.sessionId, { outputMode: args });
    }
    await client.chat.postEphemeral({
      channel: channelId,
      user: command.user_id,
      text: `Output mode set to *${args}*`,
    });
    return;
  }

  // Open modal
  const sessionMeta = this.findSessionByChannel(command.channel_id);
  const currentMode = this.outputModeResolver.resolve(
    this.core.configManager,
    "slack",
    sessionMeta?.sessionId,
    this.core.sessionManager as any,
  );

  const view = this.modalHandler.buildOutputModeModal(currentMode, sessionMeta?.sessionId);
  await client.views.open({
    trigger_id: command.trigger_id,
    view: view as any,
  });
});

// Handle modal submission
this.app.view("output_mode_modal", async ({ ack, view }) => {
  await ack();
  const metadata = JSON.parse(view.private_metadata || "{}");
  const result = this.modalHandler.parseSubmission(view.state, metadata.sessionId);

  if (result.scope === "session" && result.sessionId) {
    await this.core.sessionManager.patchRecord(result.sessionId, { outputMode: result.mode });
  } else {
    await this.core.configManager.save(
      { channels: { slack: { outputMode: result.mode } } },
      "channels.slack.outputMode",
    );
  }
});
```

Add helper method to adapter:

```typescript
private findSessionByChannel(channelId: string): { sessionId: string } | undefined {
  for (const [sessionId, meta] of this.sessions) {
    if (meta.channelId === channelId) {
      return { sessionId };
    }
  }
  return undefined;
}
```

- [ ] **Step 2: Verify build passes**

Run: `cd /Users/lucas/openacp-workspace/slack-adapter && npx tsc --noEmit`
Expected: No type errors.

- [ ] **Step 3: Commit**

```bash
cd /Users/lucas/openacp-workspace/slack-adapter
git add src/adapter.ts src/index.ts
git commit -m "feat: register /outputmode slash command and modal handler"
```

---

## Task 10: Update permission-handler.ts — Block Kit resolved format

**Files:**
- Modify: `src/permission-handler.ts`
- Modify: `src/__tests__/permission-handler.test.ts`

- [ ] **Step 1: Write test for resolved permission format**

Add to `src/__tests__/permission-handler.test.ts`:

```typescript
it("updates message with resolved context on button click", async () => {
  const queue = {
    enqueue: vi.fn().mockResolvedValue({ ok: true }),
  };
  const onResponse = vi.fn();
  const handler = new SlackPermissionHandler(queue as any, onResponse);

  handler.trackPendingMessage("req-1", "C123", "msg-ts-1");

  // Simulate button click
  const mockApp = {
    action: vi.fn(),
  };
  handler.register(mockApp as any);

  // Get the action handler
  const actionHandler = mockApp.action.mock.calls[0][1];
  const ackFn = vi.fn();
  const body = {
    actions: [{ value: "req-1:allow", action_id: "perm_action_allow" }],
    user: { id: "U123", name: "lucas" },
    channel: { id: "C123" },
    message: { ts: "msg-ts-1" },
  };

  await actionHandler({ ack: ackFn, body, action: body.actions[0] });

  expect(ackFn).toHaveBeenCalled();
  expect(onResponse).toHaveBeenCalledWith("req-1", "allow");

  // Should update the message
  const updateCall = queue.enqueue.mock.calls.find(
    (c: any[]) => c[0] === "chat.update",
  );
  expect(updateCall).toBeDefined();
});
```

- [ ] **Step 2: Run test to verify current behavior**

Run: `cd /Users/lucas/openacp-workspace/slack-adapter && npx vitest run src/__tests__/permission-handler.test.ts`

- [ ] **Step 3: Update permission handler to show resolved state**

In `src/permission-handler.ts`, after calling `onResponse`, update the message to show the resolved state:

```typescript
// In the action handler, after onResponse:
const isAllow = optionId.includes("allow") || optionId.includes("yes");
const icon = isAllow ? "✅" : "❌";
const label = isAllow ? "Allowed" : "Denied";
const userName = body.user?.name ?? body.user?.id ?? "unknown";

// Update message: remove buttons, show result
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd /Users/lucas/openacp-workspace/slack-adapter && npx vitest run src/__tests__/permission-handler.test.ts`
Expected: All tests pass.

- [ ] **Step 5: Commit**

```bash
cd /Users/lucas/openacp-workspace/slack-adapter
git add src/permission-handler.ts src/__tests__/permission-handler.test.ts
git commit -m "feat: show resolved permission state with Block Kit context"
```

---

## Task 11: Run full test suite and fix issues

**Files:**
- All modified files

- [ ] **Step 1: Run full test suite**

Run: `cd /Users/lucas/openacp-workspace/slack-adapter && npx vitest run`

- [ ] **Step 2: Fix any failing tests**

Address any failures from the integration of all components.

- [ ] **Step 3: Run TypeScript build**

Run: `cd /Users/lucas/openacp-workspace/slack-adapter && npx tsc --noEmit`

- [ ] **Step 4: Fix any type errors**

Address any type errors.

- [ ] **Step 5: Commit fixes if any**

```bash
cd /Users/lucas/openacp-workspace/slack-adapter
git add -A
git commit -m "fix: resolve test and type issues from output mode integration"
```

---

## Task 12: Final verification and cleanup

- [ ] **Step 1: Run full test suite one final time**

Run: `cd /Users/lucas/openacp-workspace/slack-adapter && npx vitest run`
Expected: All tests pass.

- [ ] **Step 2: Run build**

Run: `cd /Users/lucas/openacp-workspace/slack-adapter && npm run build`
Expected: Build succeeds.

- [ ] **Step 3: Verify no unused imports or dead code**

Quick scan of all modified files for unused imports.

- [ ] **Step 4: Final commit if needed**

```bash
cd /Users/lucas/openacp-workspace/slack-adapter
git add -A
git commit -m "chore: cleanup after output mode implementation"
```
