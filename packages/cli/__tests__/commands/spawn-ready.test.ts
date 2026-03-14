/**
 * E2E verification: spawn-ready with dependency chain
 *
 * Tests the full lifecycle of spawn-ready against a dependency chain:
 *   A (no deps) → B (depends on A) → C (depends on B)
 *
 * Validates:
 *  - Only unblocked issues (A) surface on the first run
 *  - Dependency resolution: B surfaces after A is closed
 *  - C surfaces only after B is closed
 *  - No double-spawning of any issue
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { type Session, type SessionManager, TERMINAL_STATUSES } from "@composio/ao-core";

// Hoisted mocks so vi.mock factories can reference them
const { mockExec, mockConfigRef, mockSessionManager, mockEnsureLifecycleWorker } = vi.hoisted(
  () => ({
    mockExec: vi.fn(),
    mockConfigRef: { current: null as Record<string, unknown> | null },
    mockSessionManager: {
      list: vi.fn(),
      kill: vi.fn(),
      cleanup: vi.fn(),
      get: vi.fn(),
      spawn: vi.fn(),
      spawnOrchestrator: vi.fn(),
      send: vi.fn(),
      claimPR: vi.fn(),
    },
    mockEnsureLifecycleWorker: vi.fn(),
  }),
);

vi.mock("../../src/lib/shell.js", () => ({
  tmux: vi.fn(),
  exec: mockExec,
  execSilent: vi.fn(),
  git: vi.fn(),
  gh: vi.fn(),
  getTmuxSessions: vi.fn().mockResolvedValue([]),
  getTmuxActivity: vi.fn().mockResolvedValue(null),
}));

vi.mock("@composio/ao-core", async (importOriginal) => {
  // eslint-disable-next-line @typescript-eslint/consistent-type-imports
  const actual = await importOriginal<typeof import("@composio/ao-core")>();
  return {
    ...actual,
    loadConfig: () => mockConfigRef.current,
  };
});

vi.mock("../../src/lib/create-session-manager.js", () => ({
  getSessionManager: async (): Promise<SessionManager> => mockSessionManager as SessionManager,
}));

vi.mock("../../src/lib/lifecycle-service.js", () => ({
  ensureLifecycleWorker: (...args: unknown[]) => mockEnsureLifecycleWorker(...args),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeSession(issueId: string, status: Session["status"] = "running"): Session {
  return {
    id: `app-${issueId}`,
    projectId: "ru-pro",
    status,
    activity: null,
    branch: null,
    issueId,
    pr: null,
    workspacePath: "/tmp/wt",
    runtimeHandle: { id: `hash-${issueId}`, runtimeName: "tmux", data: {} },
    agentInfo: null,
    createdAt: new Date(),
    lastActivityAt: new Date(),
    metadata: {},
  };
}

/** Build a mock `bd ready --json` stdout containing only the given issue IDs. */
function readyJson(ids: string[]): string {
  return JSON.stringify(ids.map((id) => ({ id, title: `Test issue ${id}` })));
}

// ---------------------------------------------------------------------------
// Test setup
// ---------------------------------------------------------------------------

let tmpDir: string;
let configPath: string;

import { Command } from "commander";
import { registerSpawnReady } from "../../src/commands/spawn-ready.js";

let program: Command;
let consoleSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "ao-spawn-ready-test-"));
  configPath = join(tmpDir, "agent-orchestrator.yaml");
  writeFileSync(configPath, "projects: {}");

  const projectPath = join(tmpDir, "ru-pro-repo");
  mkdirSync(projectPath, { recursive: true });

  mockConfigRef.current = {
    configPath,
    port: 3000,
    defaults: {
      runtime: "tmux",
      agent: "claude-code",
      workspace: "worktree",
      notifiers: [],
    },
    projects: {
      "ru-pro": {
        name: "RU Pro",
        repo: "davidfol95/RU_Pro",
        path: projectPath,
        defaultBranch: "main",
        sessionPrefix: "ru",
      },
    },
    notifiers: {},
    notificationRouting: {},
  } as Record<string, unknown>;

  program = new Command();
  program.exitOverride();
  registerSpawnReady(program);

  consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(process, "exit").mockImplementation((code) => {
    throw new Error(`process.exit(${code})`);
  });

  // Reset all mocks
  mockExec.mockReset();
  mockSessionManager.spawn.mockReset();
  mockSessionManager.list.mockReset();
  mockEnsureLifecycleWorker.mockReset();

  // Default: lifecycle worker succeeds
  mockEnsureLifecycleWorker.mockResolvedValue({
    running: true,
    started: true,
    pid: 99999,
    pidFile: "/tmp/lifecycle.pid",
    logFile: "/tmp/lifecycle.log",
  });

  // Default: no active sessions
  mockSessionManager.list.mockResolvedValue([]);

  // Default: preflight passes (bd version check + tmux check)
  mockExec.mockResolvedValue({ stdout: "tmux 3.3a", stderr: "" });
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Dependency chain: A → B → C
// ---------------------------------------------------------------------------

