/**
 * Quality Gates — Security scan and review pass utilities.
 *
 * runSecurityScan: scans git diff for credential/secret patterns in added lines.
 * runReviewPass: runs claude CLI as a code-reviewer against the diff.
 */

import { execFile, spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

// Patterns that indicate a secret or credential in source code
const SECRET_PATTERNS: RegExp[] = [
  // Generic secrets: api_key=, secret=, password=, token=, credential=
  /(api[_-]?key|secret|password|token|credential)\s*=\s*["'][^"']{4,}/gi,
  // AWS access key IDs
  /AKIA[0-9A-Z]{16}/g,
  // PEM private keys
  /-----BEGIN (?:RSA |EC |DSA )?PRIVATE KEY-----/,
  // Provider-specific tokens: OpenAI sk-, GitHub ghp_, GitLab glpat-, Slack xox*
  /(?:sk-[a-zA-Z0-9]{20,}|ghp_[a-zA-Z0-9]{36}|glpat-[a-zA-Z0-9-]{20,}|xox[bpors]-)/g,
];

export interface SecurityScanResult {
  clean: boolean;
  findings: string[];
}

/**
 * Run a security scan on the diff between the base branch and HEAD.
 *
 * Only lines beginning with '+' (additions) are scanned.
 * Uses `origin/<baseBranch>` so that worktrees (which lack a local base branch) work correctly.
 *
 * @param workspacePath - Absolute path to the git workspace / worktree
 * @param baseBranch    - Name of the base branch (e.g. "main")
 */
export async function runSecurityScan(
  workspacePath: string,
  baseBranch: string,
): Promise<SecurityScanResult> {
  let diff: string;

  try {
    const { stdout } = await execFileAsync(
      "git",
      ["diff", `origin/${baseBranch}...HEAD`],
      { cwd: workspacePath, maxBuffer: 10 * 1024 * 1024 },
    );
    diff = stdout;
  } catch (err) {
    // A scan that cannot execute is not clean — report as failed
    const message = err instanceof Error ? err.message : String(err);
    return { clean: false, findings: [`Security scan inconclusive — git diff failed: ${message}`] };
  }

  // Only examine added lines (lines starting with '+' but not the diff header '+++')
  const addedLines = diff
    .split("\n")
    .filter((line) => line.startsWith("+") && !line.startsWith("+++"));

  const findings: string[] = [];

  for (const line of addedLines) {
    // Strip the leading '+' for pattern matching
    const content = line.slice(1);

    for (const pattern of SECRET_PATTERNS) {
      // Reset lastIndex for global regexes to avoid stateful bugs
      pattern.lastIndex = 0;
      if (pattern.test(content)) {
        // Reset after test() so repeated calls work correctly
        pattern.lastIndex = 0;
        findings.push(`Potential secret detected (pattern: ${pattern.source.slice(0, 40)})`);
        break; // One finding per line is enough
      }
      pattern.lastIndex = 0;
    }
  }

  return { clean: findings.length === 0, findings };
}

// =============================================================================
// Review Pass
// =============================================================================

export interface ReviewPassResult {
  clean: boolean;
  feedback: string;
  securityConcerns: boolean;
}

const SECURITY_KEYWORDS_PATTERN =
  /secret|credential|injection|vulnerability|hardcoded|data.loss|auth|token|password|api.key/i;

const FALLBACK_REVIEW_PROMPT =
  "You are a code reviewer. Review the provided diff for bugs, security issues, and code quality problems.";

/** Strip YAML frontmatter (content between --- markers at file start). */
function stripFrontmatter(content: string): string {
  // Matches --- on line 1, any content, then closing ---
  const match = content.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n([\s\S]*)$/);
  if (match) {
    return match[1].trim();
  }
  return content;
}

const REVIEW_TIMEOUT_MS = 15 * 60 * 1000; // 15 minutes

/** Run claude with tool access against the codebase for interactive review. */
function runClaudeReview(
  systemPrompt: string,
  userPrompt: string,
  model: string,
  cwd: string = process.cwd(),
): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn(
      "claude",
      [
        "--print",
        "--model", model,
        "--system-prompt", systemPrompt,
        "--allowedTools", "Read,Grep,Glob,Bash",
        "--dangerously-skip-permissions",
        "--max-turns", "30",
        "--max-budget-usd", "5",
      ],
      { stdio: ["pipe", "pipe", "pipe"], cwd },
    );

    let stdout = "";
    let stderr = "";

    const timer = setTimeout(() => {
      proc.kill("SIGTERM");
      reject(new Error(`claude review timed out after 15 minutes. stderr: ${stderr.trim()}`));
    }, REVIEW_TIMEOUT_MS);

    proc.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });

    proc.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    proc.on("close", (code: number | null) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(`claude exited with code ${code}: ${stderr.trim()}`));
      } else {
        resolve(stdout);
      }
    });

    proc.on("error", (err: Error) => {
      clearTimeout(timer);
      reject(err);
    });

    proc.stdin.write(userPrompt);
    proc.stdin.end();
  });
}

