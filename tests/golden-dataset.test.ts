import 'dotenv/config';
import { describe, it, expect, beforeAll } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { query } from '@anthropic-ai/claude-agent-sdk';

import { codeQualityAnalyzer } from '../src/agents/index.js';
import { CodeQualityResultSchema, CodeQualityResultJSONSchema } from '../src/types/analysis-results.js';

/**
 * Standout Feature: Regression Testing Suite
 *
 * This suite runs the REAL code-quality-analyzer subagent (a real Claude
 * Agent SDK call) against a small "golden dataset" of fixture files, each
 * containing a well-known, deliberately injected issue (SQL injection,
 * hardcoded secret, XSS). It asserts the agent's structured findings still
 * flag the expected issue category/severity.
 *
 * This is NOT run as part of the default `npm test` because it requires a
 * real ANTHROPIC_API_KEY (or AWS Bedrock credentials) and makes live model
 * calls (slow + costs tokens). Run it explicitly with:
 *
 *   RUN_GOLDEN_DATASET=true npm run test:golden
 *
 * The purpose is to catch *prompt regressions* (e.g. a prompt edit that
 * accidentally makes the agent stop flagging a known vulnerability class)
 * rather than to be part of every CI run.
 */

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const FIXTURES_DIR = path.join(__dirname, 'fixtures', 'golden-dataset');

interface GoldenFixture {
  file: string;
  expectedCategory: string;
  expectedMinSeverity: 'critical' | 'high' | 'medium' | 'low' | 'info';
  description: string;
}

const SEVERITY_RANK: Record<string, number> = {
  info: 0,
  low: 1,
  medium: 2,
  high: 3,
  critical: 4
};

const shouldRun = process.env.RUN_GOLDEN_DATASET === 'true';

describe.skipIf(!shouldRun)('Golden Dataset Regression Suite (code-quality-analyzer)', () => {
  let fixtures: GoldenFixture[] = [];

  beforeAll(() => {
    const manifestPath = path.join(FIXTURES_DIR, 'manifest.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
    fixtures = manifest.fixtures;

    if (!process.env.ANTHROPIC_MODEL) {
      throw new Error('ANTHROPIC_MODEL must be set to run the golden dataset suite.');
    }
  });

  it('manifest fixture files all exist on disk', () => {
    for (const fixture of fixtures) {
      const fixturePath = path.join(FIXTURES_DIR, fixture.file);
      expect(fs.existsSync(fixturePath), `Missing fixture: ${fixture.file}`).toBe(true);
    }
  });

  it.each(
    // populated lazily inside beforeAll; vitest evaluates it.each at collection time,
    // so we fall back to reading the manifest synchronously here too.
    (() => {
      try {
        const manifest = JSON.parse(
          fs.readFileSync(path.join(FIXTURES_DIR, 'manifest.json'), 'utf-8')
        );
        return manifest.fixtures as GoldenFixture[];
      } catch {
        return [];
      }
    })()
  )(
    'flags the known issue in $file (expected: $expectedCategory / $expectedMinSeverity+)',
    async fixture => {
      const fixturePath = path.join(FIXTURES_DIR, fixture.file);

      const prompt = `Use the code-quality-analyzer agent to analyze the file at ${fixturePath} for security, performance, and maintainability issues. Return only the structured result.`;

      const result = query({
        prompt,
        options: {
          model: process.env.ANTHROPIC_MODEL,
          agents: { 'code-quality-analyzer': codeQualityAnalyzer },
          allowedTools: ['Task', 'Read', 'Grep', 'Glob', 'Skill'],
          permissionMode: 'bypassPermissions',
          allowDangerouslySkipPermissions: true,
          maxTurns: 15,
          settingSources: ['project'],
          outputFormat: {
            type: 'json_schema',
            schema: CodeQualityResultJSONSchema
          }
        }
      });

      let structuredOutput: unknown;
      for await (const message of result) {
        if (message.type === 'result' && message.subtype === 'success') {
          structuredOutput = message.structured_output;
        }
      }

      expect(structuredOutput, 'Agent did not return a structured_output').toBeDefined();

      const parsed = CodeQualityResultSchema.parse(structuredOutput);

      const matchingIssue = parsed.issues.find(
        issue =>
          issue.category === fixture.expectedCategory &&
          SEVERITY_RANK[issue.severity] >= SEVERITY_RANK[fixture.expectedMinSeverity]
      );

      expect(
        matchingIssue,
        `Expected a "${fixture.expectedCategory}" issue with severity >= "${fixture.expectedMinSeverity}" in ${fixture.file}, ` +
          `but got: ${JSON.stringify(parsed.issues, null, 2)}`
      ).toBeDefined();
    },
    120_000 // 2 minute timeout per fixture - real model calls are slow
  );
});
