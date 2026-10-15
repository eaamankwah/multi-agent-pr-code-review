/**
 * Agent Execution Traces (Standout Feature)
 *
 * Captures which tools each agent (orchestrator + subagents) invoked and in
 * what order, then renders a Mermaid.js sequence diagram that can be
 * embedded into the final report for transparency into the AI's
 * decision-making flow.
 */

export type TraceEventType = 'tool_use' | 'subagent_start' | 'subagent_stop';

export interface TraceEvent {
  /** Millisecond timestamp when the event occurred */
  timestamp: number;
  /** 'orchestrator' or the subagent type (e.g. 'code-quality-analyzer') */
  actor: string;
  type: TraceEventType;
  /** Tool name for 'tool_use' events (e.g. mcp__github__get_pull_request, Read, Task) */
  tool?: string;
  /** Short, human-readable detail (e.g. file path or agent id) */
  detail?: string;
}

/**
 * Sanitize a label for use inside a Mermaid sequence diagram message.
 * Mermaid is sensitive to certain characters (colons, semicolons, newlines).
 */
function sanitize(label: string): string {
  return label
    .replace(/[\r\n]+/g, ' ')
    .replace(/:/g, '-')
    .replace(/;/g, ',')
    .slice(0, 120);
}

/**
 * Build a Mermaid.js `sequenceDiagram` string from a list of captured
 * execution trace events. Participants are the Orchestrator plus every
 * distinct subagent actor seen in the trace.
 */
export function buildMermaidTrace(events: TraceEvent[]): string {
  if (events.length === 0) {
    return [
      'sequenceDiagram',
      '    participant Orchestrator',
      '    Note over Orchestrator: No execution trace was captured for this run.'
    ].join('\n');
  }

  const sorted = [...events].sort((a, b) => a.timestamp - b.timestamp);

  const participants = new Set<string>(['Orchestrator']);
  for (const event of sorted) {
    if (event.actor && event.actor !== 'orchestrator') {
      participants.add(event.actor);
    }
  }

  const lines: string[] = ['sequenceDiagram'];
  for (const participant of participants) {
    const id = participant === 'Orchestrator' ? 'Orchestrator' : toParticipantId(participant);
    lines.push(`    participant ${id} as ${participant}`);
  }

  for (const event of sorted) {
    const actorId = event.actor === 'orchestrator' ? 'Orchestrator' : toParticipantId(event.actor);

    switch (event.type) {
      case 'subagent_start':
        lines.push(
          `    Orchestrator->>+${actorId}: ${sanitize('Task: ' + (event.detail || event.actor))}`
        );
        break;
      case 'subagent_stop':
        lines.push(`    ${actorId}-->>-Orchestrator: ${sanitize(event.detail || 'done')}`);
        break;
      case 'tool_use':
      default: {
        const toolLabel = sanitize(event.tool || 'tool');
        const detailLabel = event.detail ? sanitize(event.detail) : '';
        const label = detailLabel ? `${toolLabel} (${detailLabel})` : toolLabel;
        lines.push(`    ${actorId}->>${actorId}: ${label}`);
        break;
      }
    }
  }

  return lines.join('\n');
}

function toParticipantId(name: string): string {
  // Mermaid participant ids can't contain spaces/hyphens cleanly when referenced repeatedly;
  // keep a readable alias via "as".
  const id = name.replace(/[^a-zA-Z0-9]/g, '_');
  return id || 'Agent';
}
