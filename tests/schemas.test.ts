import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import {
  CodeQualityResultSchema,
  TestCoverageResultSchema,
  RefactoringSuggestionSchema,
  CodeQualityResultJSONSchema,
  TestCoverageResultJSONSchema,
  RefactoringSuggestionJSONSchema
} from '../src/types/analysis-results.js';
import { ReviewReportSchema, ReviewReportJSONSchema } from '../src/types/report-types.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const validCodeQuality = {
  file: 'src/payment.ts',
  issues: [
    {
      line: 42,
      severity: 'high' as const,
      category: 'security' as const,
      description: 'User input concatenated directly into SQL query',
      suggestion: 'Use a parameterized query instead of string concatenation'
    }
  ],
  overallScore: 72,
  summary: 'One high severity SQL injection risk found; otherwise reasonable structure.'
};

const validTestCoverage = {
  file: 'src/payment.ts',
  hasTests: true,
  testFiles: ['src/payment.test.ts'],
  untestedPaths: [
    {
      type: 'branch' as const,
      location: 'processPayment() error branch',
      priority: 'high' as const,
      reasoning: 'The catch block for network failures has no covering test',
      suggestedTest: 'Test that processPayment() rejects with a PaymentError when the gateway times out'
    }
  ],
  coverageEstimate: 65,
  summary: 'Core happy path is tested; error handling branch is not.'
};

const validRefactoring = {
  file: 'src/payment.ts',
  suggestions: [
    {
      type: 'extract-function' as const,
      location: 'processPayment()',
      impact: 'medium' as const,
      description: 'Extract validation logic into its own function',
      before: 'function processPayment(input) { if (!input.amount) throw ...; ... }',
      after: 'function validatePaymentInput(input) { ... } function processPayment(input) { validatePaymentInput(input); ... }',
      benefits: 'Improves readability and allows validation to be unit tested independently'
    }
  ],
  summary: 'One extract-function opportunity to improve separation of concerns.'
};

function buildValidReviewReport() {
  return {
    pullRequest: { owner: 'octocat', repo: 'Hello-World', number: 1 },
    fileReviews: [
      {
        file: 'src/payment.ts',
        codeQuality: validCodeQuality,
        testCoverage: validTestCoverage,
        refactorings: validRefactoring
      }
    ],
    summary: {
      totalFiles: 1,
      overallScore: 72,
      criticalIssues: 0,
      highPriorityTests: 1,
      refactoringOpportunities: 1
    },
    recommendations: [
      {
        priority: 'high' as const,
        category: 'security',
        description: 'Fix SQL injection risk in payment processing',
        files: ['src/payment.ts']
      }
    ],
    metadata: {
      analyzedAt: '2025-01-15T10:30:00.000Z',
      duration: 15420,
      agentVersions: {
        'code-quality-analyzer': '1.0.0',
        'test-coverage-analyzer': '1.0.0',
        'refactoring-suggester': '1.0.0'
      }
    }
  };
}

// ---------------------------------------------------------------------------
// CodeQualityResultSchema
// ---------------------------------------------------------------------------

describe('CodeQualityResultSchema', () => {
  it('accepts valid data', () => {
    expect(() => CodeQualityResultSchema.parse(validCodeQuality)).not.toThrow();
  });

  it('accepts an empty issues array (no issues found)', () => {
    const data = { ...validCodeQuality, issues: [] };
    expect(() => CodeQualityResultSchema.parse(data)).not.toThrow();
  });

  it('accepts boundary scores of 0 and 100', () => {
    expect(() => CodeQualityResultSchema.parse({ ...validCodeQuality, overallScore: 0 })).not.toThrow();
    expect(() => CodeQualityResultSchema.parse({ ...validCodeQuality, overallScore: 100 })).not.toThrow();
  });

  it('rejects a score above 100', () => {
    const data = { ...validCodeQuality, overallScore: 101 };
    expect(() => CodeQualityResultSchema.parse(data)).toThrow(z.ZodError);
  });

  it('rejects a score below 0', () => {
    const data = { ...validCodeQuality, overallScore: -1 };
    expect(() => CodeQualityResultSchema.parse(data)).toThrow(z.ZodError);
  });

  it('rejects an invalid severity enum value', () => {
    const data = {
      ...validCodeQuality,
      issues: [{ ...validCodeQuality.issues[0], severity: 'catastrophic' }]
    };
    expect(() => CodeQualityResultSchema.parse(data)).toThrow(z.ZodError);
  });

  it('rejects missing required fields', () => {
    const { file, ...withoutFile } = validCodeQuality;
    expect(() => CodeQualityResultSchema.parse(withoutFile)).toThrow(z.ZodError);
  });

  it('rejects wrong types (line as string instead of number)', () => {
    const data = {
      ...validCodeQuality,
      issues: [{ ...validCodeQuality.issues[0], line: 'forty-two' }]
    };
    expect(() => CodeQualityResultSchema.parse(data)).toThrow(z.ZodError);
  });
});

// ---------------------------------------------------------------------------
// TestCoverageResultSchema
// ---------------------------------------------------------------------------

