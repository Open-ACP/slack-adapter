// src/__tests__/modal-handler.test.ts
import { describe, expect, it } from "vitest";
import { SlackModalHandler } from "../modal-handler.js";

const handler = new SlackModalHandler();

describe("SlackModalHandler.buildOutputModeModal", () => {
  it("returns a valid modal with correct structure", () => {
    const modal = handler.buildOutputModeModal("medium");
    expect(modal.type).toBe("modal");
    expect(modal.callback_id).toBe("output_mode_modal");
    expect(modal.title.type).toBe("plain_text");
    expect(modal.submit.type).toBe("plain_text");
    expect(modal.close.type).toBe("plain_text");
    expect(Array.isArray(modal.blocks)).toBe(true);
    expect(modal.blocks.length).toBeGreaterThan(0);
  });

  it("contains a radio_buttons block for mode selection", () => {
    const modal = handler.buildOutputModeModal("medium");
    const modeBlock = modal.blocks.find(
      (b: any) => b.block_id === "output_mode_block"
    );
    expect(modeBlock).toBeDefined();
    expect(modeBlock.element.type).toBe("radio_buttons");
    expect(modeBlock.element.action_id).toBe("output_mode_action");
  });

  it("contains a static_select block for scope selection", () => {
    const modal = handler.buildOutputModeModal("medium");
    const scopeBlock = modal.blocks.find(
      (b: any) => b.block_id === "output_scope_block"
    );
    expect(scopeBlock).toBeDefined();
    expect(scopeBlock.element.type).toBe("static_select");
    expect(scopeBlock.element.action_id).toBe("output_scope_action");
  });

  it("radio_buttons has 3 mode options (low, medium, high)", () => {
    const modal = handler.buildOutputModeModal("low");
    const modeBlock = modal.blocks.find(
      (b: any) => b.block_id === "output_mode_block"
    );
    const options = modeBlock.element.options;
    expect(options).toHaveLength(3);
    const values = options.map((o: any) => o.value);
    expect(values).toContain("low");
    expect(values).toContain("medium");
    expect(values).toContain("high");
  });

  it("static_select has 2 scope options", () => {
    const modal = handler.buildOutputModeModal("medium");
    const scopeBlock = modal.blocks.find(
      (b: any) => b.block_id === "output_scope_block"
    );
    const options = scopeBlock.element.options;
    expect(options).toHaveLength(2);
  });

  it("pre-selects the current mode (low)", () => {
    const modal = handler.buildOutputModeModal("low");
    const modeBlock = modal.blocks.find(
      (b: any) => b.block_id === "output_mode_block"
    );
    expect(modeBlock.element.initial_option?.value).toBe("low");
  });

  it("pre-selects the current mode (medium)", () => {
    const modal = handler.buildOutputModeModal("medium");
    const modeBlock = modal.blocks.find(
      (b: any) => b.block_id === "output_mode_block"
    );
    expect(modeBlock.element.initial_option?.value).toBe("medium");
  });

  it("pre-selects the current mode (high)", () => {
    const modal = handler.buildOutputModeModal("high");
    const modeBlock = modal.blocks.find(
      (b: any) => b.block_id === "output_mode_block"
    );
    expect(modeBlock.element.initial_option?.value).toBe("high");
  });

  it("pre-selects scope 'This session' when sessionId is provided", () => {
    const modal = handler.buildOutputModeModal("medium", "sess-123");
    const scopeBlock = modal.blocks.find(
      (b: any) => b.block_id === "output_scope_block"
    );
    expect(scopeBlock.element.initial_option?.value).toBe("session");
  });

  it("pre-selects scope 'All sessions' when sessionId is not provided", () => {
    const modal = handler.buildOutputModeModal("medium");
    const scopeBlock = modal.blocks.find(
      (b: any) => b.block_id === "output_scope_block"
    );
    expect(scopeBlock.element.initial_option?.value).toBe("adapter");
  });

  it("encodes sessionId in private_metadata", () => {
    const modal = handler.buildOutputModeModal("medium", "sess-abc");
    const meta = JSON.parse(modal.private_metadata);
    expect(meta.sessionId).toBe("sess-abc");
  });

  it("encodes undefined sessionId in private_metadata when not provided", () => {
    const modal = handler.buildOutputModeModal("high");
    const meta = JSON.parse(modal.private_metadata);
    expect(meta.sessionId).toBeUndefined();
  });

  it("mode options include description text", () => {
    const modal = handler.buildOutputModeModal("medium");
    const modeBlock = modal.blocks.find(
      (b: any) => b.block_id === "output_mode_block"
    );
    const options = modeBlock.element.options;
    options.forEach((opt: any) => {
      expect(opt.description).toBeDefined();
      expect(opt.description.type).toBe("plain_text");
      expect(opt.description.text.length).toBeGreaterThan(0);
    });
  });
});

describe("SlackModalHandler.parseSubmission", () => {
  function makeViewState(mode: string, scope: string) {
    return {
      output_mode_block: {
        output_mode_action: {
          type: "radio_buttons",
          selected_option: { value: mode },
        },
      },
      output_scope_block: {
        output_scope_action: {
          type: "static_select",
          selected_option: { value: scope },
        },
      },
    };
  }

  it("extracts mode=low and scope=session", () => {
    const state = makeViewState("low", "session");
    const result = handler.parseSubmission(state, "sess-1");
    expect(result.mode).toBe("low");
    expect(result.scope).toBe("session");
    expect(result.sessionId).toBe("sess-1");
  });

  it("extracts mode=medium and scope=adapter", () => {
    const state = makeViewState("medium", "adapter");
    const result = handler.parseSubmission(state);
    expect(result.mode).toBe("medium");
    expect(result.scope).toBe("adapter");
    expect(result.sessionId).toBeUndefined();
  });

  it("extracts mode=high and scope=session", () => {
    const state = makeViewState("high", "session");
    const result = handler.parseSubmission(state, "sess-xyz");
    expect(result.mode).toBe("high");
    expect(result.scope).toBe("session");
    expect(result.sessionId).toBe("sess-xyz");
  });

  it("returns sessionId=undefined when not provided", () => {
    const state = makeViewState("medium", "adapter");
    const result = handler.parseSubmission(state);
    expect(result.sessionId).toBeUndefined();
  });
});
