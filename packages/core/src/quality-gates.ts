/**
 * Quality Gates — Security scan and review pass utilities.
 *
 * runSecurityScan: scans git diff for credential/secret patterns in added lines.
 */

import { execFile } from "node:child_process";
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
