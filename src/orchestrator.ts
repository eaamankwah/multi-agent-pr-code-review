import { query } from '@anthropic-ai/claude-agent-sdk';
import type {
  Options,
  AgentDefinition,
  SDKResultMessage,
  PreToolUseHookInput,
  SubagentStartHookInput,
  SubagentStopHookInput,
  SyncHookJSONOutput
} from '@anthropic-ai/claude-agent-sdk';

import { mcpServersConfig } from './config/mcp.config.js';
import { codeQualityAnalyzer, testCoverageAnalyzer, refactoringSuggester } from './agents/index.js';
import { buildOrchestratorPrompt } from './prompts/index.js';
import { ReviewReportSchema, ReviewReportJSONSchema } from './types/report-types.js';
import type { ReviewReport } from './types/report-types.js';
import {
  RateLimiter,
  ReviewError,
  ErrorCodes,
  withRetry,
  withTimeout,
  logReviewStart,
  logReviewComplete,
  logReviewError,
  logAgentStart,
  logAgentComplete
} from './utils/index.js';
import type { RateLimiterConfig } from './utils/rate-limiter.js';
import type { TraceEvent } from './utils/execution-trace.js';

/**
 * Orchestrator configuration options
 */
export interface OrchestratorOptions {
  /** Claude model to use. Defaults to ANTHROPIC_MODEL env var. Never hardcoded. */
  model?: string;
  /** Max conversation turns for the orchestrator + subagent coordination loop */
  maxTurns?: number;
  /** Overall timeout for a single reviewPullRequest call, in ms */
  timeoutMs?: number;
  /** How many times to retry the whole review on transient failure */
  maxRetries?: number;
  /** Rate limiter configuration (requests/tokens per minute, concurrency) */
  rateLimits?: Partial<RateLimiterConfig>;
  /**
   * Standout feature: Automated PR Commenting.
   * When true, the orchestrator prompt instructs the agent to post the
   * review summary back to the PR via the GitHub MCP `add_issue_comment` tool.
   */
  postComment?: boolean;
  /** Max number of changed files to analyze in depth per PR */
  maxFiles?: number;
  /**
   * Standout feature: Interactive CLI progress.
   * Called every time a subagent starts/stops or a tool is invoked, so a
   * caller (e.g. main.ts) can drive a progress bar / spinner.
   */
  onProgress?: (event: TraceEvent) => void;
}

/**
 * Truncate/describe a tool input for logging & trace purposes without
 * dumping potentially large payloads (file contents, diffs, etc).
 */
function summarizeToolInput(toolInput: unknown): string {
  if (!toolInput || typeof toolInput !== 'object') return '';
  const obj = toolInput as Record<string, unknown>;
  const candidateKeys = ['file_path', 'path', 'filePaths', 'pull_number', 'pattern', 'subagent_type', 'description'];
  for (const key of candidateKeys) {
    if (key in obj) {
      const value = obj[key];
      return `${key}=${Array.isArray(value) ? value.join(',') : String(value)}`.slice(0, 100);
    }
  }
  return '';
}

/**
 * Main Code Review Orchestrator
 * Coordinates subagents to analyze pull requests and generate comprehensive reports
 */
export class CodeReviewOrchestrator {
  private readonly model: string;
  private readonly maxTurns: number;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly rateLimiter: RateLimiter;
  private readonly postComment: boolean;
  private readonly maxFiles: number;
  private readonly onProgress?: (event: TraceEvent) => void;
  private lastExecutionTrace: TraceEvent[] = [];

  constructor(options: OrchestratorOptions = {}) {
    // Model is never hardcoded - always sourced from options or the required env var.
    const model = options.model || process.env.ANTHROPIC_MODEL;
    if (!model) {
      throw new ReviewError(
        'No model configured. Pass `model` to CodeReviewOrchestrator or set ANTHROPIC_MODEL.',
        ErrorCodes.INVALID_CONFIG
      );
    }
    this.model = model;
    this.maxTurns = options.maxTurns ?? 60;
    this.timeoutMs = options.timeoutMs ?? 10 * 60 * 1000; // 10 minutes - multi-agent coordination is slow
    this.maxRetries = options.maxRetries ?? 2;
    this.rateLimiter = new RateLimiter(options.rateLimits);
    this.postComment = options.postComment ?? false;
    this.maxFiles = options.maxFiles ?? 5;
    this.onProgress = options.onProgress;
  }

  /**
   * Returns the Mermaid-diagrammable execution trace captured during the
   * most recent `reviewPullRequest` call (standout feature: execution traces).
   */
  getExecutionTrace(): TraceEvent[] {
    return this.lastExecutionTrace;
  }

  /**
   * Review a pull request using parallel subagent analysis
   * @param owner - Repository owner
   * @param repo - Repository name
   * @param prNumber - Pull request number
   * @returns Complete review report
   */
  async reviewPullRequest(
    owner: string,
    repo: string,
    prNumber: number
  ): Promise<ReviewReport> {
    const startTime = Date.now();
    logReviewStart(owner, repo, prNumber);
    this.lastExecutionTrace = [];

    try {
      const report = await withRetry(
        () =>
          withTimeout(
            () => this.runReviewWithRateLimit(owner, repo, prNumber),
            this.timeoutMs,
            `Review of ${owner}/${repo}#${prNumber} timed out after ${this.timeoutMs}ms`
          ),
        this.maxRetries,
        2000
      );

      const duration = Date.now() - startTime;
      const finalReport: ReviewReport = {
        ...report,
        metadata: {
          ...report.metadata,
          duration
        }
      };

      logReviewComplete(owner, repo, prNumber, finalReport.summary.overallScore, duration);
      return finalReport;
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      logReviewError(owner, repo, prNumber, err);
      throw error;
    }
  }

