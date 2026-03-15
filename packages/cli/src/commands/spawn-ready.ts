import chalk from "chalk";
import type { Command } from "commander";
import { loadConfig, TERMINAL_STATUSES, type OrchestratorConfig } from "@composio/ao-core";
import { exec } from "../lib/shell.js";
import { banner } from "../lib/format.js";
import { getSessionManager } from "../lib/create-session-manager.js";
import { ensureLifecycleWorker } from "../lib/lifecycle-service.js";
import { preflight } from "../lib/preflight.js";

interface ReadyIssue {
  id: string;
  title?: string;
  [key: string]: unknown;
}

const ISSUE_ID_RE = /^[A-Za-z0-9_]+-[A-Za-z0-9.]+$/;

/**
 * Run preflight checks required for spawn-ready.
 * Validates tmux and bd availability.
 */
async function runPreflight(config: OrchestratorConfig, projectId: string): Promise<void> {
  const project = config.projects[projectId];
  const runtime = project?.runtime ?? config.defaults?.runtime;
  if (runtime === "tmux") {
    await preflight.checkTmux();
  }
  const bdResult = await preflight.checkBd();
  if (!bdResult.ok) {
    throw new Error(bdResult.message ?? "bd (beads) is not available");
  }
}

/**
 * Fetch ready issues from bd for the given project path.
 * Returns parsed JSON array or empty array on failure.
 */
async function fetchReadyIssues(
  projectPath: string,
  limit: number,
  scopeLabel?: string,
  issueType?: string,
): Promise<ReadyIssue[]> {
  const args = ["ready", "--json", "--limit", String(limit)];
  if (scopeLabel) {
    args.push("--label", scopeLabel);
  }
  if (issueType) {
    args.push("--type", issueType);
  }
  const { stdout } = await exec("bd", args, {
    cwd: projectPath,
  });

  if (!stdout.trim()) return [];

  try {
    const parsed = JSON.parse(stdout);
    const issues = Array.isArray(parsed) ? (parsed as ReadyIssue[]) : [];
    return issues.filter((issue) => typeof issue.id === "string" && ISSUE_ID_RE.test(issue.id));
  } catch {
    // bd ready --json may not be supported — fall back to empty
    return [];
  }
}

/**
 * Attempt to atomically claim an issue via bd update --claim.
 * Returns true if claimed, false if already claimed by another worker.
 */
async function tryClaimIssue(issueId: string, projectPath: string): Promise<boolean> {
  try {
    await exec("bd", ["update", issueId, "--claim"], { cwd: projectPath });
    return true;
  } catch {
    // Claim failed — issue already in_progress or claimed by someone else
    return false;
  }
}

