import { spawn } from "node:child_process";
import chalk from "chalk";
import type { Command } from "commander";
import { loadConfig, SessionNotRestorableError, WorkspaceMissingError } from "@composio/ao-core";
import { runRecovery, recoverSessionById } from "@composio/ao-core/recovery";
import { git, getTmuxActivity, tmux } from "../lib/shell.js";
import { formatAge } from "../lib/format.js";
import { getSessionManager, getPluginRegistry } from "../lib/create-session-manager.js";

export function registerSession(program: Command): void {
  const session = program
    .command("session")
    .description("Session management (ls, kill, cleanup, restore, claim-pr)");

  session
    .command("ls")
    .description("List all sessions")
    .option("-p, --project <id>", "Filter by project ID")
    .action(async (opts: { project?: string }) => {
      const config = loadConfig();
      if (opts.project && !config.projects[opts.project]) {
        console.error(chalk.red(`Unknown project: ${opts.project}`));
        process.exit(1);
      }

      const sm = await getSessionManager(config);
      const sessions = await sm.list(opts.project);

      // Group sessions by project
      const byProject = new Map<string, typeof sessions>();
      for (const s of sessions) {
        const list = byProject.get(s.projectId) ?? [];
        list.push(s);
        byProject.set(s.projectId, list);
      }

      // Iterate over all configured projects (not just ones with sessions)
      const projectIds = opts.project ? [opts.project] : Object.keys(config.projects);

      for (const projectId of projectIds) {
        const project = config.projects[projectId];
        if (!project) continue;
        console.log(chalk.bold(`\n${project.name || projectId}:`));

        const projectSessions = (byProject.get(projectId) ?? []).sort((a, b) =>
          a.id.localeCompare(b.id),
        );

        if (projectSessions.length === 0) {
          console.log(chalk.dim("  (no active sessions)"));
          continue;
        }

        for (const s of projectSessions) {
          // Get live branch from worktree if available
          let branchStr = s.branch || "";
          if (s.workspacePath) {
            const liveBranch = await git(["branch", "--show-current"], s.workspacePath);
            if (liveBranch) branchStr = liveBranch;
          }

          // Get tmux activity age
          const tmuxTarget = s.runtimeHandle?.id ?? s.id;
          const activityTs = await getTmuxActivity(tmuxTarget);
          const age = activityTs ? formatAge(activityTs) : "-";

          const parts = [chalk.green(s.id), chalk.dim(`(${age})`)];
          if (branchStr) parts.push(chalk.cyan(branchStr));
          if (s.status) parts.push(chalk.dim(`[${s.status}]`));
          const prUrl = s.metadata["pr"];
          if (prUrl) parts.push(chalk.blue(prUrl));

          console.log(`  ${parts.join("  ")}`);
        }
      }
      console.log();
    });

  session
    .command("attach")
    .description("Attach to a session's tmux window")
    .argument("<session>", "Session name to attach")
    .action(async (sessionName: string) => {
      const config = loadConfig();
      const sm = await getSessionManager(config);
      const sessionInfo = await sm.get(sessionName);
      const tmuxTarget = sessionInfo?.runtimeHandle?.id ?? sessionName;

      const exists = await tmux("has-session", "-t", tmuxTarget);
      if (exists === null) {
        console.error(chalk.red(`Session '${sessionName}' does not exist`));
        process.exit(1);
      }

      await new Promise<void>((resolve, reject) => {
        const child = spawn("tmux", ["attach", "-t", tmuxTarget], { stdio: "inherit" });
        child.once("error", (err) => reject(err));
        child.once("exit", (code) => {
          if (code === 0 || code === null) {
            resolve();
            return;
          }
          reject(new Error(`tmux attach exited with code ${code}`));
        });
      }).catch((err) => {
        console.error(chalk.red(`Failed to attach to session ${sessionName}: ${err}`));
        process.exit(1);
      });
    });

  session
    .command("kill")
    .description("Kill a session and remove its worktree")
    .argument("<session>", "Session name to kill")
    .option("--purge-session", "Delete mapped OpenCode session during kill")
    .action(async (sessionName: string, opts: { purgeSession?: boolean }) => {
      const config = loadConfig();
      const sm = await getSessionManager(config);

      try {
        await sm.kill(sessionName, { purgeOpenCode: opts.purgeSession === true });
        console.log(chalk.green(`\nSession ${sessionName} killed.`));
      } catch (err) {
        console.error(chalk.red(`Failed to kill session ${sessionName}: ${err}`));
        process.exit(1);
      }
    });

  session
    .command("cleanup")
    .description("Kill sessions where PR is merged or issue is closed")
    .option("-p, --project <id>", "Filter by project ID")
    .option("--dry-run", "Show what would be cleaned up without doing it")
    .action(async (opts: { project?: string; dryRun?: boolean }) => {
      const config = loadConfig();
      if (opts.project && !config.projects[opts.project]) {
        console.error(chalk.red(`Unknown project: ${opts.project}`));
        process.exit(1);
      }

      console.log(chalk.bold("Checking for completed sessions...\n"));

      const sm = await getSessionManager(config);

      if (opts.dryRun) {
        // Dry-run delegates to sm.cleanup() with dryRun flag so it uses the
        // same live checks (PR state, runtime alive, tracker) as actual cleanup.
        const result = await sm.cleanup(opts.project, { dryRun: true });

        if (result.errors.length > 0) {
          for (const { sessionId, error } of result.errors) {
            console.error(chalk.red(`  Error checking ${sessionId}: ${error}`));
          }
        }

        if (result.killed.length === 0 && result.errors.length === 0) {
          console.log(chalk.dim("  No sessions to clean up."));
        } else {
          for (const id of result.killed) {
            console.log(chalk.yellow(`  Would kill ${id}`));
          }
          if (result.killed.length > 0) {
            console.log(
              chalk.dim(
                `\nDry run complete. ${result.killed.length} session${result.killed.length !== 1 ? "s" : ""} would be cleaned.`,
              ),
            );
          }
        }
      } else {
        const result = await sm.cleanup(opts.project);

        if (result.killed.length === 0 && result.errors.length === 0) {
          console.log(chalk.dim("  No sessions to clean up."));
        } else {
          if (result.killed.length > 0) {
            for (const id of result.killed) {
              console.log(chalk.green(`  Cleaned: ${id}`));
            }
          }
          if (result.errors.length > 0) {
            for (const { sessionId, error } of result.errors) {
              console.error(chalk.red(`  Error cleaning ${sessionId}: ${error}`));
            }
          }
          console.log(chalk.green(`\nCleanup complete. ${result.killed.length} sessions cleaned.`));
        }
      }
    });

  session
    .command("claim-pr")
    .description("Attach an existing PR to a session")
    .argument("<pr>", "Pull request number or URL")
    .argument("[session]", "Session name (defaults to AO_SESSION_NAME/AO_SESSION)")
    .option("--assign-on-github", "Assign the PR to the authenticated GitHub user")
    .option("--takeover", "Transfer PR ownership from another AO session if needed")
    .action(
      async (
        prRef: string,
        sessionName: string | undefined,
        opts: { assignOnGithub?: boolean; takeover?: boolean },
      ) => {
        const config = loadConfig();
        const resolvedSession =
          sessionName ?? process.env["AO_SESSION_NAME"] ?? process.env["AO_SESSION"];

        if (!resolvedSession) {
          console.error(
            chalk.red(
              "No session provided. Pass a session name or run this inside a managed AO session.",
            ),
          );
          process.exit(1);
        }

        const sm = await getSessionManager(config);

        try {
          const result = await sm.claimPR(resolvedSession, prRef, {
            assignOnGithub: opts.assignOnGithub,
            takeover: opts.takeover,
          });

          console.log(chalk.green(`\nSession ${resolvedSession} claimed PR #${result.pr.number}.`));
          console.log(chalk.dim(`  PR:       ${result.pr.url}`));
          console.log(chalk.dim(`  Branch:   ${result.pr.branch}`));
          console.log(
            chalk.dim(
              `  Checkout: ${result.branchChanged ? "switched to PR branch" : "already on PR branch"}`,
            ),
          );
          if (result.takenOverFrom.length > 0) {
            console.log(chalk.dim(`  Took over from: ${result.takenOverFrom.join(", ")}`));
          }
          if (opts.assignOnGithub) {
            if (result.githubAssigned) {
              console.log(chalk.dim("  GitHub assignee: updated"));
            } else if (result.githubAssignmentError) {
              console.log(chalk.yellow(`  GitHub assignee: ${result.githubAssignmentError}`));
            }
          }
        } catch (err) {
          console.error(chalk.red(`Failed to claim PR for session ${resolvedSession}: ${err}`));
          process.exit(1);
        }
      },
    );

  session
    .command("restore")
    .description("Restore a terminated/crashed session in-place")
    .argument("<session>", "Session name to restore")
    .action(async (sessionName: string) => {
      const config = loadConfig();
      const sm = await getSessionManager(config);

      try {
        const restored = await sm.restore(sessionName);
        console.log(chalk.green(`\nSession ${sessionName} restored.`));
        if (restored.workspacePath) {
          console.log(chalk.dim(`  Worktree: ${restored.workspacePath}`));
        }
        if (restored.branch) {
          console.log(chalk.dim(`  Branch:   ${restored.branch}`));
        }
        const tmuxTarget = restored.runtimeHandle?.id ?? sessionName;
        console.log(chalk.dim(`  Attach:   tmux attach -t ${tmuxTarget}`));
      } catch (err) {
        if (err instanceof SessionNotRestorableError) {
          console.error(chalk.red(`Cannot restore: ${err.reason}`));
        } else if (err instanceof WorkspaceMissingError) {
          console.error(chalk.red(`Workspace missing: ${err.message}`));
        } else {
          console.error(chalk.red(`Failed to restore session ${sessionName}: ${err}`));
        }
        process.exit(1);
      }
    });

  session
    .command("recover")
    .description("Recover orphaned/stale sessions after orchestrator restart")
    .argument("[session]", "Session ID to recover (omit for --all)")
    .option("--all", "Recover all orphaned sessions")
    .option("--dry-run", "Show what would be recovered without doing it")
    .option("-p, --project <id>", "Filter by project ID (with --all)")
    .action(
      async (
        sessionId: string | undefined,
        opts: { all?: boolean; dryRun?: boolean; project?: string },
      ) => {
        const config = loadConfig();

        if (opts.project && !config.projects[opts.project]) {
          console.error(chalk.red(`Unknown project: ${opts.project}`));
          process.exit(1);
        }

        if (!opts.all && !sessionId) {
          console.error(chalk.red("Specify a session ID or use --all to recover all sessions"));
          process.exit(1);
        }

        const registry = await getPluginRegistry(config);

        if (opts.all || !sessionId) {
          console.log(chalk.bold("Scanning for orphaned sessions...\n"));

          let report, assessments;
          try {
            const result = await runRecovery({
              config,
              registry,
              dryRun: opts.dryRun,
              projectFilter: opts.project,
            });
            report = result.report;
            assessments = result.assessments;
          } catch (err) {
            console.error(
              chalk.red(
                `Recovery scan failed: ${err instanceof Error ? err.message : String(err)}`,
              ),
            );
            process.exit(1);
          }

          if (opts.dryRun) {
            for (const a of assessments) {
              const color =
                a.classification === "live"
                  ? chalk.green
                  : a.classification === "dead"
                    ? chalk.red
                    : a.classification === "partial"
                      ? chalk.yellow
                      : chalk.dim;
              console.log(
                color(`  ${a.sessionId}: ${a.classification} (${a.action}) - ${a.reason}`),
              );
            }
            console.log(chalk.dim(`\nDry run complete. ${report.totalScanned} sessions scanned.`));
          } else {
            console.log(chalk.dim(`\nRecovery complete.`));
            console.log(chalk.green(`  Recovered: ${report.recovered.length}`));
            console.log(chalk.red(`  Cleaned up: ${report.cleanedUp.length}`));
            console.log(chalk.yellow(`  Escalated: ${report.escalated.length}`));
            if (report.errors.length > 0) {
              console.log(chalk.red(`  Errors: ${report.errors.length}`));
              for (const { sessionId: id, error } of report.errors) {
                console.error(chalk.red(`    ${id}: ${error}`));
              }
            }
          }
        } else {
          let result;
          try {
            result = await recoverSessionById(sessionId, {
              config,
              registry,
              dryRun: opts.dryRun,
            });
          } catch (err) {
            console.error(
              chalk.red(
                `Recovery failed for session ${sessionId}: ${err instanceof Error ? err.message : String(err)}`,
              ),
            );
            process.exit(1);
          }

          if (!result) {
            console.error(chalk.red(`Session ${sessionId} not found.`));
            process.exit(1);
          }

          if (opts.dryRun) {
            console.log(chalk.dim(`Would ${result.action} session ${sessionId}`));
          } else if (result.success) {
            console.log(chalk.green(`Session ${sessionId}: ${result.action}`));
            if (result.session) {
              console.log(chalk.dim(`  Status: ${result.session.status}`));
              if (result.session.workspacePath) {
                console.log(chalk.dim(`  Workspace: ${result.session.workspacePath}`));
              }
            }
          } else {
            console.error(chalk.red(`Failed to recover ${sessionId}: ${result.error}`));
            process.exit(1);
          }
        }
      },
    );

  session
    .command("remap")
    .description("Re-discover and persist OpenCode session mapping for an AO session")
    .argument("<session>", "Session name to remap")
    .option("-f, --force", "Force fresh remap by re-discovering the OpenCode session")
    .action(async (sessionName: string, opts: { force?: boolean }) => {
      const config = loadConfig();
      const sm = await getSessionManager(config);

      try {
        const mapped = await sm.remap(sessionName, opts.force === true);
        console.log(chalk.green(`\nSession ${sessionName} remapped.`));
        console.log(chalk.dim(`  OpenCode session: ${mapped}`));
      } catch (err) {
        console.error(chalk.red(`Failed to remap session ${sessionName}: ${err}`));
        process.exit(1);
      }
    });
}