  private async runReviewWithRateLimit(
    owner: string,
    repo: string,
    prNumber: number
  ): Promise<ReviewReport> {
    // A full multi-agent review is estimated conservatively at ~20k tokens.
    await this.rateLimiter.acquire(20000);
    try {
      return await this.runReview(owner, repo, prNumber);
    } finally {
      this.rateLimiter.release();
    }
  }

  private async runReview(owner: string, repo: string, prNumber: number): Promise<ReviewReport> {
    const prompt = buildOrchestratorPrompt(owner, repo, prNumber, {
      postComment: this.postComment,
      maxFiles: this.maxFiles
    });

    const agents: Record<string, AgentDefinition> = {
      'code-quality-analyzer': codeQualityAnalyzer,
      'test-coverage-analyzer': testCoverageAnalyzer,
      'refactoring-suggester': refactoringSuggester
    };

    const trace: TraceEvent[] = [];
    const record = (event: TraceEvent): void => {
      trace.push(event);
      this.onProgress?.(event);
    };
    const startTimeMs = Date.now();

    const options: Options = {
      model: this.model,
      agents,
      // Resolves relative to PROJECT_ROOT (or CWD) so `.claude/skills/` is discoverable.
      cwd: process.env.PROJECT_ROOT || process.cwd(),
      // MCP servers give the orchestrator/subagents access to GitHub + ESLint tools
      mcpServers: mcpServersConfig,
      // Task tool is REQUIRED for the orchestrator to spawn subagents.
      allowedTools: [
        'Task',
        'Read',
        'Grep',
        'Glob',
        'Skill',
        'mcp__github__get_pull_request',
        'mcp__github__get_pull_request_files',
        'mcp__github__get_pull_request_comments',
        'mcp__github__add_issue_comment',
        'mcp__eslint__lint-files'
      ],
      // Automated / CI-style usage: never prompt a human for tool permission.
      permissionMode: 'bypassPermissions',
      allowDangerouslySkipPermissions: true,
      maxTurns: this.maxTurns,
      // 'project' is required so the SDK loads .claude/skills/ from PROJECT_ROOT.
      settingSources: ['project'],
      outputFormat: {
        type: 'json_schema',
        schema: ReviewReportJSONSchema
      },
      hooks: {
        SubagentStart: [
          {
            hooks: [
              async (rawInput): Promise<SyncHookJSONOutput> => {
                const input = rawInput as SubagentStartHookInput;
                record({
                  timestamp: Date.now(),
                  actor: input.agent_type,
                  type: 'subagent_start',
                  detail: input.agent_type
                });
                logAgentStart(input.agent_type, '');
                return {};
              }
            ]
          }
        ],
        SubagentStop: [
          {
            hooks: [
              async (rawInput): Promise<SyncHookJSONOutput> => {
                const input = rawInput as SubagentStopHookInput;
                record({
                  timestamp: Date.now(),
                  actor: input.agent_id,
                  type: 'subagent_stop',
                  detail: 'completed'
                });
                logAgentComplete(input.agent_id, '', Date.now() - startTimeMs);
                return {};
              }
            ]
          }
        ],
        PreToolUse: [
          {
            hooks: [
              async (rawInput): Promise<SyncHookJSONOutput> => {
                const input = rawInput as PreToolUseHookInput;
                record({
                  timestamp: Date.now(),
                  actor: 'orchestrator',
                  type: 'tool_use',
                  tool: input.tool_name,
                  detail: summarizeToolInput(input.tool_input)
                });
                return { continue: true };
              }
            ]
          }
        ]
      }
    };

    const result = query({ prompt, options });

    let resultMessage: SDKResultMessage | null = null;

    for await (const message of result) {
      if (message.type === 'result') {
        resultMessage = message;
      }
    }

    if (!resultMessage) {
      throw new ReviewError(
        'Orchestrator query produced no result message',
        ErrorCodes.AGENT_FAILED
      );
    }

    if (resultMessage.subtype !== 'success') {
      throw new ReviewError(
        `Orchestrator query failed with subtype: ${resultMessage.subtype}`,
        ErrorCodes.AGENT_FAILED,
        { errors: resultMessage.errors }
      );
    }

    const structuredOutput = resultMessage.structured_output;
    if (!structuredOutput) {
      throw new ReviewError(
        'Orchestrator did not return a structured_output matching the ReviewReport schema',
        ErrorCodes.STRUCTURED_OUTPUT_FAILED
      );
    }

    const parsed = ReviewReportSchema.safeParse(structuredOutput);
    if (!parsed.success) {
      throw new ReviewError(
        'Structured output failed Zod validation against ReviewReportSchema',
        ErrorCodes.STRUCTURED_OUTPUT_FAILED,
        { issues: parsed.error.issues }
      );
    }

    this.lastExecutionTrace = trace;
    return parsed.data;
  }
}

