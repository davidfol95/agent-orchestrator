/**
 * tracker-beads plugin — Beads issue tracker.
 *
 * Uses the `bd` CLI for all Beads interactions.
 * All bd commands run with cwd: project.path (the repo root where .beads/ lives).
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type {
  PluginModule,
  Tracker,
  Issue,
  IssueFilters,
  IssueUpdate,
  CreateIssueInput,
  ProjectConfig,
} from "@composio/ao-core";

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Beads issue shape (from bd show --json / bd list --json)
// ---------------------------------------------------------------------------

interface BeadsIssue {
  id: string;
  title: string;
  description?: string;
  status: string;
  priority?: number;
  issue_type?: string;
  owner?: string;
  created_at?: string;
  updated_at?: string;
  dependency_count?: number;
  dependent_count?: number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function bd(args: string[], cwd: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync("bd", args, {
      cwd,
      maxBuffer: 10 * 1024 * 1024,
      timeout: 30_000,
    });
    return stdout.trim();
  } catch (err) {
    throw new Error(`bd ${args.slice(0, 3).join(" ")} failed: ${(err as Error).message}`, {
      cause: err,
    });
  }
}

/**
 * bd show <id> --json returns an array [{}], not a single object.
 * This helper takes the first element.
 */
async function bdShowOne(id: string, cwd: string): Promise<BeadsIssue> {
  const raw = await bd(["show", id, "--json"], cwd);
  const arr: BeadsIssue[] = JSON.parse(raw);
  const issue = arr[0];
  if (!issue) {
    throw new Error(`bd show ${id} returned empty array`);
  }
  return issue;
}

/**
 * Map beads status to AO Issue state.
 * beads: open | in_progress -> AO: open
 * beads: closed -> AO: closed
 */
function mapState(beadsStatus: string): Issue["state"] {
  const s = beadsStatus.toLowerCase();
  if (s === "closed") return "closed";
  if (s === "in_progress") return "in_progress";
  return "open";
}

function toAoIssue(data: BeadsIssue): Issue {
  return {
    id: data.id,
    title: data.title,
    description: data.description ?? "",
    url: `beads://${data.id}`,
    state: mapState(data.status),
    labels: [],
    assignee: data.owner,
    priority: data.priority,
  };
}

// ---------------------------------------------------------------------------
// Tracker implementation
// ---------------------------------------------------------------------------

function createBeadsTracker(): Tracker {
  return {
    name: "beads",

    async getIssue(identifier: string, project: ProjectConfig): Promise<Issue> {
      const data = await bdShowOne(identifier, project.path);
      return toAoIssue(data);
    },

    async isCompleted(identifier: string, project: ProjectConfig): Promise<boolean> {
      const data = await bdShowOne(identifier, project.path);
      return data.status.toLowerCase() === "closed";
    },

    issueUrl(identifier: string, _project: ProjectConfig): string {
      return `beads://${identifier}`;
    },

    issueLabel(url: string, _project: ProjectConfig): string {
      // Extract id from beads://RU_Pro-abc → "RU_Pro-abc"
      const match = url.match(/^beads:\/\/(.+)$/);
      if (match?.[1]) {
        return match[1];
      }
      return url;
    },

    branchName(identifier: string, _project: ProjectConfig): string {
      return `feat/${identifier}`;
    },

    async generatePrompt(identifier: string, project: ProjectConfig): Promise<string> {
      const data = await bdShowOne(identifier, project.path);
      const lines: string[] = [
        `You are working on Beads issue ${data.id}: ${data.title}`,
        `Issue URL: beads://${data.id}`,
        "",
      ];

      if (data.issue_type) {
        lines.push(`Type: ${data.issue_type}`);
      }

      if (data.priority !== undefined) {
        lines.push(`Priority: P${data.priority}`);
      }

      if (data.description) {
        lines.push("", "## Description", "", data.description);
      }

      lines.push(
        "",
        "Please implement the changes described in this issue. When done, commit your changes using conventional commit format.",
      );

      return lines.join("\n");
    },

    async listIssues(filters: IssueFilters, project: ProjectConfig): Promise<Issue[]> {
      const args = ["list", "--json"];

      if (filters.state === "closed") {
        args.push("--status=closed");
      } else if (filters.state === "all") {
        // No status filter — return all
      } else {
        // Default: open issues (open + in_progress)
        args.push("--status=open");
      }

      if (filters.assignee) {
        args.push(`--assignee=${filters.assignee}`);
      }

      if (filters.limit !== undefined) {
        args.push(`--limit=${filters.limit}`);
      }

      const raw = await bd(args, project.path);
      const issues: BeadsIssue[] = JSON.parse(raw);
      return issues.map(toAoIssue);
    },

    async updateIssue(
      identifier: string,
      update: IssueUpdate,
      project: ProjectConfig,
    ): Promise<void> {
      if (update.state === "closed") {
        await bd(["close", identifier], project.path);
      } else if (update.state === "open") {
        await bd(["update", identifier, "--status=open"], project.path);
      } else if (update.state === "in_progress") {
        await bd(["update", identifier, "--status=in_progress"], project.path);
      }

      if (update.assignee) {
        await bd(["update", identifier, `--assignee=${update.assignee}`], project.path);
      }

      if (update.comment) {
        await bd(["comments", "add", identifier, update.comment], project.path);
      }
    },

    async createIssue(input: CreateIssueInput, project: ProjectConfig): Promise<Issue> {
      const args = ["create", `--title=${input.title}`, `--description=${input.description}`];

      if (input.priority !== undefined) {
        args.push(`--priority=${input.priority}`);
      }

      if (input.assignee) {
        args.push(`--assignee=${input.assignee}`);
      }

      // bd create outputs something like "Created issue RU_Pro-abc"
      const output = await bd(args, project.path);

      // Extract issue id from output
      const match = output.match(/([A-Za-z0-9]+-[A-Za-z0-9]+)\s*$/);
      if (!match?.[1]) {
        throw new Error(`Failed to parse issue id from bd create output: ${output}`);
      }
      const newId = match[1];

      return this.getIssue(newId, project);
    },
  };
}

// ---------------------------------------------------------------------------
// Plugin module export
// ---------------------------------------------------------------------------

export const manifest = {
  name: "beads",
  slot: "tracker" as const,
  description: "Tracker plugin: Beads issue tracker",
  version: "0.1.0",
};

export function create(): Tracker {
  return createBeadsTracker();
}

export default { manifest, create } satisfies PluginModule<Tracker>;
