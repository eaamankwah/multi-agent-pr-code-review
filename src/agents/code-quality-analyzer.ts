import type { AgentDefinition } from '@anthropic-ai/claude-agent-sdk';
import { CODE_QUALITY_ANALYZER_PROMPT } from '../prompts/code-quality-analyzer.prompt.js';

/**
 * Code Quality Analyzer subagent
 *
 * Analyzes a single source file for security vulnerabilities, performance
 * issues, and maintainability concerns. Leverages Claude Skills
 * (javascript-best-practices, typescript-patterns, security-analysis, etc.)
 * for language/domain-specific expertise, and can use the ESLint MCP tools
 * for automated lint findings.
 */
export const codeQualityAnalyzer: AgentDefinition = {
  description:
    'Analyzes a source code file for security vulnerabilities, performance issues, and ' +
    'maintainability/best-practice concerns. Use this agent whenever a file needs a code ' +
    'quality review (security, performance, bugs, style, best practices).',
  tools: ['Read', 'Grep', 'Glob', 'Skill', 'mcp__eslint__lint-files'],
  model: 'inherit',
  prompt: CODE_QUALITY_ANALYZER_PROMPT
};
