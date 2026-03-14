/**
 * Quality Gates — Security scan and review pass utilities.
 *
 * runSecurityScan: scans git diff for credential/secret patterns in added lines.
 * runReviewPass: runs claude CLI as a code-reviewer against the diff.
 */

import { execFile, spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
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
      { cwd: workspacePath },
    );
    diff = stdout;
  } catch (err) {
    // If git command fails (e.g. no commits yet), treat as clean
    const message = err instanceof Error ? err.message : String(err);
    return { clean: true, findings: [`git diff failed: ${message}`] };
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
        findings.push(`Potential secret detected: ${line.trim()}`);
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

const MAX_DIFF_CHARS = 100_000;

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

/** Run claude --print with the given system prompt and user prompt piped via stdin. */
function runClaudeReview(
  systemPrompt: string,
  userPrompt: string,
  model: string,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn(
      "claude",
      ["--print", "--model", model, "--system-prompt", systemPrompt],
      { stdio: ["pipe", "pipe", "pipe"] },
    );

    let stdout = "";
    let stderr = "";

    proc.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });

    proc.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    proc.on("close", (code: number | null) => {
      if (code !== 0) {
        reject(new Error(`claude exited with code ${code}: ${stderr.trim()}`));
      } else {
        resolve(stdout);
      }
    });

    proc.on("error", (err: Error) => {
      reject(err);
    });

    proc.stdin.write(userPrompt);
    proc.stdin.end();
  });
}

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

  // Get diff from git
  let diffContent: string;
  try {
    const { stdout } = await execFileAsync("git", ["diff", `origin/${baseBranch}...HEAD`], {
      cwd: workspacePath,
    });
    diffContent = stdout;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`[quality-gates] Review pass unavailable: git diff failed: ${message}`);
    return { clean: true, feedback: "Review unavailable", securityConcerns: false };
  }

  // Truncate diffs > 100K chars
  if (diffContent.length > MAX_DIFF_CHARS) {
    diffContent =
      diffContent.slice(0, MAX_DIFF_CHARS) + "\n... [diff truncated at 100K characters]";
  }

  // (2) Build user prompt
  const userPrompt = `Review the code changes in this diff.

<diff>
${diffContent}
</diff>

Output this block at the end:
---REVIEW-RESULT---
status: clean OR concerns
remaining_concerns: list of concerns, or "none"
---END-REVIEW-RESULT---`;

  // (3) Run claude --print
  let reviewOutput: string;
  try {
    reviewOutput = await runClaudeReview(agentPrompt, userPrompt, model);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`[quality-gates] Review pass unavailable: ${message}`);
    return { clean: true, feedback: "Review unavailable", securityConcerns: false };
  }

  // (4) Parse ---REVIEW-RESULT--- block and extract status
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

  // (5) Post-review security keyword scan
  // Only set securityConcerns=true when keywords are found AND status is 'concerns'
  const hasSecurityKeywords = SECURITY_KEYWORDS_PATTERN.test(reviewOutput);
  const securityConcerns = hasSecurityKeywords && status === "concerns";

  return {
    clean: status === "clean",
    feedback,
    securityConcerns,
  };
}