describe('TestCoverageResultSchema', () => {
  it('accepts valid data', () => {
    expect(() => TestCoverageResultSchema.parse(validTestCoverage)).not.toThrow();
  });

  it('accepts an empty untestedPaths array and empty testFiles array', () => {
    const data = { ...validTestCoverage, untestedPaths: [], testFiles: [], hasTests: false };
    expect(() => TestCoverageResultSchema.parse(data)).not.toThrow();
  });

  it('accepts boundary coverage estimates of 0 and 100', () => {
    expect(() => TestCoverageResultSchema.parse({ ...validTestCoverage, coverageEstimate: 0 })).not.toThrow();
    expect(() => TestCoverageResultSchema.parse({ ...validTestCoverage, coverageEstimate: 100 })).not.toThrow();
  });

  it('rejects an invalid priority enum value', () => {
    const data = {
      ...validTestCoverage,
      untestedPaths: [{ ...validTestCoverage.untestedPaths[0], priority: 'urgent' }]
    };
    expect(() => TestCoverageResultSchema.parse(data)).toThrow(z.ZodError);
  });

  it('rejects hasTests as a non-boolean', () => {
    const data = { ...validTestCoverage, hasTests: 'yes' };
    expect(() => TestCoverageResultSchema.parse(data)).toThrow(z.ZodError);
  });
});

// ---------------------------------------------------------------------------
// RefactoringSuggestionSchema
// ---------------------------------------------------------------------------

describe('RefactoringSuggestionSchema', () => {
  it('accepts valid data', () => {
    expect(() => RefactoringSuggestionSchema.parse(validRefactoring)).not.toThrow();
  });

  it('accepts an empty suggestions array (already clean file)', () => {
    const data = { ...validRefactoring, suggestions: [] };
    expect(() => RefactoringSuggestionSchema.parse(data)).not.toThrow();
  });

  it('rejects an invalid suggestion type enum value', () => {
    const data = {
      ...validRefactoring,
      suggestions: [{ ...validRefactoring.suggestions[0], type: 'rewrite-everything' }]
    };
    expect(() => RefactoringSuggestionSchema.parse(data)).toThrow(z.ZodError);
  });

  it('rejects an invalid impact enum value', () => {
    const data = {
      ...validRefactoring,
      suggestions: [{ ...validRefactoring.suggestions[0], impact: 'massive' }]
    };
    expect(() => RefactoringSuggestionSchema.parse(data)).toThrow(z.ZodError);
  });
});

// ---------------------------------------------------------------------------
// ReviewReportSchema (aggregate report)
// ---------------------------------------------------------------------------

describe('ReviewReportSchema', () => {
  it('accepts a fully valid review report', () => {
    expect(() => ReviewReportSchema.parse(buildValidReviewReport())).not.toThrow();
  });

  it('accepts an empty fileReviews and recommendations array', () => {
    const report = buildValidReviewReport();
    report.fileReviews = [];
    report.recommendations = [];
    report.summary.totalFiles = 0;
    expect(() => ReviewReportSchema.parse(report)).not.toThrow();
  });

  it('rejects a report missing the pullRequest field', () => {
    const report = buildValidReviewReport() as Record<string, unknown>;
    delete report.pullRequest;
    expect(() => ReviewReportSchema.parse(report)).toThrow(z.ZodError);
  });

  it('rejects a report with a malformed nested codeQuality object', () => {
    const report = buildValidReviewReport();
    // @ts-expect-error - intentionally invalid for test
    report.fileReviews[0].codeQuality.overallScore = 'not-a-number';
    expect(() => ReviewReportSchema.parse(report)).toThrow(z.ZodError);
  });

  it('rejects an invalid recommendation priority', () => {
    const report = buildValidReviewReport();
    // @ts-expect-error - intentionally invalid for test
    report.recommendations[0].priority = 'someday';
    expect(() => ReviewReportSchema.parse(report)).toThrow(z.ZodError);
  });

  it('uses safeParse to report errors without throwing', () => {
    const result = ReviewReportSchema.safeParse({ not: 'a valid report' });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.length).toBeGreaterThan(0);
    }
  });
});

// ---------------------------------------------------------------------------
// JSON Schema export validation (for SDK structured outputs)
// ---------------------------------------------------------------------------

describe('JSON Schema exports', () => {
  it('CodeQualityResultJSONSchema is a valid-looking JSON schema object', () => {
    expect(CodeQualityResultJSONSchema).toBeTypeOf('object');
    expect(CodeQualityResultJSONSchema.type).toBe('object');
    expect(CodeQualityResultJSONSchema.properties).toBeDefined();
    expect((CodeQualityResultJSONSchema.required as string[]).sort()).toEqual(
      ['file', 'issues', 'overallScore', 'summary'].sort()
    );
  });

  it('TestCoverageResultJSONSchema marks required properties correctly', () => {
    expect(TestCoverageResultJSONSchema.type).toBe('object');
    expect((TestCoverageResultJSONSchema.required as string[]).sort()).toEqual(
      ['file', 'hasTests', 'testFiles', 'untestedPaths', 'coverageEstimate', 'summary'].sort()
    );
  });

  it('RefactoringSuggestionJSONSchema marks required properties correctly', () => {
    expect(RefactoringSuggestionJSONSchema.type).toBe('object');
    expect((RefactoringSuggestionJSONSchema.required as string[]).sort()).toEqual(
      ['file', 'suggestions', 'summary'].sort()
    );
  });

  it('ReviewReportJSONSchema does not contain unresolved $ref pointers (root strategy)', () => {
    const serialized = JSON.stringify(ReviewReportJSONSchema);
    expect(serialized.includes('"$ref"')).toBe(false);
  });

  it('ReviewReportJSONSchema marks all top-level fields as required', () => {
    expect((ReviewReportJSONSchema.required as string[]).sort()).toEqual(
      ['pullRequest', 'fileReviews', 'summary', 'recommendations', 'metadata'].sort()
    );
  });
});
