import { describe, expect, it } from "vitest";
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
    outputFallbackContent: undefined,
    diffStats: { added: 5, removed: 2 },
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

const renderer = new SlackToolCardRenderer();

describe("SlackToolCardRenderer", () => {
  describe("renderToolCard", () => {
    it("renders a completed tool with icon, title, description, diff stats", () => {
      const blocks = renderer.renderToolCard(makeSnapshot());
      const texts = blocks.map((b) => {
        if (b.type === "section") return (b as any).text.text;
        if (b.type === "context") return (b as any).elements[0].text;
        return "";
      });
      const joined = texts.join("\n");
      // Status icon for completed
      expect(joined).toContain("✅");
      // Tool icon
      expect(joined).toContain("✏️");
      // Title
      expect(joined).toContain("src/auth.ts");
      // Description
      expect(joined).toContain("Fixed validation logic");
      // Diff stats
      expect(joined).toContain("+5/-2");
    });

    it("hides hidden specs (isHidden: true)", () => {
      const snap = makeSnapshot({
        specs: [
          makeSpec({ id: "tool-1", isHidden: false, title: "visible-tool" }),
          makeSpec({ id: "tool-2", isHidden: true, title: "hidden-tool" }),
        ],
        totalVisible: 1,
        completedVisible: 1,
      });
      const blocks = renderer.renderToolCard(snap);
      const allText = JSON.stringify(blocks);
      expect(allText).toContain("visible-tool");
      expect(allText).not.toContain("hidden-tool");
    });

    it("renders inline output content", () => {
      const snap = makeSnapshot({
        specs: [makeSpec({ outputContent: 'if (!token) throw new Error("bad")' })],
      });
      const blocks = renderer.renderToolCard(snap);
      const allText = JSON.stringify(blocks);
      expect(allText).toContain("if (!token)");
      // Should be in a code block (section with ```)
      const sectionBlocks = blocks.filter((b) => b.type === "section");
      const hasCodeBlock = sectionBlocks.some((b) =>
        (b as any).text.text.includes("```"),
      );
      expect(hasCodeBlock).toBe(true);
    });

    it("renders fallback content when outputContent is null", () => {
      const blocks = renderer.renderToolCard(
        makeSnapshot({
          specs: [makeSpec({ outputContent: null, outputFallbackContent: "fallback output here" })],
        }),
      );
      const text = JSON.stringify(blocks);
      expect(text).toContain("fallback output here");
    });

    it("renders viewer links as mrkdwn links", () => {
      const snap = makeSnapshot({
        specs: [
          makeSpec({
            viewerLinks: {
              file: "https://example.com/file",
              diff: "https://example.com/diff",
            },
            outputViewerLink: "https://example.com/output",
          }),
        ],
      });
      const blocks = renderer.renderToolCard(snap);
      const allText = JSON.stringify(blocks);
      expect(allText).toContain("<https://example.com/file|View File>");
      expect(allText).toContain("<https://example.com/diff|View Diff>");
      expect(allText).toContain("<https://example.com/output|View Output>");
    });

    it("renders multiple aggregated tools with completed first", () => {
      const snap = makeSnapshot({
        specs: [
          makeSpec({ id: "tool-1", title: "running-tool", status: "running" }),
          makeSpec({ id: "tool-2", title: "done-tool", status: "completed" }),
        ],
        totalVisible: 2,
        completedVisible: 1,
        allComplete: false,
      });
      const blocks = renderer.renderToolCard(snap);
      const allText = JSON.stringify(blocks);
      expect(allText).toContain("running-tool");
      expect(allText).toContain("done-tool");
      // Completed should appear before running
      const doneIdx = allText.indexOf("done-tool");
      const runIdx = allText.indexOf("running-tool");
      expect(doneIdx).toBeLessThan(runIdx);
    });

    it("renders usage data", () => {
      const snap = makeSnapshot({
        usage: { tokensUsed: 12500, cost: 0.03 },
      });
      const blocks = renderer.renderToolCard(snap);
      const allText = JSON.stringify(blocks);
      expect(allText).toContain("12.5k");
      expect(allText).toContain("$0.03");
      // Should have a divider before usage
      expect(blocks.some((b) => b.type === "divider")).toBe(true);
    });
  });

  describe("renderMainMessage", () => {
    it("in-progress shows progress count", () => {
      const snap = makeSnapshot({
        specs: [
          makeSpec({ id: "t1", title: "Read file", status: "completed" }),
          makeSpec({ id: "t2", title: "Edit file", status: "running" }),
        ],
        totalVisible: 2,
        completedVisible: 1,
        allComplete: false,
      });
      const blocks = renderer.renderMainMessage(snap, false);
      const allText = JSON.stringify(blocks);
      expect(allText).toContain("Processing...");
      expect(allText).toContain("1/2 tools");
    });

    it("completed shows Done + tool counts by icon", () => {
      const snap = makeSnapshot({
        specs: [
          makeSpec({ id: "t1", icon: "📖", status: "completed" }),
          makeSpec({ id: "t2", icon: "📖", status: "completed" }),
          makeSpec({ id: "t3", icon: "✏️", status: "completed" }),
        ],
        totalVisible: 3,
        completedVisible: 3,
        allComplete: true,
        usage: { tokensUsed: 5000, cost: 0.01 },
      });
      const blocks = renderer.renderMainMessage(snap, true);
      const allText = JSON.stringify(blocks);
      expect(allText).toContain("Done");
      expect(allText).toContain("📖 ×2");
      expect(allText).toContain("✏️ ×1");
      expect(allText).toContain("5k");
      expect(allText).toContain("$0.01");
    });
  });

  describe("renderMainMessageLow", () => {
    it("in-progress shows Processing", () => {
      const blocks = renderer.renderMainMessageLow(false);
      expect(blocks).toHaveLength(1);
      expect(blocks[0].type).toBe("section");
      expect((blocks[0] as any).text.text).toContain("Processing...");
    });

    it("complete shows Done", () => {
      const blocks = renderer.renderMainMessageLow(true);
      expect(blocks).toHaveLength(1);
      expect(blocks[0].type).toBe("section");
      expect((blocks[0] as any).text.text).toContain("Done");
    });
  });
});
