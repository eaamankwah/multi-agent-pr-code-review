import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mock the Claude Agent SDK's query() function so these tests run without
// any real API calls, credentials, or MCP server processes.
// ---------------------------------------------------------------------------

const queryMock = vi.fn();

vi.mock('@anthropic-ai/claude-agent-sdk', () => {
  return {
    query: (...args: unknown[]) => queryMock(...args)
  };
});

// Import AFTER the mock is registered so the orchestrator picks it up.
const { CodeReviewOrchestrator } = await import('../src/orchestrator.js');

function buildValidStructuredOutput() {
  const codeQuality = {
    file: 'src/index.ts',
    issues: [
      {
        line: 10,
        severity: 'critical' as const,
        category: 'security' as const,
        description: 'Hardcoded API key',
        suggestion: 'Move to environment variable'
      }
    ],
    overallScore: 60,
    summary: 'One critical security issue.'
  };

  const testCoverage = {
    file: 'src/index.ts',
    hasTests: false,
    testFiles: [],
    untestedPaths: [
      {
        type: 'function' as const,
        location: 'main()',
        priority: 'high' as const,
        reasoning: 'No tests exist for this file',
        suggestedTest: 'Add a smoke test that runs main() with sample args'
      }
    ],
    coverageEstimate: 0,
    summary: 'No test coverage found.'
  };

  const refactorings = {
    file: 'src/index.ts',
    suggestions: [],
    summary: 'No refactoring opportunities identified.'
  };

  return {
    pullRequest: { owner: 'octocat', repo: 'Hello-World', number: 1 },
    fileReviews: [{ file: 'src/index.ts', codeQuality, testCoverage, refactorings }],
    summary: {
      totalFiles: 1,
      overallScore: 60,
      criticalIssues: 1,
      highPriorityTests: 1,
      refactoringOpportunities: 0
    },
    recommendations: [
      {
        priority: 'critical' as const,
        category: 'security',
        description: 'Remove hardcoded API key',
        files: ['src/index.ts']
      }
    ],
    metadata: {
      analyzedAt: new Date().toISOString(),
      duration: 0,
      agentVersions: {
        'code-quality-analyzer': '1.0.0',
        'test-coverage-analyzer': '1.0.0',
        'refactoring-suggester': '1.0.0'
      }
    }
  };
}

/** Build a fake async-iterable "Query" result like the real SDK returns. */
function fakeQueryResult(messages: unknown[]) {
  return {
    async *[Symbol.asyncIterator]() {
      for (const message of messages) {
        yield message;
      }
    }
  };
}

beforeEach(() => {
  queryMock.mockReset();
  process.env.ANTHROPIC_MODEL = 'claude-sonnet-4-5-20250929';
});

