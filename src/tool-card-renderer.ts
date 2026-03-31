// src/tool-card-renderer.ts
import type { types } from "@slack/bolt";
import type { ToolCardSnapshot, ToolDisplaySpec } from "@openacp/plugin-sdk";

type KnownBlock = types.KnownBlock;

// ─── Block Kit helpers ──────────────────────────────────────────────────────

const BLOCK_TEXT_LIMIT = 3000;

function truncate(text: string): string {
  return text.length > BLOCK_TEXT_LIMIT
    ? text.slice(0, BLOCK_TEXT_LIMIT - 3) + "..."
    : text;
}

function section(text: string): KnownBlock {
  return { type: "section", text: { type: "mrkdwn", text: truncate(text) } };
}

function ctx(text: string): KnownBlock {
  return { type: "context", elements: [{ type: "mrkdwn", text: truncate(text) }] };
}

// ─── Status icons ───────────────────────────────────────────────────────────

const DONE_STATUSES = new Set(["completed", "done", "failed", "error"]);

function statusIcon(status: string): string {
  if (status === "error" || status === "failed") return "❌";
  if (status === "completed" || status === "done") return "✅";
  return "🔄";
}

// ─── Token formatting ───────────────────────────────────────────────────────

function formatTokens(n: number): string {
  if (n >= 1000) {
    const k = n / 1000;
    // Avoid trailing .0
    return Number.isInteger(k) ? `${k}k` : `${parseFloat(k.toFixed(1))}k`;
  }
  return String(n);
}

// ─── Renderer ───────────────────────────────────────────────────────────────

export class SlackToolCardRenderer {
  /**
   * Renders full tool details for a thread reply.
   * Filters out hidden specs, shows completed first then running.
   */
  renderToolCard(snapshot: ToolCardSnapshot): KnownBlock[] {
    const blocks: KnownBlock[] = [];

    const visible = snapshot.specs.filter((s) => !s.isHidden);
    const completed = visible.filter((s) => DONE_STATUSES.has(s.status));
    const running = visible.filter((s) => !DONE_STATUSES.has(s.status));

    for (const spec of [...completed, ...running]) {
      this.renderSpec(spec, blocks);
    }

    // Usage footer
    if (snapshot.usage) {
      const { tokensUsed, cost } = snapshot.usage;
      const parts: string[] = [];
      if (tokensUsed !== undefined) parts.push(`${formatTokens(tokensUsed)} tokens`);
      if (cost !== undefined) parts.push(`$${cost}`);
      if (parts.length > 0) {
        blocks.push({ type: "divider" } as KnownBlock);
        blocks.push(ctx(`📊 ${parts.join(" · ")}`));
      }
    }

    return blocks;
  }

  /**
   * Renders main message for medium/high mode.
   * In progress: processing header + per-tool status lines + progress count.
   * Complete: done header + tool counts by icon + usage.
   */
  renderMainMessage(snapshot: ToolCardSnapshot, isComplete: boolean): KnownBlock[] {
    const blocks: KnownBlock[] = [];
    const visible = snapshot.specs.filter((s) => !s.isHidden);

    if (!isComplete) {
      blocks.push(section("🔧 *Processing...*"));
      for (const spec of visible) {
        blocks.push(ctx(`${statusIcon(spec.status)} ${spec.title}`));
      }
      const { completedVisible, totalVisible } = snapshot;
      blocks.push(ctx(`${completedVisible}/${totalVisible} tools`));
    } else {
      blocks.push(section("✅ *Done*"));

      // Aggregate tool counts by icon
      const iconCounts = new Map<string, number>();
      for (const spec of visible) {
        iconCounts.set(spec.icon, (iconCounts.get(spec.icon) ?? 0) + 1);
      }
      const countParts = Array.from(iconCounts.entries()).map(
        ([icon, count]) => `${icon} ×${count}`,
      );
      if (countParts.length > 0) {
        blocks.push(ctx(countParts.join("  ")));
      }

      // Usage
      if (snapshot.usage) {
        const { tokensUsed, cost } = snapshot.usage;
        const parts: string[] = [];
        if (tokensUsed !== undefined) parts.push(`${formatTokens(tokensUsed)} tokens`);
        if (cost !== undefined) parts.push(`$${cost}`);
        if (parts.length > 0) {
          blocks.push(ctx(`📊 ${parts.join(" · ")}`));
        }
      }
    }

    return blocks;
  }

  /**
   * Renders main message for low mode.
   * Just a simple processing/done indicator.
   */
  renderMainMessageLow(isComplete: boolean): KnownBlock[] {
    return [section(isComplete ? "✅ *Done*" : "🔧 *Processing...*")];
  }

  // ─── Private ────────────────────────────────────────────────────────────

  private renderSpec(spec: ToolDisplaySpec, blocks: KnownBlock[]): void {
    // Title line: {statusIcon} {icon} *{title}*  |  _+{added}/-{removed}_
    let titleLine = `${statusIcon(spec.status)} ${spec.icon} *${spec.title}*`;
    if (spec.diffStats) {
      titleLine += `  |  _+${spec.diffStats.added}/-${spec.diffStats.removed}_`;
    }
    blocks.push(ctx(titleLine));

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

    // Output content (high mode only — the caller controls what's in the spec)
    if (spec.outputContent) {
      blocks.push(section("```\n" + spec.outputContent + "\n```"));
    }

    // Output fallback content (when outputContent is absent)
    if (!spec.outputContent && spec.outputFallbackContent) {
      blocks.push(section("```\n" + spec.outputFallbackContent + "\n```"));
    }

    // Viewer links
    const links: string[] = [];
    if (spec.viewerLinks?.file) {
      links.push(`<${spec.viewerLinks.file}|View File>`);
    }
    if (spec.viewerLinks?.diff) {
      links.push(`<${spec.viewerLinks.diff}|View Diff>`);
    }
    if (spec.outputViewerLink) {
      links.push(`<${spec.outputViewerLink}|View Output>`);
    }
    if (links.length > 0) {
      blocks.push(ctx(links.join("  ·  ")));
    }
  }
}
