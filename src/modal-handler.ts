// src/modal-handler.ts
import type { OutputMode } from "@openacp/plugin-sdk";

export interface ModalView {
  type: "modal";
  callback_id: string;
  title: { type: "plain_text"; text: string };
  submit: { type: "plain_text"; text: string };
  close: { type: "plain_text"; text: string };
  private_metadata: string;
  blocks: any[];
}

export interface SubmissionResult {
  mode: OutputMode;
  scope: "session" | "adapter";
  sessionId?: string;
}

const MODE_OPTIONS = [
  {
    value: "low" as OutputMode,
    label: "🔇 Low",
    description: "Summary only, no tool details",
  },
  {
    value: "medium" as OutputMode,
    label: "📊 Medium",
    description: "Tool summaries + viewer links",
  },
  {
    value: "high" as OutputMode,
    label: "🔍 High",
    description: "Full details, thinking, output",
  },
];

const SCOPE_OPTIONS = [
  { value: "session", label: "This session" },
  { value: "adapter", label: "All sessions (adapter default)" },
];

export class SlackModalHandler {
  /**
   * Builds a Slack modal view for the /outputmode command.
   * Radio buttons let the user pick Low / Medium / High output verbosity.
   * A static select lets the user choose whether the change applies to
   * the current session or to all sessions (adapter default).
   */
  buildOutputModeModal(
    currentMode: OutputMode,
    sessionId?: string,
    channelId?: string,
  ): ModalView {
    const modeInitialOption = MODE_OPTIONS.find((o) => o.value === currentMode);
    const scopeInitialValue = sessionId !== undefined ? "session" : "adapter";
    const scopeInitialOption = SCOPE_OPTIONS.find(
      (o) => o.value === scopeInitialValue
    )!;

    return {
      type: "modal",
      callback_id: "output_mode_modal",
      title: { type: "plain_text", text: "Output Mode" },
      submit: { type: "plain_text", text: "Apply" },
      close: { type: "plain_text", text: "Cancel" },
      private_metadata: JSON.stringify({ sessionId, channelId }),
      blocks: [
        {
          type: "input",
          block_id: "output_mode_block",
          label: { type: "plain_text", text: "Verbosity" },
          element: {
            type: "radio_buttons",
            action_id: "output_mode_action",
            options: MODE_OPTIONS.map((opt) => ({
              text: { type: "plain_text", text: opt.label },
              description: { type: "plain_text", text: opt.description },
              value: opt.value,
            })),
            ...(modeInitialOption
              ? {
                  initial_option: {
                    text: {
                      type: "plain_text",
                      text: modeInitialOption.label,
                    },
                    description: {
                      type: "plain_text",
                      text: modeInitialOption.description,
                    },
                    value: modeInitialOption.value,
                  },
                }
              : {}),
          },
        },
        {
          type: "input",
          block_id: "output_scope_block",
          label: { type: "plain_text", text: "Apply to" },
          element: {
            type: "static_select",
            action_id: "output_scope_action",
            options: SCOPE_OPTIONS.map((opt) => ({
              text: { type: "plain_text", text: opt.label },
              value: opt.value,
            })),
            initial_option: {
              text: { type: "plain_text", text: scopeInitialOption.label },
              value: scopeInitialOption.value,
            },
          },
        },
      ],
    };
  }

  /**
   * Parses a Slack view_submission payload's state.values object into a
   * typed SubmissionResult.
   */
  parseSubmission(viewState: any, sessionId?: string): SubmissionResult {
    const values = viewState?.values ?? viewState;
    const mode: OutputMode =
      values.output_mode_block?.output_mode_action?.selected_option?.value;
    const scope: "session" | "adapter" =
      values.output_scope_block?.output_scope_action?.selected_option?.value;

    return {
      mode,
      scope,
      ...(sessionId !== undefined ? { sessionId } : {}),
    };
  }
}