describe('CodeReviewOrchestrator', () => {
  describe('Configuration', () => {
    it('should initialize with default options', () => {
      const orchestrator = new CodeReviewOrchestrator();
      expect(orchestrator).toBeInstanceOf(CodeReviewOrchestrator);
    });

    it('should throw a clear error if no model is configured', () => {
      const original = process.env.ANTHROPIC_MODEL;
      delete process.env.ANTHROPIC_MODEL;
      expect(() => new CodeReviewOrchestrator()).toThrow(/model/i);
      process.env.ANTHROPIC_MODEL = original;
    });

    it('should accept custom rate limit configuration', () => {
      const orchestrator = new CodeReviewOrchestrator({
        rateLimits: { maxRequestsPerMinute: 5, maxConcurrent: 1 }
      });
      expect(orchestrator).toBeInstanceOf(CodeReviewOrchestrator);
    });
  });

  describe('reviewPullRequest', () => {
    it('should call query() with the Task tool allowed and all 3 subagents registered', async () => {
      queryMock.mockReturnValue(
        fakeQueryResult([
          {
            type: 'result',
            subtype: 'success',
            structured_output: buildValidStructuredOutput()
          }
        ])
      );

      const orchestrator = new CodeReviewOrchestrator({ maxRetries: 1, timeoutMs: 5000 });
      await orchestrator.reviewPullRequest('octocat', 'Hello-World', 1);

      expect(queryMock).toHaveBeenCalledTimes(1);
      const [{ options }] = queryMock.mock.calls[0] as [{ options: Record<string, unknown> }];

      expect(options.allowedTools).toContain('Task');
      expect(Object.keys(options.agents as Record<string, unknown>).sort()).toEqual(
        ['code-quality-analyzer', 'refactoring-suggester', 'test-coverage-analyzer'].sort()
      );
    });

    it('should aggregate the structured_output into a ReviewReport', async () => {
      queryMock.mockReturnValue(
        fakeQueryResult([
          {
            type: 'result',
            subtype: 'success',
            structured_output: buildValidStructuredOutput()
          }
        ])
      );

      const orchestrator = new CodeReviewOrchestrator({ maxRetries: 1, timeoutMs: 5000 });
      const report = await orchestrator.reviewPullRequest('octocat', 'Hello-World', 1);

      expect(report.pullRequest).toEqual({ owner: 'octocat', repo: 'Hello-World', number: 1 });
      expect(report.fileReviews).toHaveLength(1);
      expect(report.summary.criticalIssues).toBe(1);
      expect(report.metadata.duration).toBeGreaterThanOrEqual(0);
    });

    it('should reject with a ReviewError when structured output fails Zod validation', async () => {
      queryMock.mockReturnValue(
        fakeQueryResult([
          {
            type: 'result',
            subtype: 'success',
            structured_output: { not: 'a valid report' }
          }
        ])
      );

      const orchestrator = new CodeReviewOrchestrator({ maxRetries: 1, timeoutMs: 5000 });
      await expect(orchestrator.reviewPullRequest('octocat', 'Hello-World', 1)).rejects.toThrow();
    });

    it('should reject when the SDK reports an execution error', async () => {
      queryMock.mockReturnValue(
        fakeQueryResult([
          {
            type: 'result',
            subtype: 'error_during_execution',
            errors: ['MCP server failed to connect']
          }
        ])
      );

      const orchestrator = new CodeReviewOrchestrator({ maxRetries: 1, timeoutMs: 5000 });
      await expect(orchestrator.reviewPullRequest('octocat', 'Hello-World', 1)).rejects.toThrow();
    });

    it('should capture an execution trace from SubagentStart/Stop and PreToolUse hooks', async () => {
      queryMock.mockImplementation((...args: unknown[]) => {
        const { options } = args[0] as { options: any };
        // Simulate the SDK firing hooks during execution. The hook bodies used by the
        // orchestrator contain no internal `await`, so calling them (even without
        // awaiting the returned promise) runs their synchronous body immediately.
        void options.hooks.PreToolUse[0].hooks[0]({
          tool_name: 'mcp__github__get_pull_request_files',
          tool_input: { pull_number: 1 }
        });
        void options.hooks.SubagentStart[0].hooks[0]({ agent_type: 'code-quality-analyzer' });
        void options.hooks.SubagentStop[0].hooks[0]({ agent_id: 'code-quality-analyzer' });

        return fakeQueryResult([
          { type: 'result', subtype: 'success', structured_output: buildValidStructuredOutput() }
        ]);
      });

      const orchestrator = new CodeReviewOrchestrator({ maxRetries: 1, timeoutMs: 5000 });
      await orchestrator.reviewPullRequest('octocat', 'Hello-World', 1);

      const trace = orchestrator.getExecutionTrace();
      expect(trace.some(e => e.type === 'tool_use')).toBe(true);
      expect(trace.some(e => e.type === 'subagent_start')).toBe(true);
      expect(trace.some(e => e.type === 'subagent_stop')).toBe(true);
    });
  });

  describe('Integration', () => {
    // These tests require actual API keys and should be skipped in CI
    it.skip('should review a real small PR', async () => {
      const orchestrator = new CodeReviewOrchestrator();
      const result = await orchestrator.reviewPullRequest('octocat', 'Hello-World', 1);
      expect(result.pullRequest.owner).toBe('octocat');
    });
  });
});
