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
import { runSecurityScan, runReviewPass, runAllQualityGates } from "../quality-gates.js";

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

  it("returns not-clean with error note when git diff fails", async () => {
    mockGitDiffError("not a git repository");
    const result = await runSecurityScan("/tmp/ws", "main");
    expect(result.clean).toBe(false);
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

  it("findings contain enough context to identify the matching pattern", async () => {
    mockGitDiff("+const awsKey = 'AKIAIOSFODNN7EXAMPLE';\n");
    const result = await runSecurityScan("/tmp/ws", "main");
    expect(result.findings[0]).toContain("Potential secret detected");
    expect(result.findings[0]).toContain("pattern:");
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

  // --- Diff size / empty-diff handling ---

  it("returns clean with 'No changes to review' when diff is empty — claude is not called", async () => {
    mockGitDiff("");
    const result = await runReviewPass("/tmp/ws", "main", "claude-opus-4-6", "/tmp/reviewer.md");
    expect(result.clean).toBe(true);
    expect(result.feedback).toBe("No changes to review");
    expect(result.securityConcerns).toBe(false);
    expect(vi.mocked(spawn)).not.toHaveBeenCalled();
  });

  it("user prompt instructs reviewer to run git diff --stat and read files", async () => {
    const proc = createMockProc(makeReviewOutput("clean"));
    vi.mocked(spawn).mockReturnValue(proc as never);

    await runReviewPass("/tmp/ws", "main", "claude-opus-4-6", "/tmp/reviewer.md");

    const writtenPrompt = (proc.stdin.write as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as string;
    expect(writtenPrompt).toContain("git diff origin/main...HEAD --stat");
    expect(writtenPrompt).toContain("Read full files for context when needed");
  });

  // --- Error / timeout handling ---

  it("proceeds with review when git diff --stat fails", async () => {
    mockGitDiffError("not a git repository");
    const proc = createMockProc(makeReviewOutput("clean"));
    vi.mocked(spawn).mockReturnValue(proc as never);
    const result = await runReviewPass("/tmp/ws", "main", "claude-opus-4-6", "/tmp/reviewer.md");
    expect(result.clean).toBe(true);
    expect(vi.mocked(spawn)).toHaveBeenCalled();
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

  // --- Spawn args ---

  it("passes all required flags to claude spawn", async () => {
    const proc = createMockProc(makeReviewOutput("clean"));
    vi.mocked(spawn).mockReturnValue(proc as never);

    await runReviewPass("/tmp/ws", "main", "claude-opus-4-6", "/tmp/reviewer.md");

    const [cmd, spawnArgs] = vi.mocked(spawn).mock.calls[0]!;
    const args = spawnArgs as string[];

    expect(cmd).toBe("claude");
    expect(args).toContain("--print");
    expect(args).toContain("--model");
    expect(args[args.indexOf("--model") + 1]).toBe("claude-opus-4-6");
    expect(args).toContain("--system-prompt");
    expect(args).toContain("--allowedTools");
    expect(args[args.indexOf("--allowedTools") + 1]).toBe("Read,Grep,Glob,Bash");
    expect(args).toContain("--dangerously-skip-permissions");
    expect(args).toContain("--max-turns");
    expect(args[args.indexOf("--max-turns") + 1]).toBe("30");
    expect(args).toContain("--max-budget-usd");
    expect(args[args.indexOf("--max-budget-usd") + 1]).toBe("5");
  });

  it("passes the workspace path as cwd to spawn", async () => {
    const proc = createMockProc(makeReviewOutput("clean"));
    vi.mocked(spawn).mockReturnValue(proc as never);

    await runReviewPass("/custom/workspace", "main", "claude-opus-4-6", "/tmp/reviewer.md");

    const [, , spawnOpts] = vi.mocked(spawn).mock.calls[0]!;
    expect((spawnOpts as { cwd?: string }).cwd).toBe("/custom/workspace");
  });

  // --- Timeout handling ---

  it("returns clean with 'Review unavailable' when claude exceeds 15-minute timeout", async () => {
    vi.useFakeTimers();

    // Build a silent mock proc (never emits events) with a kill spy
    const emitter = new EventEmitter();
    const proc = Object.assign(emitter, {
      stdout: new EventEmitter(),
      stderr: new EventEmitter(),
      stdin: { write: vi.fn(), end: vi.fn() },
      kill: vi.fn(),
    }) as unknown as MockProc;
    const killSpy = (proc as unknown as { kill: ReturnType<typeof vi.fn> }).kill;

    vi.mocked(spawn).mockReturnValue(proc as never);

    const resultPromise = runReviewPass("/tmp/ws", "main", "claude-opus-4-6", "/tmp/reviewer.md");

    // Advance time past the 15-minute timeout
    await vi.advanceTimersByTimeAsync(15 * 60 * 1000 + 1);

    // The timeout should have killed the process — the review is unavailable → clean
    const result = await resultPromise;
    expect(killSpy).toHaveBeenCalledWith("SIGTERM");
    expect(result.clean).toBe(true);
    expect(result.feedback).toBe("Review unavailable");

    vi.useRealTimers();
  });

  // --- Partial failure ---

  it("skips spawn when diff is empty", async () => {
    mockGitDiff("");
    const result = await runReviewPass("/tmp/ws", "main", "claude-opus-4-6", "/tmp/reviewer.md");
    expect(result.clean).toBe(true);
    expect(result.feedback).toBe("No changes to review");
    expect(vi.mocked(spawn)).not.toHaveBeenCalled();
  });

  // --- Combined feedback ---

  it("feedback contains parsed block content even when securityConcerns is true", async () => {
    const output = makeReviewOutput(
      "concerns",
      "Hardcoded token found, auth bypass possible",
      "Detailed security review:",
    );
    vi.mocked(spawn).mockReturnValue(createMockProc(output) as never);

    const result = await runReviewPass("/tmp/ws", "main", "claude-opus-4-6", "/tmp/reviewer.md");
    expect(result.clean).toBe(false);
    expect(result.securityConcerns).toBe(true);
    expect(result.feedback).toContain("Hardcoded token found");
    expect(result.feedback).toContain("auth bypass possible");
  });

  it("securityConcerns is false and clean is false when status=concerns with no security keywords", async () => {
    const output = makeReviewOutput("concerns", "Missing null check, undefined could be returned");
    vi.mocked(spawn).mockReturnValue(createMockProc(output) as never);

    const result = await runReviewPass("/tmp/ws", "main", "claude-opus-4-6", "/tmp/reviewer.md");
    expect(result.clean).toBe(false);
    expect(result.securityConcerns).toBe(false);
    expect(result.feedback).toContain("Missing null check");
  });
});

// =============================================================================
// runAllQualityGates
// =============================================================================

vi.mock("node:fs", () => ({
  existsSync: vi.fn().mockReturnValue(false),
}));

import { existsSync } from "node:fs";
import type { QualityGateConfig } from "../quality-gates.js";

function makeGateConfig(overrides: Partial<QualityGateConfig> = {}): QualityGateConfig {
  return {
    workspacePath: "/tmp/ws",
    baseBranch: "main",
    reviewModel: "claude-opus-4-6",
    reviewerPromptPath: "/tmp/code-reviewer.md",
    securityReviewerPromptPath: "/tmp/security-reviewer.md",
    ...overrides,
  };
}

describe("runAllQualityGates", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(readFile).mockResolvedValue(MOCK_REVIEWER_PROMPT as unknown as string);
    vi.mocked(existsSync).mockReturnValue(false);
  });

  it("returns passed=true with clean securityScanResult when scan is clean and reviews pass", async () => {
    mockGitDiff("+const x = 1;\n");
    vi.mocked(spawn).mockReturnValue(
      createMockProc(makeReviewOutput("clean")) as never,
    );

    const result = await runAllQualityGates(makeGateConfig());

    expect(result.passed).toBe(true);
    expect(result.securityScanResult.clean).toBe(true);
    expect(result.combinedFeedback).toContain("## Code Review");
    expect(result.combinedFeedback).toContain("## Security Review");
  });

  it("returns passed=false when security scan finds secrets", async () => {
    mockGitDiff('+const key = "AKIAIOSFODNN7EXAMPLE";\n');

    const result = await runAllQualityGates(makeGateConfig());

    expect(result.passed).toBe(false);
    expect(result.securityScanResult.clean).toBe(false);
    expect(result.combinedFeedback).toContain("Potential secret detected");
    expect(vi.mocked(spawn)).not.toHaveBeenCalled();
  });

  it("returns passed=false when any review pass has securityConcerns", async () => {
    mockGitDiff("+const x = 1;\n");
    vi.mocked(spawn).mockReturnValue(
      createMockProc(makeReviewOutput("concerns", "Possible injection vulnerability")) as never,
    );

    const result = await runAllQualityGates(makeGateConfig());

    expect(result.passed).toBe(false);
    expect(result.combinedFeedback).toContain("injection vulnerability");
  });

  it("returns passed=true when both reviews have concerns but no security keywords", async () => {
    mockGitDiff("+const x = 1;\n");
    // "concerns" status without security keywords → securityConcerns=false
    vi.mocked(spawn).mockReturnValue(
      createMockProc(makeReviewOutput("concerns", "Missing null check on line 42")) as never,
    );

    const result = await runAllQualityGates(makeGateConfig());

    expect(result.passed).toBe(true);
    expect(result.combinedFeedback).toContain("Missing null check");
  });

  it("uses provided prompt paths instead of defaults", async () => {
    mockGitDiff("+const x = 1;\n");
    vi.mocked(spawn).mockReturnValue(
      createMockProc(makeReviewOutput("clean")) as never,
    );

    await runAllQualityGates(makeGateConfig({
      reviewerPromptPath: "/custom/code-reviewer.md",
      securityReviewerPromptPath: "/custom/security-reviewer.md",
    }));

    // readFile called with the provided custom paths
    expect(vi.mocked(readFile)).toHaveBeenCalledWith("/custom/code-reviewer.md", "utf8");
    expect(vi.mocked(readFile)).toHaveBeenCalledWith("/custom/security-reviewer.md", "utf8");
  });

  it("uses default ~/.claude/agents paths when no paths provided and files exist", async () => {
    mockGitDiff("+const x = 1;\n");
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(spawn).mockReturnValue(
      createMockProc(makeReviewOutput("clean")) as never,
    );

    await runAllQualityGates(makeGateConfig({
      reviewerPromptPath: undefined,
      securityReviewerPromptPath: undefined,
    }));

    const calls = vi.mocked(readFile).mock.calls.map((c) => c[0] as string);
    expect(calls.some((p) => p.endsWith("code-reviewer.md"))).toBe(true);
    expect(calls.some((p) => p.endsWith("security-reviewer.md"))).toBe(true);
  });

  it("returns passed=true when both review passes return unavailable (errors caught internally)", async () => {
    mockGitDiff("+const x = 1;\n");
    // spawn exits with code 1 → runReviewPass catches and returns { clean: true, feedback: "Review unavailable" }
    vi.mocked(spawn).mockReturnValue(createMockProc("", 1) as never);

    const result = await runAllQualityGates(makeGateConfig());

    // runReviewPass catches errors internally and returns clean=true as fallback
    expect(result.passed).toBe(true);
    expect(result.combinedFeedback).toContain("Review unavailable");
  });

  it("includes unavailable message in combinedFeedback when a review pass errors", async () => {
    mockGitDiff("+const x = 1;\n");
    // First spawn call succeeds, second errors
    let callCount = 0;
    vi.mocked(spawn).mockImplementation(() => {
      callCount++;
      if (callCount === 1) {
        return createMockProc(makeReviewOutput("clean")) as never;
      }
      return createMockProc("", 1) as never;
    });

    const result = await runAllQualityGates(makeGateConfig());

    expect(result.combinedFeedback).toContain("Review unavailable");
  });

  it("returns securityScanResult in result", async () => {
    mockGitDiff("+const x = 1;\n");
    vi.mocked(spawn).mockReturnValue(
      createMockProc(makeReviewOutput("clean")) as never,
    );

    const result = await runAllQualityGates(makeGateConfig());

    expect(result.securityScanResult).toBeDefined();
    expect(result.securityScanResult.clean).toBe(true);
    expect(result.securityScanResult.findings).toEqual([]);
  });
});
