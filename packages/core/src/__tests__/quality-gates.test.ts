/**
 * Tests for quality-gates.ts — runSecurityScan and runReviewPass.
 *
 * Mocks:
 *  - node:child_process (execFile via promisify, spawn for claude CLI)
 *  - node:fs/promises  (readFile for reviewer prompt)
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { EventEmitter } from "node:events";

// Hoist mocks before module-under-test is loaded
vi.mock("node:child_process", () => ({
  execFile: vi.fn(),
  spawn: vi.fn(),
}));

vi.mock("node:fs/promises", () => ({
  readFile: vi.fn(),
}));

import { execFile, spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { runSecurityScan, runReviewPass } from "../quality-gates.js";

// =============================================================================
// Test helpers
// =============================================================================

/**
 * Make execFile call its promisify callback with { stdout, stderr }.
 * promisify wraps execFile as a standard error-first callback, so the first
 * non-error argument is the resolved value. Passing the object directly means
 * `const { stdout } = await execFileAsync(...)` gets the right value.
 */
function mockGitDiff(stdout: string): void {
  vi.mocked(execFile).mockImplementation((...args: unknown[]) => {
    const callback = args[args.length - 1] as (
      err: Error | null,
      result: { stdout: string; stderr: string },
    ) => void;
    callback(null, { stdout, stderr: "" });
    return {} as ReturnType<typeof execFile>;
  });
}

function mockGitDiffError(message: string): void {
  vi.mocked(execFile).mockImplementation((...args: unknown[]) => {
    const callback = args[args.length - 1] as (err: Error) => void;
    callback(new Error(message));
    return {} as ReturnType<typeof execFile>;
  });
}

interface MockProc {
  stdout: EventEmitter;
  stderr: EventEmitter;
  stdin: { write: ReturnType<typeof vi.fn>; end: ReturnType<typeof vi.fn> };
  on: (event: string, handler: (...args: unknown[]) => void) => MockProc;
  emit: (event: string, ...args: unknown[]) => boolean;
}

/**
 * Create a mock child process that emits stdout data and closes.
 * Uses setImmediate so all event listeners are attached before events fire.
 */
function createMockProc(output: string, exitCode = 0): MockProc {
  const proc = new EventEmitter() as unknown as MockProc;
  (proc as unknown as EventEmitter & { stdout: EventEmitter; stderr: EventEmitter }).stdout =
    new EventEmitter();
  (proc as unknown as EventEmitter & { stdout: EventEmitter; stderr: EventEmitter }).stderr =
    new EventEmitter();
  proc.stdin = { write: vi.fn(), end: vi.fn() };

  setImmediate(() => {
    const em = proc as unknown as EventEmitter & {
      stdout: EventEmitter;
      stderr: EventEmitter;
    };
    if (exitCode !== 0) {
      em.stderr.emit("data", Buffer.from("error output"));
    } else {
      em.stdout.emit("data", Buffer.from(output));
    }
    em.emit("close", exitCode);
  });

  return proc;
}

/** Create a mock process that emits an error event (e.g. spawn ENOENT). */
function createMockProcError(message: string): MockProc {
  const proc = new EventEmitter() as unknown as MockProc;
  (proc as unknown as EventEmitter & { stdout: EventEmitter; stderr: EventEmitter }).stdout =
    new EventEmitter();
  (proc as unknown as EventEmitter & { stdout: EventEmitter; stderr: EventEmitter }).stderr =
    new EventEmitter();
  proc.stdin = { write: vi.fn(), end: vi.fn() };

  setImmediate(() => {
    (proc as unknown as EventEmitter).emit("error", new Error(message));
  });

  return proc;
}

/** Build a REVIEW-RESULT block string. */
function makeReviewOutput(
  status: "clean" | "concerns",
  remainingConcerns = "none",
  prefix = "Some reviewer feedback.",
): string {
  return `${prefix}
---REVIEW-RESULT---
status: ${status}
remaining_concerns: ${remainingConcerns}
---END-REVIEW-RESULT---`;
}

const MOCK_REVIEWER_PROMPT = "You are a strict code reviewer.";

// =============================================================================
// runSecurityScan
// =============================================================================

