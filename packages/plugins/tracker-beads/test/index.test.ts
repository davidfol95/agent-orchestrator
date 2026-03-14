import { describe, it, expect, beforeEach, vi } from "vitest";

// ---------------------------------------------------------------------------
// Mock node:child_process — using vi.hoisted so the mock is available before
// module imports are resolved. The promisify.custom symbol makes promisify()
// delegate to bdMock instead of the real execFile.
// ---------------------------------------------------------------------------
const { bdMock } = vi.hoisted(() => ({ bdMock: vi.fn() }));

vi.mock("node:child_process", () => {
  const execFile = Object.assign(vi.fn(), {
    [Symbol.for("nodejs.util.promisify.custom")]: bdMock,
  });
  return { execFile };
});

import { create, manifest } from "../src/index.js";
import type { ProjectConfig } from "@composio/ao-core";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const project: ProjectConfig = {
  name: "test",
  repo: "org/repo",
  path: "/tmp/myproject",
  defaultBranch: "main",
  sessionPrefix: "test",
};

/** Return a successful bd response with JSON-serialised value. */
function mockBd(result: unknown) {
  bdMock.mockResolvedValueOnce({ stdout: JSON.stringify(result) });
}

/** Return a successful bd response with raw string output. */
function mockBdRaw(stdout: string) {
  bdMock.mockResolvedValueOnce({ stdout });
}

/** Simulate bd command failure. */
function mockBdError(msg = "Command failed") {
  bdMock.mockRejectedValueOnce(new Error(msg));
}

