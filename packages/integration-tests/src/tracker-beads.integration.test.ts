/**
 * Integration tests for the Beads tracker plugin.
 *
 * Requires:
 *   - `bd` CLI installed and available in PATH
 *   - A Beads project at BEADS_PROJECT_PATH (defaults to ~/Projects/RU_Pro)
 *     with an initialised .beads/ directory
 *
 * Skipped automatically when prerequisites are missing.
 *
 * Each test run creates a real Beads issue via `bd create`, exercises all
 * plugin methods against it, and closes it in cleanup. This validates that
 * our `bd` shell-out logic, JSON parsing, and state mapping work against the
 * real CLI — not just against mocked responses.
 */

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { ProjectConfig } from "@composio/ao-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import trackerBeads from "@composio/ao-plugin-tracker-beads";

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Prerequisites
// ---------------------------------------------------------------------------

const BEADS_PROJECT_PATH =
  process.env["BEADS_PROJECT_PATH"] ?? join(homedir(), "Projects", "RU_Pro");

async function isBdAvailable(): Promise<boolean> {
  try {
    await execFileAsync("bd", ["--version"], { timeout: 5_000 });
    return true;
  } catch {
    return false;
  }
}

function isBeadsProject(path: string): boolean {
  return existsSync(join(path, ".beads"));
}

const bdOk = await isBdAvailable();
const projectOk = isBeadsProject(BEADS_PROJECT_PATH);
const canRun = bdOk && projectOk;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe.skipIf(!canRun)("tracker-beads (integration)", () => {
  const tracker = trackerBeads.create();

  const project: ProjectConfig = {
    name: "RU_Pro",
    repo: "davidfol95/RU_Pro",
    path: BEADS_PROJECT_PATH,
    defaultBranch: "main",
    sessionPrefix: "ru",
    tracker: { plugin: "beads" },
  };

  // Issue ID created in beforeAll, used across tests, closed in afterAll
  let issueId: string;

  // -------------------------------------------------------------------------
  // Setup — create a throwaway test issue
  // -------------------------------------------------------------------------

  beforeAll(async () => {
    const result = await tracker.createIssue!(
      {
        title: `[AO Integration Test] ${new Date().toISOString()}`,
        description: "Automated integration test issue. Safe to close if found lingering.",
        priority: 4, // Low / backlog
      },
      project,
    );

    issueId = result.id;
  }, 30_000);

  // -------------------------------------------------------------------------
  // Cleanup — close the test issue so it doesn't clutter the board
  // -------------------------------------------------------------------------

  afterAll(async () => {
    if (!issueId) return;
    try {
      await execFileAsync("bd", ["close", issueId, "--reason=AO integration test cleanup"], {
        cwd: BEADS_PROJECT_PATH,
        timeout: 15_000,
      });
    } catch {
      // Best-effort cleanup
    }
  }, 15_000);

  // -------------------------------------------------------------------------
  // Test cases
  // -------------------------------------------------------------------------

  it("createIssue returns a well-shaped Issue", () => {
    expect(issueId).toBeDefined();
    // Beads IDs follow the pattern <prefix>-<shortid>, e.g. "RU_Pro-abc"
    expect(issueId).toMatch(/^[A-Za-z0-9_]+-[A-Za-z0-9]+$/);
  });

  it("getIssue fetches the created issue with correct fields", async () => {
    const issue = await tracker.getIssue(issueId, project);

    expect(issue.id).toBe(issueId);
    expect(issue.title).toContain("[AO Integration Test]");
    expect(issue.description).toContain("Automated integration test");
    expect(issue.url).toBe(`beads://${issueId}`);
    expect(issue.state).toBe("open");
    expect(Array.isArray(issue.labels)).toBe(true);
    expect(issue.priority).toBe(4);
  });

  it("isCompleted returns false for an open issue", async () => {
    const completed = await tracker.isCompleted(issueId, project);
    expect(completed).toBe(false);
  });

  it("issueUrl returns beads:// URL", () => {
    const url = tracker.issueUrl(issueId, project);
    expect(url).toBe(`beads://${issueId}`);
  });

  it("issueLabel extracts id from beads:// URL", () => {
    const url = `beads://${issueId}`;
    const label = tracker.issueLabel?.(url, project);
    expect(label).toBe(issueId);
  });

  it("branchName returns feat/<id>", () => {
    const branch = tracker.branchName(issueId, project);
    expect(branch).toBe(`feat/${issueId}`);
  });

  it("generatePrompt includes issue title and description", async () => {
    const prompt = await tracker.generatePrompt(issueId, project);

    expect(prompt).toContain(issueId);
    expect(prompt).toContain("[AO Integration Test]");
    expect(prompt).toContain("Automated integration test");
    expect(prompt).toContain("implement the changes");
    expect(prompt).toContain("Priority: P4");
  });

  it("listIssues includes the created issue", async () => {
    const issues = await tracker.listIssues!({ state: "open", limit: 100 }, project);
    const found = issues.find((i) => i.id === issueId);

    expect(found).toBeDefined();
    expect(found!.title).toContain("[AO Integration Test]");
  });

  it("updateIssue transitions to in_progress and back to open", async () => {
    await tracker.updateIssue!(issueId, { state: "in_progress" }, project);

    const inProgress = await tracker.getIssue(issueId, project);
    expect(inProgress.state).toBe("in_progress");

    await tracker.updateIssue!(issueId, { state: "open" }, project);

    const reopened = await tracker.getIssue(issueId, project);
    expect(reopened.state).toBe("open");
  });

  it("updateIssue closes the issue and isCompleted reflects it", async () => {
    await tracker.updateIssue!(issueId, { state: "closed" }, project);

    const completed = await tracker.isCompleted(issueId, project);
    expect(completed).toBe(true);

    const issue = await tracker.getIssue(issueId, project);
    expect(issue.state).toBe("closed");
  });
});
