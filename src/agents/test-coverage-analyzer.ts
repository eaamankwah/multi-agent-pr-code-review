import type { AgentDefinition } from '@anthropic-ai/claude-agent-sdk';
import { TEST_COVERAGE_ANALYZER_PROMPT } from '../prompts/test-coverage-analyzer.prompt.js';

/**
 * Test Coverage Analyzer subagent
 *
 * Evaluates test completeness for a source file via static analysis
 * (comparing the source file against related test files) and suggests
 * specific, actionable test cases for untested paths.
 */
export const testCoverageAnalyzer: AgentDefinition = {
  description:
    'Identifies untested functions, classes, branches, and edge cases in a source file by ' +
    'comparing it against related test files, and suggests specific test cases. Use this ' +
    'agent whenever a file needs a test coverage assessment.',
  tools: ['Read', 'Grep', 'Glob', 'Skill'],
  model: 'inherit',
  prompt: TEST_COVERAGE_ANALYZER_PROMPT
};
