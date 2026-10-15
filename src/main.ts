import * as fs from 'fs';
import * as path from 'path';
import * as dotenv from 'dotenv';
import ora, { type Ora } from 'ora';

import { CodeReviewOrchestrator } from './orchestrator.js';
import { ReportGenerator, formatError, isReviewError } from './utils/index.js';
import { buildMermaidTrace } from './utils/execution-trace.js';
import type { TraceEvent } from './utils/execution-trace.js';

// Load environment variables
dotenv.config();

/**
 * Wrap markdown/html reports with an appended "Agent Execution Trace" section
 * containing a Mermaid.js sequence diagram (Standout: Agent Execution Traces).
 */
function appendMermaidToMarkdown(markdown: string, trace: TraceEvent[]): string {
  const diagram = buildMermaidTrace(trace);
  return `${markdown}\n\n## 🧭 Agent Execution Trace\n\n\`\`\`mermaid\n${diagram}\n\`\`\`\n`;
}

function appendMermaidToHtml(html: string, trace: TraceEvent[]): string {
  const diagram = buildMermaidTrace(trace);
  const section = `
  <h2>🧭 Agent Execution Trace</h2>
  <pre class="mermaid">
${diagram}
  </pre>
  <script type="module">
    import mermaid from 'https://cdn.jsdelivr.net/npm/mermaid@10/dist/mermaid.esm.min.mjs';
    mermaid.initialize({ startOnLoad: true });
  </script>
</body>
</html>`;
  return html.replace(/<\/body>\s*<\/html>\s*$/i, section);
}

/**
 * Standout feature: Interactive CLI.
 * Drives an ora spinner from orchestrator progress events so the user can
 * see which subagent is currently running instead of staring at a blank screen.
 */
function createProgressReporter(spinner: Ora) {
  const started = new Set<string>();
  const stopped = new Set<string>();

  return (event: TraceEvent) => {
    if (event.type === 'subagent_start') {
      started.add(event.actor);
      spinner.text = `Running subagents… (${stopped.size}/${started.size} complete) — started ${event.actor}`;
    } else if (event.type === 'subagent_stop') {
      stopped.add(event.actor);
      spinner.text = `Running subagents… (${stopped.size}/${started.size} complete) — finished ${event.actor}`;
    } else if (event.type === 'tool_use' && event.tool) {
      spinner.text = `Orchestrator: ${event.tool}${event.detail ? ` (${event.detail})` : ''}`;
    }
  };
}

function printUsageAndExit(message: string): never {
  console.error(`❌ ${message}`);
  console.error('\nUsage: npm run dev -- <owner> <repo> <pr-number>');
  console.error('Example: npm run dev -- octocat Hello-World 1');
  process.exit(1);
}

/**
 * Main entry point for the Claude Multi-Agent Code Review System
 * Usage: npm run dev -- <owner> <repo> <pr-number>
 */
async function main() {
  const [owner, repo, prStr] = process.argv.slice(2);

  // --- Validate command line arguments ---
  if (!owner || !repo || !prStr) {
    printUsageAndExit('Missing required arguments: owner, repo, and pr-number are all required.');
  }

  const prNumber = parseInt(prStr, 10);
  if (Number.isNaN(prNumber) || prNumber <= 0 || String(prNumber) !== prStr.trim()) {
    printUsageAndExit(`Invalid PR number "${prStr}". It must be a positive integer.`);
  }

  // --- Validate authentication (choose ONE method) ---
  const hasAnthropicAPI = !!process.env.ANTHROPIC_API_KEY;
  const hasAWSCredentials = !!(
    process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY
  );

  if (!hasAnthropicAPI && !hasAWSCredentials) {
    console.error('❌ Authentication required. Set one of:');
    console.error('   - ANTHROPIC_API_KEY, or');
    console.error('   - AWS_ACCESS_KEY_ID + AWS_SECRET_ACCESS_KEY (+ AWS_REGION) for Bedrock');
    process.exit(1);
  }

  if (hasAWSCredentials && !hasAnthropicAPI) {
    if (!process.env.AWS_REGION) {
      console.error('❌ AWS_REGION is required when using AWS Bedrock authentication.');
      process.exit(1);
    }
    console.log('🔐 Using AWS Bedrock authentication');
  } else {
    console.log('🔐 Using Anthropic API authentication');
  }

  if (!process.env.GITHUB_TOKEN) {
    console.warn(
      '⚠️  GITHUB_TOKEN is not set. Public repositories will still work, but you may hit ' +
        'low unauthenticated GitHub API rate limits. Set GITHUB_TOKEN for reliable results.'
    );
  }

  // --- Validate ANTHROPIC_MODEL ---
  const model = process.env.ANTHROPIC_MODEL;
  if (!model) {
    console.error('❌ ANTHROPIC_MODEL environment variable is required.');
    console.error('   For Anthropic API:  ANTHROPIC_MODEL=claude-sonnet-4-5-20250929');
    console.error('   For AWS Bedrock:    ANTHROPIC_MODEL=us.anthropic.claude-sonnet-4-5-20250929-v1:0');
    process.exit(1);
  }

  console.log(`\n🔍 Starting code review: ${owner}/${repo} #${prNumber}\n`);

  const spinner = ora('Initializing orchestrator…').start();
  const postComment = process.env.POST_PR_COMMENT === 'true';

  try {
    const orchestrator = new CodeReviewOrchestrator({
      model,
      postComment,
      onProgress: createProgressReporter(spinner)
    });

    const report = await orchestrator.reviewPullRequest(owner, repo, prNumber);
    const trace = orchestrator.getExecutionTrace();

    spinner.succeed(
      `Review complete — overall score ${report.summary.overallScore}/100, ` +
        `${report.summary.criticalIssues} critical issue(s) across ${report.summary.totalFiles} file(s).`
    );

    // --- Generate Reports (JSON, Markdown, HTML) ---
    const reportGenerator = new ReportGenerator();
    const reportsDir = path.join(process.cwd(), 'reports');
    fs.mkdirSync(reportsDir, { recursive: true });

    const baseName = `${owner}_${repo}_${prNumber}`;

    const json = reportGenerator.generateJSONReport(report);
    const markdown = appendMermaidToMarkdown(reportGenerator.generateMarkdownReport(report), trace);
    const html = appendMermaidToHtml(reportGenerator.generateHTMLReport(report), trace);

    const jsonPath = path.join(reportsDir, `${baseName}.json`);
    const mdPath = path.join(reportsDir, `${baseName}.md`);
    const htmlPath = path.join(reportsDir, `${baseName}.html`);

    fs.writeFileSync(jsonPath, json, 'utf-8');
    fs.writeFileSync(mdPath, markdown, 'utf-8');
    fs.writeFileSync(htmlPath, html, 'utf-8');

    console.log('\n✅ Reports saved:');
    console.log(`   - ${jsonPath}`);
    console.log(`   - ${mdPath}`);
    console.log(`   - ${htmlPath}`);

    if (postComment) {
      console.log('\n💬 Summary comment was posted to the pull request (POST_PR_COMMENT=true).');
    }
  } catch (error) {
    spinner.fail('Code review failed');

    if (isReviewError(error)) {
      console.error(`\n❌ [${error.code}] ${error.message}`);
      if (error.metadata) {
        console.error('   Details:', JSON.stringify(error.metadata, null, 2));
      }
    } else {
      console.error(`\n❌ Unexpected error: ${formatError(error)}`);
    }
    process.exitCode = 1;
  }
}

main();