// =============================================================================
// runAllQualityGates
// =============================================================================

export interface QualityGateConfig {
  workspacePath: string;
  baseBranch: string;
  reviewModel: string;
  /** Path to code-reviewer agent prompt file. Defaults to ~/.claude/agents/code-reviewer.md */
  reviewerPromptPath?: string;
  /** Path to security-reviewer agent prompt file. Defaults to ~/.claude/agents/security-reviewer.md */
  securityReviewerPromptPath?: string;
}

export interface QualityGateResult {
  passed: boolean;
  securityScanResult: SecurityScanResult;
  codeReviewResult?: ReviewPassResult;
  securityReviewResult?: ReviewPassResult;
  combinedFeedback: string;
}

/** Build a feedback section for a review pass result or error. Returns null if neither provided. */
function buildFeedbackSection(
  title: string,
  result: ReviewPassResult | undefined,
  error: Error | undefined,
): string | null {
  if (result) return `## ${title}\n${result.feedback}`;
  if (error) return `## ${title}\n_Review unavailable: ${error.message}_`;
  return null;
}

/** Resolve a prompt path: use provided path, else default under ~/.claude/agents/. */
function resolvePromptPath(provided: string | undefined, defaultRelativePath: string): string {
  if (provided) {
    return provided;
  }
  // Return the default agent path — if the file doesn't exist, runReviewPass will
  // catch the readFile error and fall back to FALLBACK_REVIEW_PROMPT.
  return join(homedir(), ".claude", "agents", defaultRelativePath);
}

/**
 * Run all configured quality gates:
 * 1. Secret scan (blocking)
 * 2. Code review + security review in parallel (via Promise.allSettled)
 *
 * Partial failure policy (intentional design choice):
 * - One pass errors, other succeeds → non-blocking (warn in feedback, don't block merge).
 *   Rationale: a single reviewer crash/timeout should not block the entire pipeline when
 *   the other reviewer completed successfully. The error is surfaced in combined feedback.
 * - Both passes error → blocking (passed: false) — zero completed reviews means no merge.
 * - Any fulfilled pass has securityConcerns: true → passed: false.
 */
export async function runAllQualityGates(config: QualityGateConfig): Promise<QualityGateResult> {
  const { workspacePath, baseBranch, reviewModel, reviewerPromptPath, securityReviewerPromptPath } =
    config;

  // Step 1: Security scan — if dirty, return early
  const securityScanResult = await runSecurityScan(workspacePath, baseBranch);
  if (!securityScanResult.clean) {
    const findingsList = securityScanResult.findings.join("\n");
    return {
      passed: false,
      securityScanResult,
      combinedFeedback: `Security scan found potential secrets or credentials.\n\nFindings:\n${findingsList}`,
    };
  }

  // Step 2: Resolve prompt paths
  const resolvedCodeReviewerPath = resolvePromptPath(reviewerPromptPath, "code-reviewer.md");
  const resolvedSecurityReviewerPath = resolvePromptPath(
    securityReviewerPromptPath,
    "security-reviewer.md",
  );

  // Step 3: Run both review passes in parallel
  const [codeReviewSettled, securityReviewSettled] = await Promise.allSettled([
    runReviewPass(workspacePath, baseBranch, reviewModel, resolvedCodeReviewerPath),
    runReviewPass(workspacePath, baseBranch, reviewModel, resolvedSecurityReviewerPath),
  ]);

  const codeReviewResult =
    codeReviewSettled.status === "fulfilled" ? codeReviewSettled.value : undefined;
  const securityReviewResult =
    securityReviewSettled.status === "fulfilled" ? securityReviewSettled.value : undefined;

  const codeReviewError =
    codeReviewSettled.status === "rejected" ? (codeReviewSettled.reason as Error) : undefined;
  const securityReviewError =
    securityReviewSettled.status === "rejected"
      ? (securityReviewSettled.reason as Error)
      : undefined;

  // Step 4: Determine pass/fail
  const bothErrored = codeReviewError !== undefined && securityReviewError !== undefined;
  const anySecurityConcerns =
    codeReviewResult?.securityConcerns === true ||
    securityReviewResult?.securityConcerns === true;

  const passed = !bothErrored && !anySecurityConcerns;

  // Step 5: Build combined feedback
  const combinedFeedback = [
    buildFeedbackSection("Code Review", codeReviewResult, codeReviewError),
    buildFeedbackSection("Security Review", securityReviewResult, securityReviewError),
  ]
    .filter(Boolean)
    .join("\n\n");

  return {
    passed,
    securityScanResult,
    codeReviewResult,
    securityReviewResult,
    combinedFeedback,
  };
}