export function registerSpawnReady(program: Command): void {
  program
    .command("spawn-ready")
    .description("Spawn agents for all unblocked ready issues in a project")
    .argument("<project>", "Project ID from config")
    .option("--dry-run", "List ready issues without spawning")
    .option("--limit <n>", "Maximum number of issues to spawn (default: 5)", "5")
    .option("--open", "Open the ao status UI after spawning")
    .option("--scope <label>", "Only process issues with this beads label")
    .option("--type <type>", "Only process issues of this type (task, bug, feature). Excludes epics by default unless specified.")
    .action(
      async (
        projectId: string,
        opts: { dryRun?: boolean; limit: string; open?: boolean; scope?: string; type?: string },
      ) => {
        const config = loadConfig();

        if (!config.projects[projectId]) {
          console.error(
            chalk.red(
              `Unknown project: ${projectId}\nAvailable: ${Object.keys(config.projects).join(", ")}`,
            ),
          );
          process.exit(1);
        }

        const project = config.projects[projectId];
        const projectPath = project.path;
        const limit = Math.max(1, parseInt(opts.limit, 10) || 5);

        console.log(banner("SPAWN READY"));
        console.log();
        console.log(`  Project: ${chalk.bold(projectId)}`);
        console.log(`  Path:    ${chalk.dim(projectPath)}`);
        console.log(`  Limit:   ${limit}`);
        if (opts.scope) console.log(`  Scope:   ${chalk.cyan(opts.scope)}`);
        if (opts.dryRun) console.log(`  Mode:    ${chalk.yellow("dry-run")}`);
        console.log();

        // Pre-flight checks
        try {
          await runPreflight(config, projectId);
        } catch (err) {
          console.error(chalk.red(`✗ ${err instanceof Error ? err.message : String(err)}`));
          process.exit(1);
        }

        // Fetch ready issues from beads
        let readyIssues: ReadyIssue[];
        try {
          readyIssues = await fetchReadyIssues(projectPath, limit, opts.scope, opts.type);
        } catch (err) {
          console.error(
            chalk.red(`✗ Failed to fetch ready issues: ${err instanceof Error ? err.message : String(err)}`),
          );
          process.exit(1);
        }

        if (readyIssues.length === 0) {
          if (opts.scope) {
            console.log(chalk.dim(`No ready issues found with label "${opts.scope}".`));
            try {
              const { stdout: labelsOut } = await exec("bd", ["label", "list-all", "--json"], {
                cwd: projectPath,
              });
              const parsed = JSON.parse(labelsOut) as Array<{ label: string; count: number }>;
              const allLabels = parsed.map((l) => l.label);
              if (allLabels.length > 0) {
                console.log(chalk.dim(`Available labels: ${allLabels.join(", ")}`));
              }
            } catch {
              // best effort — bd label list-all may not be available
            }
          } else {
            console.log(chalk.dim("No ready issues found."));
          }
          return;
        }

        console.log(`Found ${chalk.bold(String(readyIssues.length))} ready issue(s):\n`);
        for (const issue of readyIssues) {
          console.log(`  ${chalk.cyan(issue.id)}${issue.title ? ` — ${issue.title}` : ""}`);
        }
        console.log();

        if (opts.dryRun) {
          console.log(chalk.yellow("Dry run — no sessions spawned."));
          return;
        }

        // Start lifecycle worker
        try {
          await ensureLifecycleWorker(config, projectId);
        } catch (err) {
          console.error(
            chalk.red(`✗ Lifecycle worker failed: ${err instanceof Error ? err.message : String(err)}`),
          );
          process.exit(1);
        }

        // Load active sessions to detect duplicates
        const sm = await getSessionManager(config);
        const existingSessions = await sm.list(projectId);
        const activeIssueIds = new Set(
          existingSessions
            .filter((s) => s.issueId && !TERMINAL_STATUSES.has(s.status))
            .map((s) => s.issueId!.toLowerCase()),
        );

        const spawned: Array<{ issue: string; session: string }> = [];
        const skipped: Array<{ issue: string; reason: string }> = [];
        const failed: Array<{ issue: string; error: string }> = [];

        for (const issue of readyIssues) {
          const issueId = issue.id;

          // Skip if already has an active session
          if (activeIssueIds.has(issueId.toLowerCase())) {
            console.log(chalk.yellow(`  Skip ${issueId} — already has an active session`));
            skipped.push({ issue: issueId, reason: "active session exists" });
            continue;
          }

          // Atomically claim the issue; skip if already claimed
          const claimed = await tryClaimIssue(issueId, projectPath);
          if (!claimed) {
            console.log(chalk.yellow(`  Skip ${issueId} — claim failed (already in progress)`));
            skipped.push({ issue: issueId, reason: "claim failed" });
            continue;
          }

          // Spawn the session
          try {
            const session = await sm.spawn({ projectId, issueId });
            spawned.push({ issue: issueId, session: session.id });
            activeIssueIds.add(issueId.toLowerCase());
            console.log(chalk.green(`  Spawned ${session.id} for ${issueId}`));
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            failed.push({ issue: issueId, error: message });
            console.log(chalk.red(`  Failed ${issueId} — ${message}`));
          }
        }

        // Summary
        console.log();
        const parts: string[] = [
          chalk.green(`spawned ${spawned.length}`),
          chalk.yellow(`skipped ${skipped.length}`),
          chalk.red(`failed ${failed.length}`),
        ];
        console.log(`Summary: ${parts.join("  ")}`);

        if (spawned.length > 0) {
          console.log();
          console.log(chalk.green("Sessions created:"));
          for (const item of spawned) {
            console.log(`  ${item.session} ← ${item.issue}`);
          }
        }

        if (failed.length > 0) {
          console.log();
          console.log(chalk.red("Failures:"));
          for (const item of failed) {
            console.log(`  ${item.issue}: ${item.error}`);
          }
        }

        console.log();

        // Open status UI if requested
        if (opts.open && spawned.length > 0) {
          try {
            await exec("ao", ["status"]);
          } catch {
            // Best effort — ao status may not be available in all environments
          }
        }
      },
    );
}
