/**
 * Prompt Builder — composes layered prompts for agent sessions.
 *
 * Three layers:
 *   1. BASE_AGENT_PROMPT — constant instructions about session lifecycle, git workflow, PR handling
 *   2. Config-derived context — project name, repo, default branch, tracker info, reaction rules
 *   3. User rules — inline agentRules and/or agentRulesFile content
 *
 * buildPrompt() always returns the AO base guidance and project context so
 * bare launches still know about AO-specific commands such as PR claiming.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { ProjectConfig } from "./types.js";

// =============================================================================
// LAYER 1: BASE AGENT PROMPT
// =============================================================================

/**
 * Build the base agent prompt with the full autonomous lifecycle.
 * Agents are responsible for implementation through merge.
 */
export function buildBasePrompt(defaultBranch: string): string {
  return `You are an AI coding agent managed by the Agent Orchestrator (ao).

## Session Lifecycle
- You are running inside a managed session. Focus on the assigned task.
- You are fully responsible for your work from implementation through merge.
- If you're told to take over or continue work on an existing PR, run \`ao session claim-pr <pr-number-or-url>\` from inside this session before making changes.

## Git Workflow
- Create a feature branch from ${defaultBranch} (never commit directly to it).
- Use conventional commit messages (feat:, fix:, chore:, etc.).
- Keep PRs focused — one issue per PR.

## Landing the Code

When your implementation is complete, follow these steps IN ORDER. Do not skip any step.

### Step 1: Pre-push secret scan
Run \`git diff origin/${defaultBranch}...HEAD\` and check added lines for API keys, tokens,
passwords, or private keys. If found, remove them and recommit before pushing.

### Step 2: Push and create PR
\`\`\`bash
git push -u origin HEAD
gh pr create --base ${defaultBranch} --fill
\`\`\`
Link the issue in the PR body so it auto-closes on merge.

### Step 3: Quality reviews
Spawn BOTH sub-agents in parallel using the Agent tool, then WAIT for both to return:
- code-reviewer (subagent_type="code-reviewer"): "Review code changes on this branch vs origin/${defaultBranch}. Report any issues — critical, high, or medium priority."
- security-reviewer (subagent_type="security-reviewer"): "Review security of changes on this branch vs origin/${defaultBranch}. Report any issues — critical, high, or medium priority."

Read each sub-agent's response. Fix ALL critical and high issues, and fix medium issues where practical.
Only skip issues that are purely stylistic preferences or low-priority suggestions. Push fixes and
re-run BOTH reviews after changes. The goal is high-quality code, not just functioning code.

### Step 4: Wait for CI
Run: \`gh pr checks --watch\`
This blocks until all checks complete. If CI fails, read the failures, fix, push, and re-run.
If the repo has no CI checks configured, \`gh pr checks\` returns empty — proceed to merge.

### Step 5: Merge
When BOTH reviews pass AND CI is green:
\`\`\`bash
gh pr merge --squash
\`\`\`
Do NOT use --delete-branch (the worktree is still on this branch; cleanup handles branch deletion).
If merge fails due to conflicts: \`git fetch origin ${defaultBranch} && git rebase origin/${defaultBranch}\`, resolve, force-push, and retry from Step 4.
If merge fails due to permissions: comment on the PR requesting human merge, then exit.

Do not close the tracker issue manually — the orchestrator detects the merge and closes it automatically.

## Handling Failures
- CI failures: read the output, fix, push. Do not wait for external instructions.
- Merge conflicts: rebase on ${defaultBranch}, resolve, push.
- If you cannot resolve an issue after 2 attempts, comment on the PR explaining what went wrong and exit.

## PR Best Practices
- Write a clear PR title and description explaining what changed and why.
- Link the issue in the PR description so it auto-closes when merged.
- Respond to every review comment, even if just to acknowledge it.`;
}

/** Convenience export — base prompt with default branch "main". */
export const BASE_AGENT_PROMPT = buildBasePrompt("main");

// =============================================================================
// TYPES
// =============================================================================

export interface PromptBuildConfig {
  /** The project config from the orchestrator config */
  project: ProjectConfig;

  /** The project ID (key in the projects map) */
  projectId: string;

  /** Issue identifier (e.g. "INT-1343", "#42") — triggers Layer 1+2 */
  issueId?: string;

  /** Pre-fetched issue context from tracker.generatePrompt() */
  issueContext?: string;

  /** Explicit user prompt (appended last) */
  userPrompt?: string;