describe("runSecurityScan", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("returns clean when diff has no secrets", async () => {
    mockGitDiff("+const x = 1;\n+console.log(x);\n");
    const result = await runSecurityScan("/tmp/ws", "main");
    expect(result.clean).toBe(true);
    expect(result.findings).toHaveLength(0);
  });

  it("returns clean for an empty diff", async () => {
    mockGitDiff("");
    const result = await runSecurityScan("/tmp/ws", "main");
    expect(result.clean).toBe(true);
    expect(result.findings).toHaveLength(0);
  });

  it("flags a hardcoded password in added lines", async () => {
    mockGitDiff('+const pw = password="hunter2";\n');
    const result = await runSecurityScan("/tmp/ws", "main");
    expect(result.clean).toBe(false);
    expect(result.findings.length).toBeGreaterThan(0);
    expect(result.findings[0]).toContain("Potential secret detected");
  });

  it("flags a hardcoded secret value", async () => {
    mockGitDiff('+const s = secret="super_secret_123";\n');
    const result = await runSecurityScan("/tmp/ws", "main");
    expect(result.clean).toBe(false);
  });

  it("ignores removed lines (starting with -)", async () => {
    mockGitDiff('-const pw = password="hunter2";\n');
    const result = await runSecurityScan("/tmp/ws", "main");
    expect(result.clean).toBe(true);
  });

  it("ignores diff header lines (starting with +++)", async () => {
    mockGitDiff("+++ b/src/config.ts\n+const x = 1;\n");
    const result = await runSecurityScan("/tmp/ws", "main");
    expect(result.clean).toBe(true);
  });

  it("detects AWS access key IDs", async () => {
    mockGitDiff("+const awsKey = 'AKIAIOSFODNN7EXAMPLE';\n");
    const result = await runSecurityScan("/tmp/ws", "main");
    expect(result.clean).toBe(false);
  });

  it("returns clean with error note when git diff fails", async () => {
    mockGitDiffError("not a git repository");
    const result = await runSecurityScan("/tmp/ws", "main");
    expect(result.clean).toBe(true);
    expect(result.findings[0]).toContain("git diff failed");
  });

  it("detects PEM private key headers", async () => {
    mockGitDiff("+-----BEGIN RSA PRIVATE KEY-----\n");
    const result = await runSecurityScan("/tmp/ws", "main");
    expect(result.clean).toBe(false);
    expect(result.findings[0]).toContain("Potential secret detected");
  });

  it("detects EC private key headers", async () => {
    mockGitDiff("+-----BEGIN EC PRIVATE KEY-----\n");
    const result = await runSecurityScan("/tmp/ws", "main");
    expect(result.clean).toBe(false);
  });

  it("detects generic private key headers", async () => {
    mockGitDiff("+-----BEGIN PRIVATE KEY-----\n");
    const result = await runSecurityScan("/tmp/ws", "main");
    expect(result.clean).toBe(false);
  });

  it("detects OpenAI sk- tokens", async () => {
    mockGitDiff("+const openaiKey = 'sk-abcdefghijklmnopqrstuvwxyz123456789012345';\n");
    const result = await runSecurityScan("/tmp/ws", "main");
    expect(result.clean).toBe(false);
    expect(result.findings[0]).toContain("Potential secret detected");
  });

  it("detects GitHub ghp_ tokens", async () => {
    mockGitDiff("+const token = 'ghp_abcdefghijklmnopqrstuvwxyz123456789012';\n"); // gitleaks:allow
    const result = await runSecurityScan("/tmp/ws", "main");
    expect(result.clean).toBe(false);
    expect(result.findings[0]).toContain("Potential secret detected");
  });

  it("detects GitLab glpat- tokens", async () => {
    mockGitDiff("+const glToken = 'glpat-abc123def456ghi789jkl0';\n"); // gitleaks:allow
    const result = await runSecurityScan("/tmp/ws", "main");
    expect(result.clean).toBe(false);
    expect(result.findings[0]).toContain("Potential secret detected");
  });

  it("detects Slack xox tokens", async () => {
    mockGitDiff("+const slackToken = 'xoxb-12345-67890-abcdefghijklmnop';\n"); // gitleaks:allow
    const result = await runSecurityScan("/tmp/ws", "main");
    expect(result.clean).toBe(false);
    expect(result.findings[0]).toContain("Potential secret detected");
  });

  it("detects api_key assignments", async () => {
    mockGitDiff('+const api_key = "abc123secretvalue";\n');
    const result = await runSecurityScan("/tmp/ws", "main");
    expect(result.clean).toBe(false);
    expect(result.findings[0]).toContain("Potential secret detected");
  });

  it("does not flag password mentioned in a comment", async () => {
    mockGitDiff("+// Note: never hardcode a password here\n");
    const result = await runSecurityScan("/tmp/ws", "main");
    expect(result.clean).toBe(true);
  });

  it("flags only one finding per line even when multiple patterns match", async () => {
    // Line matches both AKIA pattern and could match api_key pattern
    mockGitDiff("+const key = 'AKIAIOSFODNN7EXAMPLE'; // api_key='AKIAIOSFODNN7EXAMPLE'\n");
    const result = await runSecurityScan("/tmp/ws", "main");
    expect(result.findings).toHaveLength(1);
  });

  it("findings contain enough context to identify the problematic line", async () => {
    mockGitDiff("+const awsKey = 'AKIAIOSFODNN7EXAMPLE';\n");
    const result = await runSecurityScan("/tmp/ws", "main");
    expect(result.findings[0]).toContain("AKIAIOSFODNN7EXAMPLE");
  });
});

