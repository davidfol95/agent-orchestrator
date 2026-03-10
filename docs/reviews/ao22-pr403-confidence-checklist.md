# PR #403 Confidence Checklist (AO22)

Date: 2026-03-10  
Branch: `feat/399`  
Scope validated: feedback tools (`bug_report`, `improvement_suggestion`) schema/validation/storage/dedupe behavior

## 1) Schema/contract tests

### Commands

```bash
pnpm --filter @composio/ao-core test -- src/__tests__/feedback-tools.test.ts -t "feedback tool contracts"
```

### Expected

- Both tool contracts are present.
- Required fields are enforced.

### Actual

- `3 passed | 7 skipped` in `feedback-tools.test.ts` (contracts block).

### Result

- PASS

## 2) Persistence resilience tests (including malformed report files)

### Commands

```bash
pnpm --filter @composio/ao-core test -- src/__tests__/feedback-tools.test.ts -t "feedback report store"
```

### Expected

- Structured reports persist and round-trip via `list()`.
- Invalid inputs are rejected.
- Corrupt `.kv` files are skipped without breaking valid reads.

### Actual

- `3 passed | 7 skipped` in `feedback-tools.test.ts` (store block, includes corrupt file handling case).

### Result

- PASS

## 3) Dedupe determinism tests (case/order stability)

### Commands

```bash
pnpm --filter @composio/ao-core test -- src/__tests__/feedback-tools.test.ts -t "feedback dedupe key"
```

### Expected

- Dedupe key is stable across whitespace/case changes and evidence ordering.
- Case-only evidence sort-order edge cases remain stable.

### Actual

- `4 passed | 6 skipped` in `feedback-tools.test.ts` (dedupe block).

### Result

- PASS

## 4) Real operator smoke from non-`ao-22` working directory

### Commands

```bash
pnpm --filter @composio/ao-core build
node /tmp/ao403-opclaw-smoke/feedback-smoke.mjs
```

Smoke script ran from `cwd=/tmp/ao403-opclaw-smoke` and used:
- `FeedbackReportStore.persist()` for `bug_report` + `improvement_suggestion`
- `store.list()` round-trip read
- on-disk artifact checks under `/tmp/ao403-opclaw-smoke/dogfood-feedback-reports`

### Expected

- Two tool types can be persisted and listed.
- Dedupe is stable for duplicate replay input normalization.
- `.kv` artifacts are created with required fields.

### Actual

From script output:
- `notRepoRoot: true`
- `listedRecords: 3` and `kvFileCount: 3` (includes duplicate replay record)
- `duplicateReplayMatchesOriginal: true`
- `improvementDiffersFromBug: true`
- `requiredFieldsPresentInFirstFile: true`

### Result

- PASS

## 5) Negative tests (invalid confidence, missing required fields, duplicate replay)

### Commands

```bash
pnpm --filter @composio/ao-core test -- src/__tests__/feedback-tools.test.ts -t "validates required fields for bug_report"
pnpm --filter @composio/ao-core test -- src/__tests__/feedback-tools.test.ts -t "rejects malformed confidence"
node /tmp/ao403-opclaw-smoke/feedback-smoke.mjs
```

### Expected

- Missing required fields rejected.
- Out-of-range confidence rejected.
- Duplicate replay does not collapse records implicitly, but dedupe key remains stable.

### Actual

- Required-fields test: `1 passed | 9 skipped`.
- Malformed-confidence test: `1 passed | 9 skipped`.
- Smoke output:
  - `invalidConfidenceRejected: true`
  - `missingRequiredFieldRejected: true`
  - `duplicateReplayStoredAsSeparateRecord: true`
  - Duplicate replay dedupe key matched original.

### Result

- PASS

## Direct OpenClaw dogfood: PASS/FAIL/NOT-POSSIBLE and reason

Status: PASS

### Commands and evidence

```bash
command -v openclaw
openclaw --version
openclaw --profile ao22-dogfood models set openai/gpt-4o-mini
openclaw --profile ao22-dogfood agent --local --agent main --message "Reply with READY only." --json
```

- `openclaw` available at `/usr/bin/openclaw`, version `2026.2.21-2`.
- A local agent turn succeeded (`READY`) after setting model to `openai/gpt-4o-mini`.

Real OpenClaw -> AO feedback flow command:

```bash
openclaw --profile ao22-dogfood agent --local --agent main --timeout 120 \
  --message "Execute this exact command: node /tmp/openclaw-ao403-flow-2/run.mjs . Return stdout only, unchanged." \
  --json
```

Independent verification commands:

```bash
ls -la /tmp/openclaw-ao403-flow-2/reports
for f in /tmp/openclaw-ao403-flow-2/reports/*.kv; do sed -n '1,40p' "$f"; done
node --input-type=module -e "import {FeedbackReportStore} from '/home/lifeos/.worktrees/ao/ao-22/packages/core/dist/index.js'; const s=new FeedbackReportStore('/tmp/openclaw-ao403-flow-2/reports'); const r=s.list(); console.log(JSON.stringify({count:r.length,tools:r.map(x=>x.tool),dedupeKeys:r.map(x=>x.dedupeKey)},null,2));"
```

Observed:
- 2 `.kv` files created by OpenClaw-triggered script.
- Stored tools: `bug_report`, `improvement_suggestion`.
- Dedupe keys were valid 16-char hex values and round-tripped through `list()`.

## Full focused suite command used

```bash
pnpm --filter @composio/ao-core test -- src/__tests__/feedback-tools.test.ts
```

Observed: `10 passed`.

## Residual risks

1. Validation is focused on core storage/contracts; no additional AO web/UI flows were exercised here.
2. OpenClaw agent runs are prompt-sensitive; independent post-run artifact checks were required to confirm side effects.
3. Duplicate replay behavior is key-stability + separate records (no auto-suppression), which is expected for current scope.

## Final recommendation

MERGE

Reason: all required validation blocks passed, direct OpenClaw dogfood succeeded with independent filesystem verification, and no new functional regressions were detected in PR #403 scope.
