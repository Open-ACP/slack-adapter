import {
  BaseRenderer,
} from '@openacp/plugin-sdk'
import type {
  RenderedMessage,
  RenderedPermission,
  OutgoingMessage,
  PermissionRequest,
  NotificationMessage,
  DisplayVerbosity,
} from '@openacp/plugin-sdk'
import { SlackFormatter, markdownToMrkdwn } from './formatter.js'

/**
 * SlackRenderer — renders messages as Slack Block Kit structures.
 * Delegates to the existing SlackFormatter for block generation,
 * wrapping results into RenderedMessage with format: 'structured'.
 */
export class SlackRenderer extends BaseRenderer {
  private formatter: SlackFormatter

  constructor(formatter?: SlackFormatter) {
    super()
    this.formatter = formatter ?? new SlackFormatter()
  }

  renderText(content: OutgoingMessage): RenderedMessage {
    const blocks = this.formatter.formatOutgoing(content)
    return {
      body: content.text ?? '',
      format: 'structured',
      components: blocks,
    }
  }

  renderThought(content: OutgoingMessage, _verbosity: DisplayVerbosity): RenderedMessage {
    const blocks = this.formatter.formatOutgoing(content)
    return {
      body: content.text ?? '',
      format: 'structured',
      components: blocks,
    }
  }

  renderToolCall(content: OutgoingMessage, _verbosity: DisplayVerbosity): RenderedMessage {
    const blocks = this.formatter.formatOutgoing(content)
    return {
      body: content.text ?? '',
      format: 'structured',
      components: blocks,
    }
  }

  renderToolUpdate(content: OutgoingMessage, _verbosity: DisplayVerbosity): RenderedMessage {
    const blocks = this.formatter.formatOutgoing(content)
    return {
      body: content.text ?? '',
      format: 'structured',
      components: blocks,
    }
  }

  renderPlan(content: OutgoingMessage): RenderedMessage {
    const blocks = this.formatter.formatOutgoing(content)
    return {
      body: content.text ?? '',
      format: 'structured',
      components: blocks,
    }
  }

  renderUsage(content: OutgoingMessage, _verbosity: DisplayVerbosity): RenderedMessage {
    const blocks = this.formatter.formatOutgoing(content)
    return {
      body: content.text ?? '',
      format: 'structured',
      components: blocks,
    }
  }

  renderError(content: OutgoingMessage): RenderedMessage {
    const blocks = this.formatter.formatOutgoing(content)
    return {
      body: content.text ?? '',
      format: 'structured',
      components: blocks,
    }
  }

  renderSessionEnd(content: OutgoingMessage): RenderedMessage {
    const blocks = this.formatter.formatSessionEnd(content.text)
    return {
      body: content.text ?? 'Session ended',
      format: 'structured',
      components: blocks,
    }
  }

  renderPermission(request: PermissionRequest): RenderedPermission {
    const blocks = this.formatter.formatPermissionRequest(request)
    return {
      body: request.description,
      format: 'structured',
      components: blocks,
      actions: request.options.map(o => ({ id: o.id, label: o.label, isAllow: o.isAllow })),
    }
  }

  renderNotification(notification: NotificationMessage): RenderedMessage {
    const emoji: Record<string, string> = {
      completed: '\u2705', error: '\u274C', permission: '\u{1F510}', input_required: '\u{1F4AC}', budget_warning: '\u26A0\uFE0F',
    }
    const icon = emoji[notification.type] || '\u2139\uFE0F'
    const text = `${icon} *${notification.sessionName ?? 'Session'}*\n${notification.summary}`
    const blocks = this.formatter.formatNotification(text)
    return {
      body: text,
      format: 'structured',
      components: blocks,
    }
  }

  renderSystemMessage(content: OutgoingMessage): RenderedMessage {
    const mrkdwn = markdownToMrkdwn(content.text ?? '')
    return {
      body: mrkdwn,
      format: 'structured',
      components: [{ type: 'section' as const, text: { type: 'mrkdwn' as const, text: mrkdwn } }],
    }
  }

  renderModeChange(content: OutgoingMessage): RenderedMessage {
    const modeId = (content.metadata as Record<string, unknown>)?.modeId ?? ''
    const text = `\u{1F504} *Mode:* ${modeId}`
    return {
      body: text,
      format: 'structured',
      components: [{ type: 'context' as const, elements: [{ type: 'mrkdwn' as const, text }] }],
    }
  }

  renderConfigUpdate(): RenderedMessage {
    const text = '\u2699\uFE0F *Config updated*'
    return {
      body: text,
      format: 'structured',
      components: [{ type: 'context' as const, elements: [{ type: 'mrkdwn' as const, text }] }],
    }
  }

  renderModelUpdate(content: OutgoingMessage): RenderedMessage {
    const modelId = (content.metadata as Record<string, unknown>)?.modelId ?? ''
    const text = `\u{1F916} *Model:* ${modelId}`
    return {
      body: text,
      format: 'structured',
      components: [{ type: 'context' as const, elements: [{ type: 'mrkdwn' as const, text }] }],
    }
  }
}