// =============================================================================
// runReviewPass
// =============================================================================

describe("runReviewPass", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    // Default: non-empty diff
    mockGitDiff("+const x = 1;\n");
    // Default: readable reviewer prompt
    vi.mocked(readFile).mockResolvedValue(MOCK_REVIEWER_PROMPT as unknown as string);
  });

  // --- Status parsing ---

  it("returns clean=true and securityConcerns=false when status is clean", async () => {
    vi.mocked(spawn).mockReturnValue(createMockProc(makeReviewOutput("clean")) as never);
    const result = await runReviewPass("/tmp/ws", "main", "claude-opus-4-6", "/tmp/reviewer.md");
    expect(result.clean).toBe(true);
    expect(result.securityConcerns).toBe(false);
  });

  it("returns clean=false when status is concerns", async () => {
    vi.mocked(spawn).mockReturnValue(
      createMockProc(makeReviewOutput("concerns", "Logic error on line 10")) as never,
    );
    const result = await runReviewPass("/tmp/ws", "main", "claude-opus-4-6", "/tmp/reviewer.md");
    expect(result.clean).toBe(false);
    expect(result.securityConcerns).toBe(false);
  });

  it("feedback contains the parsed result block content", async () => {
    vi.mocked(spawn).mockReturnValue(
      createMockProc(makeReviewOutput("concerns", "Missing null check on line 42")) as never,
    );
    const result = await runReviewPass("/tmp/ws", "main", "claude-opus-4-6", "/tmp/reviewer.md");
    expect(result.feedback).toContain("Missing null check on line 42");
  });

  // --- Security keyword detection ---

  it("sets securityConcerns=true when keywords present AND status is concerns", async () => {
    const output = makeReviewOutput("concerns", "Possible injection vulnerability detected");
    vi.mocked(spawn).mockReturnValue(createMockProc(output) as never);
    const result = await runReviewPass("/tmp/ws", "main", "claude-opus-4-6", "/tmp/reviewer.md");
    expect(result.clean).toBe(false);
    expect(result.securityConcerns).toBe(true);
  });

  it("does NOT set securityConcerns when keywords present but status is clean", async () => {
    const output = makeReviewOutput("clean", "No password or token issues found");
    vi.mocked(spawn).mockReturnValue(createMockProc(output) as never);
    const result = await runReviewPass("/tmp/ws", "main", "claude-opus-4-6", "/tmp/reviewer.md");
    expect(result.clean).toBe(true);
    expect(result.securityConcerns).toBe(false);
  });

  it.each([
    ["secret", "hardcoded secret value"],
    ["credential", "leaked credential in env"],
    ["injection", "SQL injection risk"],
    ["vulnerability", "known vulnerability"],
    ["hardcoded", "hardcoded value"],
    ["data_loss", "risk of data_loss"],
    ["auth", "auth bypass possible"],
    ["token", "expired token not checked"],
    ["password", "password stored in plain text"],
    ["api_key", "api_key exposed in logs"],
  ])("securityConcerns=true for keyword '%s' when status is concerns", async (keyword, concern) => {
    const output = makeReviewOutput("concerns", concern);
    vi.mocked(spawn).mockReturnValue(createMockProc(output) as never);
    const result = await runReviewPass("/tmp/ws", "main", "claude-opus-4-6", "/tmp/reviewer.md");
    expect(result.securityConcerns).toBe(true);
  });

  // --- Reviewer prompt handling ---

  it("strips YAML frontmatter from reviewer prompt before passing to claude", async () => {
    vi.mocked(readFile).mockResolvedValue(
      "---\nname: reviewer\nmodel: opus\n---\nYou are a reviewer.\n" as unknown as string,
    );
    const proc = createMockProc(makeReviewOutput("clean"));
    vi.mocked(spawn).mockReturnValue(proc as never);

    await runReviewPass("/tmp/ws", "main", "claude-opus-4-6", "/tmp/reviewer.md");

    const [, spawnArgs] = vi.mocked(spawn).mock.calls[0]!;
    const args = spawnArgs as string[];
    const idx = args.indexOf("--system-prompt");
    const systemPrompt = idx >= 0 ? args[idx + 1] : "";
    expect(systemPrompt).not.toContain("---");
    expect(systemPrompt).toContain("You are a reviewer.");
  });

  it("falls back to fallback prompt when reviewer prompt file is missing", async () => {
    const notFoundErr = Object.assign(new Error("ENOENT: no such file"), { code: "ENOENT" });
    vi.mocked(readFile).mockRejectedValue(notFoundErr);
    const proc = createMockProc(makeReviewOutput("clean"));
    vi.mocked(spawn).mockReturnValue(proc as never);

    const result = await runReviewPass("/tmp/ws", "main", "claude-opus-4-6", "/tmp/missing.md");

    expect(result.clean).toBe(true);
    const [, spawnArgs] = vi.mocked(spawn).mock.calls[0]!;
    const args = spawnArgs as string[];
    const idx = args.indexOf("--system-prompt");
    const systemPrompt = idx >= 0 ? args[idx + 1] : "";
    expect(systemPrompt).toContain("code reviewer");
  });

  // --- Diff size handling ---

  it("returns clean when diff is empty", async () => {
    mockGitDiff("");
    vi.mocked(spawn).mockReturnValue(createMockProc(makeReviewOutput("clean")) as never);
    const result = await runReviewPass("/tmp/ws", "main", "claude-opus-4-6", "/tmp/reviewer.md");
    expect(result.clean).toBe(true);
  });

  it("truncates diff larger than 100K characters", async () => {
    const hugeDiff = "+" + "x".repeat(200_000);
    mockGitDiff(hugeDiff);
    const proc = createMockProc(makeReviewOutput("clean"));
    vi.mocked(spawn).mockReturnValue(proc as never);

    await runReviewPass("/tmp/ws", "main", "claude-opus-4-6", "/tmp/reviewer.md");

    const writtenPrompt = (proc.stdin.write as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as string;
    expect(writtenPrompt).toContain("[diff truncated at 100K characters]");
  });

  // --- Error / timeout handling ---

  it("returns clean with 'Review unavailable' when git diff fails", async () => {
    mockGitDiffError("not a git repository");
    const result = await runReviewPass("/tmp/ws", "main", "claude-opus-4-6", "/tmp/reviewer.md");
    expect(result.clean).toBe(true);
    expect(result.feedback).toBe("Review unavailable");
    expect(result.securityConcerns).toBe(false);
  });

  it("returns clean when claude exits with non-zero code", async () => {
    vi.mocked(spawn).mockReturnValue(createMockProc("", 1) as never);
    const result = await runReviewPass("/tmp/ws", "main", "claude-opus-4-6", "/tmp/reviewer.md");
    expect(result.clean).toBe(true);
    expect(result.feedback).toBe("Review unavailable");
    expect(result.securityConcerns).toBe(false);
  });

  it("returns clean when claude spawn emits an error event", async () => {
    vi.mocked(spawn).mockReturnValue(createMockProcError("spawn ENOENT") as never);
    const result = await runReviewPass("/tmp/ws", "main", "claude-opus-4-6", "/tmp/reviewer.md");
    expect(result.clean).toBe(true);
    expect(result.feedback).toBe("Review unavailable");
    expect(result.securityConcerns).toBe(false);
  });

  it("returns clean when claude output has no REVIEW-RESULT block", async () => {
    vi.mocked(spawn).mockReturnValue(
      createMockProc("Some free-form output with no structured block.") as never,
    );
    const result = await runReviewPass("/tmp/ws", "main", "claude-opus-4-6", "/tmp/reviewer.md");
    // No block → status defaults to clean
    expect(result.clean).toBe(true);
  });
});