const sampleBeadsIssue = {
  id: "RU_Pro-abc",
  title: "Fix login bug",
  description: "Users cannot log in with SSO",
  status: "open",
  priority: 2,
  issue_type: "bug",
  owner: "alice",
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-02T00:00:00Z",
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("tracker-beads plugin", () => {
  let tracker: ReturnType<typeof create>;

  beforeEach(() => {
    vi.clearAllMocks();
    tracker = create();
  });

  // ---- manifest ------------------------------------------------------------

  describe("manifest", () => {
    it("has correct metadata", () => {
      expect(manifest.name).toBe("beads");
      expect(manifest.slot).toBe("tracker");
      expect(manifest.version).toBe("0.1.0");
    });
  });

  describe("create()", () => {
    it("returns a Tracker with correct name", () => {
      expect(tracker.name).toBe("beads");
    });
  });

  // ---- getIssue ------------------------------------------------------------

  describe("getIssue", () => {
    it("returns Issue with correct fields", async () => {
      mockBd([sampleBeadsIssue]);
      const issue = await tracker.getIssue("RU_Pro-abc", project);
      expect(issue).toEqual({
        id: "RU_Pro-abc",
        title: "Fix login bug",
        description: "Users cannot log in with SSO",
        url: "beads://RU_Pro-abc",
        state: "open",
        labels: [],
        assignee: "alice",
        priority: 2,
      });
    });

    it("calls bd show with --json and correct cwd", async () => {
      mockBd([sampleBeadsIssue]);
      await tracker.getIssue("RU_Pro-abc", project);
      expect(bdMock).toHaveBeenCalledWith(
        "bd",
        ["show", "RU_Pro-abc", "--json"],
        expect.objectContaining({ cwd: project.path }),
      );
    });

    it("maps in_progress status to in_progress state", async () => {
      mockBd([{ ...sampleBeadsIssue, status: "in_progress" }]);
      const issue = await tracker.getIssue("RU_Pro-abc", project);
      expect(issue.state).toBe("in_progress");
    });

    it("maps closed status to closed state", async () => {
      mockBd([{ ...sampleBeadsIssue, status: "closed" }]);
      const issue = await tracker.getIssue("RU_Pro-abc", project);
      expect(issue.state).toBe("closed");
    });

    it("maps open status to open state", async () => {
      mockBd([{ ...sampleBeadsIssue, status: "open" }]);
      const issue = await tracker.getIssue("RU_Pro-abc", project);
      expect(issue.state).toBe("open");
    });

    it("handles missing description gracefully", async () => {
      mockBd([{ ...sampleBeadsIssue, description: undefined }]);
      const issue = await tracker.getIssue("RU_Pro-abc", project);
      expect(issue.description).toBe("");
    });

    it("handles missing assignee (owner)", async () => {
      mockBd([{ ...sampleBeadsIssue, owner: undefined }]);
      const issue = await tracker.getIssue("RU_Pro-abc", project);
      expect(issue.assignee).toBeUndefined();
    });

    it("throws when bd show returns empty array", async () => {
      mockBd([]);
      await expect(tracker.getIssue("RU_Pro-abc", project)).rejects.toThrow(
        "bd show RU_Pro-abc returned empty array",
      );
    });

    it("propagates bd command failure", async () => {
      mockBdError("bd: command not found");
      await expect(tracker.getIssue("RU_Pro-abc", project)).rejects.toThrow(
        "bd show RU_Pro-abc --json failed",
      );
    });

    it("throws on malformed JSON response", async () => {
      bdMock.mockResolvedValueOnce({ stdout: "not json{" });
      await expect(tracker.getIssue("RU_Pro-abc", project)).rejects.toThrow();
    });
  });

  // ---- isCompleted ---------------------------------------------------------

  describe("isCompleted", () => {
    it("returns false for open issues", async () => {
      mockBd([{ ...sampleBeadsIssue, status: "open" }]);
      expect(await tracker.isCompleted("RU_Pro-abc", project)).toBe(false);
    });

    it("returns false for in_progress issues", async () => {
      mockBd([{ ...sampleBeadsIssue, status: "in_progress" }]);
      expect(await tracker.isCompleted("RU_Pro-abc", project)).toBe(false);
    });

    it("returns true for closed issues", async () => {
      mockBd([{ ...sampleBeadsIssue, status: "closed" }]);
      expect(await tracker.isCompleted("RU_Pro-abc", project)).toBe(true);
    });

    it("is case-insensitive for closed", async () => {
      mockBd([{ ...sampleBeadsIssue, status: "CLOSED" }]);
      expect(await tracker.isCompleted("RU_Pro-abc", project)).toBe(true);
    });

    it("calls bd show with cwd: project.path", async () => {
      mockBd([{ ...sampleBeadsIssue, status: "closed" }]);
      await tracker.isCompleted("RU_Pro-abc", project);
      expect(bdMock).toHaveBeenCalledWith(
        "bd",
        ["show", "RU_Pro-abc", "--json"],
        expect.objectContaining({ cwd: project.path }),
      );
    });
  });

  // ---- issueUrl ------------------------------------------------------------

  describe("issueUrl", () => {
    it("returns beads:// URL", () => {
      expect(tracker.issueUrl("RU_Pro-abc", project)).toBe("beads://RU_Pro-abc");
    });

    it("is synchronous and does not call bd", () => {
      tracker.issueUrl("RU_Pro-xyz", project);
      expect(bdMock).not.toHaveBeenCalled();
    });
  });

  // ---- issueLabel ----------------------------------------------------------

  describe("issueLabel", () => {
    it("extracts id from beads:// URL", () => {
      expect(tracker.issueLabel("beads://RU_Pro-abc", project)).toBe("RU_Pro-abc");
    });

    it("returns input unchanged when not a beads:// URL", () => {
      expect(tracker.issueLabel("RU_Pro-abc", project)).toBe("RU_Pro-abc");
    });

    it("roundtrips issueUrl -> issueLabel", () => {
      const url = tracker.issueUrl("RU_Pro-abc", project);
      expect(tracker.issueLabel(url, project)).toBe("RU_Pro-abc");
    });

    it("is synchronous and does not call bd", () => {
      tracker.issueLabel("beads://RU_Pro-abc", project);
      expect(bdMock).not.toHaveBeenCalled();
    });
  });

  // ---- branchName ----------------------------------------------------------

  describe("branchName", () => {
    it("generates feat/<id> format", () => {
      expect(tracker.branchName("RU_Pro-abc", project)).toBe("feat/RU_Pro-abc");
    });

    it("is synchronous and does not call bd", () => {
      tracker.branchName("RU_Pro-abc", project);
      expect(bdMock).not.toHaveBeenCalled();
    });
  });

  // ---- generatePrompt ------------------------------------------------------

  describe("generatePrompt", () => {
    it("includes issue id and title", async () => {
      mockBd([sampleBeadsIssue]);
      const prompt = await tracker.generatePrompt("RU_Pro-abc", project);
      expect(prompt).toContain("RU_Pro-abc");
      expect(prompt).toContain("Fix login bug");
    });

    it("includes beads:// URL", async () => {
      mockBd([sampleBeadsIssue]);
      const prompt = await tracker.generatePrompt("RU_Pro-abc", project);
      expect(prompt).toContain("beads://RU_Pro-abc");
    });

    it("includes issue type when present", async () => {
      mockBd([sampleBeadsIssue]);
      const prompt = await tracker.generatePrompt("RU_Pro-abc", project);
      expect(prompt).toContain("bug");
    });

    it("includes priority when present", async () => {
      mockBd([sampleBeadsIssue]);
      const prompt = await tracker.generatePrompt("RU_Pro-abc", project);
      expect(prompt).toContain("P2");
    });

    it("includes description when present", async () => {
      mockBd([sampleBeadsIssue]);
      const prompt = await tracker.generatePrompt("RU_Pro-abc", project);
      expect(prompt).toContain("Users cannot log in with SSO");
      expect(prompt).toContain("## Description");
    });

    it("omits description section when no description", async () => {
      mockBd([{ ...sampleBeadsIssue, description: undefined }]);
      const prompt = await tracker.generatePrompt("RU_Pro-abc", project);
      expect(prompt).not.toContain("## Description");
    });

    it("omits type line when issue_type missing", async () => {
      mockBd([{ ...sampleBeadsIssue, issue_type: undefined }]);
      const prompt = await tracker.generatePrompt("RU_Pro-abc", project);
      expect(prompt).not.toContain("Type:");
    });

    it("omits priority line when priority missing", async () => {
      mockBd([{ ...sampleBeadsIssue, priority: undefined }]);
      const prompt = await tracker.generatePrompt("RU_Pro-abc", project);
      expect(prompt).not.toContain("Priority:");
    });

    it("includes closing instruction", async () => {
      mockBd([sampleBeadsIssue]);
      const prompt = await tracker.generatePrompt("RU_Pro-abc", project);
      expect(prompt).toContain("conventional commit format");
    });

    it("calls bd show with cwd: project.path", async () => {
      mockBd([sampleBeadsIssue]);
      await tracker.generatePrompt("RU_Pro-abc", project);
      expect(bdMock).toHaveBeenCalledWith(
        "bd",
        ["show", "RU_Pro-abc", "--json"],
        expect.objectContaining({ cwd: project.path }),
      );
    });
  });

  // ---- listIssues ----------------------------------------------------------

  describe("listIssues", () => {
    it("returns mapped issues list", async () => {
      mockBd([sampleBeadsIssue, { ...sampleBeadsIssue, id: "RU_Pro-xyz", title: "Another" }]);
      const issues = await tracker.listIssues!({}, project);
      expect(issues).toHaveLength(2);
      expect(issues[0]?.id).toBe("RU_Pro-abc");
      expect(issues[1]?.id).toBe("RU_Pro-xyz");
    });

    it("defaults to --status=open filter", async () => {
      mockBd([]);
      await tracker.listIssues!({}, project);
      expect(bdMock).toHaveBeenCalledWith(
        "bd",
        expect.arrayContaining(["--status=open"]),
        expect.any(Object),
      );
    });

    it("passes --status=closed when state is closed", async () => {
      mockBd([]);
      await tracker.listIssues!({ state: "closed" }, project);
      expect(bdMock).toHaveBeenCalledWith(
        "bd",
        expect.arrayContaining(["--status=closed"]),
        expect.any(Object),
      );
    });

    it("omits status filter when state is all", async () => {
      mockBd([]);
      await tracker.listIssues!({ state: "all" }, project);
      const args: string[] = bdMock.mock.calls[0]?.[1];
      expect(args).not.toContain("--status=open");
      expect(args).not.toContain("--status=closed");
    });

    it("passes assignee filter", async () => {
      mockBd([]);
      await tracker.listIssues!({ assignee: "alice" }, project);
      expect(bdMock).toHaveBeenCalledWith(
        "bd",
        expect.arrayContaining(["--assignee=alice"]),
        expect.any(Object),
      );
    });

    it("passes limit filter", async () => {
      mockBd([]);
      await tracker.listIssues!({ limit: 10 }, project);
      expect(bdMock).toHaveBeenCalledWith(
        "bd",
        expect.arrayContaining(["--limit=10"]),
        expect.any(Object),
      );
    });

    it("returns empty array for empty list", async () => {
      mockBd([]);
      const issues = await tracker.listIssues!({}, project);
      expect(issues).toEqual([]);
    });

    it("calls bd with cwd: project.path", async () => {
      mockBd([]);
      await tracker.listIssues!({}, project);
      expect(bdMock).toHaveBeenCalledWith(
        "bd",
        expect.any(Array),
        expect.objectContaining({ cwd: project.path }),
      );
    });

    it("propagates bd command failure", async () => {
      mockBdError("bd: command not found");
      await expect(tracker.listIssues!({}, project)).rejects.toThrow("bd list --json --status=open failed");
    });

    it("throws on malformed JSON response", async () => {
      bdMock.mockResolvedValueOnce({ stdout: "broken json[" });
      await expect(tracker.listIssues!({}, project)).rejects.toThrow();
    });
  });

  // ---- updateIssue ---------------------------------------------------------

  describe("updateIssue", () => {
    it("closes an issue", async () => {
      bdMock.mockResolvedValueOnce({ stdout: "" });
      await tracker.updateIssue!("RU_Pro-abc", { state: "closed" }, project);
      expect(bdMock).toHaveBeenCalledWith(
        "bd",
        ["close", "RU_Pro-abc"],
        expect.objectContaining({ cwd: project.path }),
      );
    });

    it("sets status to open", async () => {
      bdMock.mockResolvedValueOnce({ stdout: "" });
      await tracker.updateIssue!("RU_Pro-abc", { state: "open" }, project);
      expect(bdMock).toHaveBeenCalledWith(
        "bd",
        ["update", "RU_Pro-abc", "--status=open"],
        expect.objectContaining({ cwd: project.path }),
      );
    });

    it("sets status to in_progress", async () => {
      bdMock.mockResolvedValueOnce({ stdout: "" });
      await tracker.updateIssue!("RU_Pro-abc", { state: "in_progress" }, project);
      expect(bdMock).toHaveBeenCalledWith(
        "bd",
        ["update", "RU_Pro-abc", "--status=in_progress"],
        expect.objectContaining({ cwd: project.path }),
      );
    });

    it("sets assignee", async () => {
      bdMock.mockResolvedValueOnce({ stdout: "" });
      await tracker.updateIssue!("RU_Pro-abc", { assignee: "bob" }, project);
      expect(bdMock).toHaveBeenCalledWith(
        "bd",
        ["update", "RU_Pro-abc", "--assignee=bob"],
        expect.objectContaining({ cwd: project.path }),
      );
    });

    it("adds a comment", async () => {
      bdMock.mockResolvedValueOnce({ stdout: "" });
      await tracker.updateIssue!("RU_Pro-abc", { comment: "Working on it" }, project);
      expect(bdMock).toHaveBeenCalledWith(
        "bd",
        ["comments", "add", "RU_Pro-abc", "Working on it"],
        expect.objectContaining({ cwd: project.path }),
      );
    });

    it("handles multiple updates in one call", async () => {
      bdMock.mockResolvedValue({ stdout: "" });
      await tracker.updateIssue!(
        "RU_Pro-abc",
        { state: "in_progress", assignee: "alice", comment: "Starting now" },
        project,
      );
      // state + assignee + comment = 3 bd calls
      expect(bdMock).toHaveBeenCalledTimes(3);
    });

    it("does nothing when update is empty", async () => {
      await tracker.updateIssue!("RU_Pro-abc", {}, project);
      expect(bdMock).not.toHaveBeenCalled();
    });

    it("uses cwd: project.path for all sub-calls", async () => {
      bdMock.mockResolvedValue({ stdout: "" });
      await tracker.updateIssue!(
        "RU_Pro-abc",
        { state: "closed", comment: "Done" },
        project,
      );
      for (const call of bdMock.mock.calls) {
        expect(call[2]).toMatchObject({ cwd: project.path });
      }
    });
  });

  // ---- createIssue ---------------------------------------------------------

  describe("createIssue", () => {
    it("creates an issue and fetches full details", async () => {
      // First call: bd create -> outputs "Created issue RU_Pro-new"
      mockBdRaw("Created issue RU_Pro-new\n");
      // Second call: bd show (from getIssue) -> returns the new issue
      mockBd([{ ...sampleBeadsIssue, id: "RU_Pro-new", title: "New issue" }]);

      const issue = await tracker.createIssue!(
        { title: "New issue", description: "Some description" },
        project,
      );
      expect(issue).toMatchObject({ id: "RU_Pro-new", title: "New issue", state: "open" });
    });

    it("passes title and description to bd create", async () => {
      mockBdRaw("Created issue RU_Pro-new\n");
      mockBd([{ ...sampleBeadsIssue, id: "RU_Pro-new" }]);

      await tracker.createIssue!(
        { title: "My issue", description: "Detailed description" },
        project,
      );
      expect(bdMock).toHaveBeenCalledWith(
        "bd",
        expect.arrayContaining(["create", "--title=My issue", "--description=Detailed description"]),
        expect.objectContaining({ cwd: project.path }),
      );
    });

    it("passes priority when provided", async () => {
      mockBdRaw("Created issue RU_Pro-new\n");
      mockBd([{ ...sampleBeadsIssue, id: "RU_Pro-new" }]);

      await tracker.createIssue!(
        { title: "My issue", description: "Desc", priority: 1 },
        project,
      );
      expect(bdMock).toHaveBeenCalledWith(
        "bd",
        expect.arrayContaining(["--priority=1"]),
        expect.objectContaining({ cwd: project.path }),
      );
    });

    it("passes assignee when provided", async () => {
      mockBdRaw("Created issue RU_Pro-new\n");
      mockBd([{ ...sampleBeadsIssue, id: "RU_Pro-new" }]);

      await tracker.createIssue!(
        { title: "My issue", description: "Desc", assignee: "alice" },
        project,
      );
      expect(bdMock).toHaveBeenCalledWith(
        "bd",
        expect.arrayContaining(["--assignee=alice"]),
        expect.objectContaining({ cwd: project.path }),
      );
    });

    it("throws when bd create output has no parseable issue id", async () => {
      mockBdRaw("unexpected output with no id\n");
      await expect(
        tracker.createIssue!({ title: "Test", description: "" }, project),
      ).rejects.toThrow("Failed to parse issue id from bd create output");
    });

    it("propagates bd create failure", async () => {
      mockBdError("bd: command not found");
      await expect(
        tracker.createIssue!({ title: "Test", description: "" }, project),
      ).rejects.toThrow("bd create --title=Test --description= failed");
    });

    it("calls bd show (getIssue) with cwd: project.path", async () => {
      // Use an id without underscores so the regex in createIssue parses it correctly
      mockBdRaw("Created issue AO-new\n");
      mockBd([{ ...sampleBeadsIssue, id: "AO-new" }]);

      await tracker.createIssue!({ title: "My issue", description: "" }, project);

      // Second call is bd show
      expect(bdMock).toHaveBeenNthCalledWith(
        2,
        "bd",
        ["show", "AO-new", "--json"],
        expect.objectContaining({ cwd: project.path }),
      );
    });
  });
});