describe("spawn-ready dependency chain", () => {
  /**
   * Step 1: Only A is unblocked. bd ready returns [A].
   * spawn-ready should surface A in --dry-run and spawn only A normally.
   */
  describe("initial state: only A is unblocked", () => {
    beforeEach(() => {
      // bd ready returns only A (B and C are blocked by the chain)
      mockExec
        .mockResolvedValueOnce({ stdout: "tmux 3.3a", stderr: "" }) // checkTmux
        .mockResolvedValueOnce({ stdout: "bd 1.0.0", stderr: "" }) // checkBd
        .mockResolvedValueOnce({ stdout: readyJson(["RU_Pro-A"]), stderr: "" }); // bd ready
    });

    it("dry-run lists only A", async () => {
      await program.parseAsync([
        "node",
        "test",
        "spawn-ready",
        "ru-pro",
        "--dry-run",
      ]);

      const output = consoleSpy.mock.calls.map((c) => String(c[0])).join("\n");
      expect(output).toContain("RU_Pro-A");
      expect(output).not.toContain("RU_Pro-B");
      expect(output).not.toContain("RU_Pro-C");
      expect(output).toContain("dry-run");

      // No sessions spawned
      expect(mockSessionManager.spawn).not.toHaveBeenCalled();
    });

    it("spawns only A when B and C are blocked", async () => {
      // Claim succeeds for A
      mockExec.mockResolvedValueOnce({ stdout: "", stderr: "" }); // bd update --claim A

      mockSessionManager.spawn.mockResolvedValue(makeSession("RU_Pro-A"));

      await program.parseAsync(["node", "test", "spawn-ready", "ru-pro"]);

      expect(mockSessionManager.spawn).toHaveBeenCalledTimes(1);
      expect(mockSessionManager.spawn).toHaveBeenCalledWith({
        projectId: "ru-pro",
        issueId: "RU_Pro-A",
      });
    });

    it("does not spawn B or C", async () => {
      // Claim succeeds for A
      mockExec.mockResolvedValueOnce({ stdout: "", stderr: "" }); // bd update --claim A

      mockSessionManager.spawn.mockResolvedValue(makeSession("RU_Pro-A"));

      await program.parseAsync(["node", "test", "spawn-ready", "ru-pro"]);

      const spawnCalls = mockSessionManager.spawn.mock.calls;
      const spawnedIds = spawnCalls.map((call) => (call[0] as { issueId: string }).issueId);
      expect(spawnedIds).not.toContain("RU_Pro-B");
      expect(spawnedIds).not.toContain("RU_Pro-C");
    });
  });

  /**
   * Step 2: After A is closed, bd ready returns [B]. C remains blocked.
   */
  describe("after A is closed: B becomes unblocked", () => {
    beforeEach(() => {
      // Simulate A's session as terminal (done)
      const aSession = makeSession("RU_Pro-A", "done");
      mockSessionManager.list.mockResolvedValue([aSession]);

      // bd ready now returns B (A is closed, B unblocked; C still blocked)
      mockExec
        .mockResolvedValueOnce({ stdout: "tmux 3.3a", stderr: "" })
        .mockResolvedValueOnce({ stdout: "bd 1.0.0", stderr: "" })
        .mockResolvedValueOnce({ stdout: readyJson(["RU_Pro-B"]), stderr: "" });
    });

    it("dry-run shows only B", async () => {
      await program.parseAsync([
        "node",
        "test",
        "spawn-ready",
        "ru-pro",
        "--dry-run",
      ]);

      const output = consoleSpy.mock.calls.map((c) => String(c[0])).join("\n");
      expect(output).toContain("RU_Pro-B");
      expect(output).not.toContain("RU_Pro-A");
      expect(output).not.toContain("RU_Pro-C");
    });

    it("spawns B but not C", async () => {
      // Claim succeeds for B
      mockExec.mockResolvedValueOnce({ stdout: "", stderr: "" });

      mockSessionManager.spawn.mockResolvedValue(makeSession("RU_Pro-B"));

      await program.parseAsync(["node", "test", "spawn-ready", "ru-pro"]);

      expect(mockSessionManager.spawn).toHaveBeenCalledTimes(1);
      expect(mockSessionManager.spawn).toHaveBeenCalledWith({
        projectId: "ru-pro",
        issueId: "RU_Pro-B",
      });

      const spawnedIds = mockSessionManager.spawn.mock.calls.map(
        (call) => (call[0] as { issueId: string }).issueId,
      );
      expect(spawnedIds).not.toContain("RU_Pro-C");
    });

    it("skips A if it still has an active session (no double-spawn)", async () => {
      // Override list to return A as still active
      const activeSession = makeSession("RU_Pro-A", "running");
      // bd ready somehow still lists A (edge case guard)
      mockExec
        .mockReset()
        .mockResolvedValueOnce({ stdout: "tmux 3.3a", stderr: "" })
        .mockResolvedValueOnce({ stdout: "bd 1.0.0", stderr: "" })
        .mockResolvedValueOnce({
          stdout: readyJson(["RU_Pro-A", "RU_Pro-B"]),
          stderr: "",
        });
      mockSessionManager.list.mockResolvedValue([activeSession]);

      // Only B claim succeeds
      mockExec.mockResolvedValueOnce({ stdout: "", stderr: "" }); // claim B

      mockSessionManager.spawn.mockResolvedValue(makeSession("RU_Pro-B"));

      await program.parseAsync(["node", "test", "spawn-ready", "ru-pro"]);

      // A skipped due to active session; only B spawned
      expect(mockSessionManager.spawn).toHaveBeenCalledTimes(1);
      expect(mockSessionManager.spawn).toHaveBeenCalledWith({
        projectId: "ru-pro",
        issueId: "RU_Pro-B",
      });
    });
  });

  /**
   * Step 3: After B is closed, bd ready returns [C].
   */
  describe("after B is closed: C becomes unblocked", () => {
    beforeEach(() => {
      // Both A and B sessions are terminal
      mockSessionManager.list.mockResolvedValue([
        makeSession("RU_Pro-A", "done"),
        makeSession("RU_Pro-B", "done"),
      ]);

      // bd ready returns only C
      mockExec
        .mockResolvedValueOnce({ stdout: "tmux 3.3a", stderr: "" })
        .mockResolvedValueOnce({ stdout: "bd 1.0.0", stderr: "" })
        .mockResolvedValueOnce({ stdout: readyJson(["RU_Pro-C"]), stderr: "" });
    });

    it("spawns C after the full chain resolves", async () => {
      // Claim succeeds for C
      mockExec.mockResolvedValueOnce({ stdout: "", stderr: "" });

      mockSessionManager.spawn.mockResolvedValue(makeSession("RU_Pro-C"));

      await program.parseAsync(["node", "test", "spawn-ready", "ru-pro"]);

      expect(mockSessionManager.spawn).toHaveBeenCalledTimes(1);
      expect(mockSessionManager.spawn).toHaveBeenCalledWith({
        projectId: "ru-pro",
        issueId: "RU_Pro-C",
      });
    });
  });

  /**
   * No double-spawning: if an issue already has an active session, it is skipped
   * even if bd ready surfaces it.
   */
  describe("no double-spawning", () => {
    it("skips an issue that already has an active session", async () => {
      // bd ready lists A, but A already has an active session
      const activeA = makeSession("RU_Pro-A", "running");
      mockSessionManager.list.mockResolvedValue([activeA]);

      mockExec
        .mockResolvedValueOnce({ stdout: "tmux 3.3a", stderr: "" })
        .mockResolvedValueOnce({ stdout: "bd 1.0.0", stderr: "" })
        .mockResolvedValueOnce({ stdout: readyJson(["RU_Pro-A"]), stderr: "" });

      await program.parseAsync(["node", "test", "spawn-ready", "ru-pro"]);

      expect(mockSessionManager.spawn).not.toHaveBeenCalled();

      const output = consoleSpy.mock.calls.map((c) => String(c[0])).join("\n");
      expect(output).toContain("Skip");
    });

    it("skips an issue when claim fails (already in_progress)", async () => {
      // No active session for A, but bd update --claim fails
      mockSessionManager.list.mockResolvedValue([]);

      mockExec
        .mockResolvedValueOnce({ stdout: "tmux 3.3a", stderr: "" })
        .mockResolvedValueOnce({ stdout: "bd 1.0.0", stderr: "" })
        .mockResolvedValueOnce({ stdout: readyJson(["RU_Pro-A"]), stderr: "" })
        .mockRejectedValueOnce(new Error("already in_progress")); // bd update --claim A fails

      await program.parseAsync(["node", "test", "spawn-ready", "ru-pro"]);

      expect(mockSessionManager.spawn).not.toHaveBeenCalled();

      const output = consoleSpy.mock.calls.map((c) => String(c[0])).join("\n");
      expect(output).toContain("Skip");
    });
  });

  /**
   * Summary line validation: spawned/skipped/failed counts are printed.
   */
  describe("summary output", () => {
    it("prints spawned count in summary", async () => {
      mockExec
        .mockResolvedValueOnce({ stdout: "tmux 3.3a", stderr: "" })
        .mockResolvedValueOnce({ stdout: "bd 1.0.0", stderr: "" })
        .mockResolvedValueOnce({ stdout: readyJson(["RU_Pro-A"]), stderr: "" })
        .mockResolvedValueOnce({ stdout: "", stderr: "" }); // claim A

      mockSessionManager.spawn.mockResolvedValue(makeSession("RU_Pro-A"));

      await program.parseAsync(["node", "test", "spawn-ready", "ru-pro"]);

      const output = consoleSpy.mock.calls.map((c) => String(c[0])).join("\n");
      expect(output).toMatch(/spawned\s*1/i);
    });

    it("prints skipped count when issue is already active", async () => {
      mockSessionManager.list.mockResolvedValue([makeSession("RU_Pro-A", "running")]);

      mockExec
        .mockResolvedValueOnce({ stdout: "tmux 3.3a", stderr: "" })
        .mockResolvedValueOnce({ stdout: "bd 1.0.0", stderr: "" })
        .mockResolvedValueOnce({ stdout: readyJson(["RU_Pro-A"]), stderr: "" });

      await program.parseAsync(["node", "test", "spawn-ready", "ru-pro"]);

      const output = consoleSpy.mock.calls.map((c) => String(c[0])).join("\n");
      expect(output).toMatch(/skipped\s*1/i);
    });

    it("prints no ready issues message when list is empty", async () => {
      mockExec
        .mockResolvedValueOnce({ stdout: "tmux 3.3a", stderr: "" })
        .mockResolvedValueOnce({ stdout: "bd 1.0.0", stderr: "" })
        .mockResolvedValueOnce({ stdout: "", stderr: "" }); // empty ready list

      await program.parseAsync(["node", "test", "spawn-ready", "ru-pro"]);

      const output = consoleSpy.mock.calls.map((c) => String(c[0])).join("\n");
      expect(output).toMatch(/no ready issues/i);
      expect(mockSessionManager.spawn).not.toHaveBeenCalled();
    });
  });

  /**
   * Error handling: unknown project ID exits with code 1.
   */
  describe("error handling", () => {
    it("exits with code 1 for an unknown project ID", async () => {
      await expect(
        program.parseAsync(["node", "test", "spawn-ready", "unknown-project"]),
      ).rejects.toThrow("process.exit(1)");
    });
  });
});