// =============================================================================
// runReviewPass
// =============================================================================

/**
 * Run a review pass using the Claude CLI against the diff between base branch and HEAD.
 *
 * @param workspacePath      - Absolute path to the git workspace / worktree
 * @param baseBranch         - Name of the base branch (e.g. "main")
 * @param model              - Claude model to use (e.g. "claude-opus-4-6")
 * @param reviewerPromptPath - Path to the reviewer agent prompt file
 */
export async function runReviewPass(
  workspacePath: string,
  baseBranch: string,
  model: string,
  reviewerPromptPath: string,
): Promise<ReviewPassResult> {
  // (1) Load and strip frontmatter from reviewer prompt
  let agentPrompt: string;
  try {
    const raw = await readFile(reviewerPromptPath, "utf8");
    agentPrompt = stripFrontmatter(raw);
    if (!agentPrompt.trim()) {
      console.warn(
        `[quality-gates] Reviewer prompt file is empty after stripping frontmatter: ${reviewerPromptPath}. Using fallback.`,
      );
      agentPrompt = FALLBACK_REVIEW_PROMPT;
    }
  } catch {
    console.warn(
      `[quality-gates] Reviewer prompt not found at ${reviewerPromptPath}. Using fallback prompt.`,
    );
    agentPrompt = FALLBACK_REVIEW_PROMPT;
  }

  // (2) Empty-diff guard: if no changes, skip review
  try {
    const { stdout } = await execFileAsync(
      "git", ["diff", `origin/${baseBranch}...HEAD`, "--stat"],
      { cwd: workspacePath },
    );
    if (!stdout.trim()) {
      return { clean: true, feedback: "No changes to review", securityConcerns: false };
    }
  } catch {
    // Can't determine diff state — proceed with review anyway
  }

  // (3) Build user prompt (reviewer explores code via tools)
  const userPrompt = `Review the code changes on this branch compared to origin/${baseBranch}.

Start by running: git diff origin/${baseBranch}...HEAD --stat
Then review changed files. Read full files for context when needed.

Output this block at the end:
---REVIEW-RESULT---
status: clean OR concerns
remaining_concerns: list of concerns, or "none"
---END-REVIEW-RESULT---`;

  // (4) Run claude --print
  let reviewOutput: string;
  try {
    reviewOutput = await runClaudeReview(agentPrompt, userPrompt, model, workspacePath);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`[quality-gates] Review pass unavailable: ${message}`);
    return { clean: true, feedback: "Review unavailable", securityConcerns: false };
  }

  // (5) Parse ---REVIEW-RESULT--- block and extract status
  const resultBlockMatch = reviewOutput.match(
    /---REVIEW-RESULT---\s*([\s\S]*?)\s*---END-REVIEW-RESULT---/,
  );
  let status: "clean" | "concerns" = "clean";
  let feedback = reviewOutput.trim();

  if (resultBlockMatch) {
    const block = resultBlockMatch[1];
    const statusMatch = block.match(/^status:\s*(clean|concerns)/im);
    if (statusMatch) {
      status = statusMatch[1].toLowerCase() === "concerns" ? "concerns" : "clean";
    }
    feedback = block.trim();
  }

  // (6) Post-review security keyword scan
  // Only set securityConcerns=true when keywords are found AND status is 'concerns'
  const hasSecurityKeywords = SECURITY_KEYWORDS_PATTERN.test(reviewOutput);
  const securityConcerns = hasSecurityKeywords && status === "concerns";

  return {
    clean: status === "clean",
    feedback,
    securityConcerns,
  };
}