  /** Decomposition context — ancestor task chain (from decomposer) */
  lineage?: string[];

  /** Decomposition context — sibling task descriptions (from decomposer) */
  siblings?: string[];
}

// =============================================================================
// LAYER 2: CONFIG-DERIVED CONTEXT
// =============================================================================

function buildConfigLayer(config: PromptBuildConfig): string {
  const { project, projectId, issueId, issueContext } = config;
  const lines: string[] = [];

  lines.push("## Project Context");
  lines.push(`- Project: ${project.name ?? projectId}`);
  lines.push(`- Repository: ${project.repo}`);
  lines.push(`- Default branch: ${project.defaultBranch}`);

  if (project.tracker) {
    lines.push(`- Tracker: ${project.tracker.plugin}`);
  }

  if (issueId) {
    lines.push(`\n## Task`);
    lines.push(`Work on issue: ${issueId}`);
    lines.push(
      `Create a branch named so that it auto-links to the issue tracker (e.g. feat/${issueId}).`,
    );
  }

  if (issueContext) {
    lines.push(`\n## Issue Details`);
    lines.push(issueContext);
  }

  // Include reaction rules so the agent knows what to expect
  if (project.reactions) {
    const reactionHints: string[] = [];
    for (const [event, reaction] of Object.entries(project.reactions)) {
      if (reaction.auto && reaction.action === "send-to-agent") {
        reactionHints.push(`- ${event}: the orchestrator may also send you feedback on this`);
      }
    }
    if (reactionHints.length > 0) {
      lines.push(`\n## Automated Reactions`);
      lines.push("The orchestrator will automatically handle these events:");
      lines.push(...reactionHints);
    }
  }

  return lines.join("\n");
}

// =============================================================================
// LAYER 3: USER RULES
// =============================================================================

function readUserRules(project: ProjectConfig): string | null {
  const parts: string[] = [];

  if (project.agentRules) {
    parts.push(project.agentRules);
  }

  if (project.agentRulesFile) {
    const filePath = resolve(project.path, project.agentRulesFile);
    try {
      const content = readFileSync(filePath, "utf-8").trim();
      if (content) {
        parts.push(content);
      }
    } catch {
      // File not found or unreadable — skip silently (don't crash the spawn)
    }
  }

  return parts.length > 0 ? parts.join("\n\n") : null;
}

// =============================================================================
// PUBLIC API
// =============================================================================

/**
 * Compose a layered prompt for an agent session.
 *
 * Always returns the AO base guidance plus project context, then layers on
 * issue context, user rules, and explicit instructions when available.
 */
export function buildPrompt(config: PromptBuildConfig): string {
  const userRules = readUserRules(config.project);
  const sections: string[] = [];

  // Layer 1: Base prompt is always included for every managed session.
  sections.push(buildBasePrompt(config.project.defaultBranch));

  // Layer 2: Config-derived context
  sections.push(buildConfigLayer(config));

  // Layer 3: User rules
  if (userRules) {
    sections.push(`## Project Rules\n${userRules}`);
  }

  // Layer 4: Decomposition context (lineage + siblings)
  if (config.lineage && config.lineage.length > 0) {
    const hierarchy = config.lineage.map((desc, i) => `${"  ".repeat(i)}${i}. ${desc}`);
    // Add current task marker using issueId or last lineage entry
    const currentLabel = config.issueId ?? "this task";
    hierarchy.push(`${"  ".repeat(config.lineage.length)}${config.lineage.length}. ${currentLabel}  <-- (this task)`);

    sections.push(
      `## Task Hierarchy\nThis task is part of a larger decomposed plan. Your place in the hierarchy:\n\n\`\`\`\n${hierarchy.join("\n")}\n\`\`\`\n\nStay focused on YOUR specific task. Do not implement functionality that belongs to other tasks in the hierarchy.`,
    );
  }

  if (config.siblings && config.siblings.length > 0) {
    const siblingLines = config.siblings.map((s) => `  - ${s}`);
    sections.push(
      `## Parallel Work\nSibling tasks being worked on in parallel:\n${siblingLines.join("\n")}\n\nDo not duplicate work that sibling tasks handle. If you need interfaces/types from siblings, define reasonable stubs.`,
    );
  }

  // Explicit user prompt (appended last, highest priority)
  if (config.userPrompt) {
    sections.push(`## Additional Instructions\n${config.userPrompt}`);
  }

  return sections.join("\n\n");
}
