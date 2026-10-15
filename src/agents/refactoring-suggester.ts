import type { AgentDefinition } from '@anthropic-ai/claude-agent-sdk';
import { REFACTORING_SUGGESTER_PROMPT } from '../prompts/refactoring-suggester.prompt.js';

/**
 * Refactoring Suggester subagent
 *
 * Identifies opportunities to modernize code, apply design patterns,
 * extract methods/classes, and remove dead/redundant logic. Provides
 * before/after code examples and an impact assessment for each suggestion.
 */
export const refactoringSuggester: AgentDefinition = {
  description:
    'Identifies refactoring and modernization opportunities in a source file - design pattern ' +
    'improvements, extract-method/extract-class candidates, and dead code removal. Use this ' +
    'agent whenever a file needs architectural/structural improvement suggestions.',
  tools: ['Read', 'Grep', 'Glob', 'Skill'],
  model: 'inherit',
  prompt: REFACTORING_SUGGESTER_PROMPT
};
