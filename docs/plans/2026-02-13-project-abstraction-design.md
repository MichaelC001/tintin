# Project Abstraction Layer Design

## Overview

Introduce a `Project` abstraction as the first-class entity for cloud execution, unifying repo-backed and playground projects. This eliminates scattered playground conditional logic, enables playground to have feature parity with repo projects (directory structure, diff/snapshot, setup spec), and aligns with mainstream cloud IDE architecture (Replit, CodeSandbox, Gitpod).

## Motivation

### Current Problems

1. **Playground represented 3 different ways:**
   - User preference: `identity.active_repo_id = "__playground__"` (sentinel string)
   - Database: `cloud_runs.primary_repo_id = NULL`
   - WebSocket: `repoIds.length === 0` (implicit inference)

2. **Feature gaps in playground mode:**
   - No isolated subdirectory (agent works in workspace root)
   - No git tracking (diff always returns placeholder text)
   - Setup specs blocked (`setup_specs.repo_id` is NOT NULL)

3. **Code duplication in manager.ts:**
   - `startRun`, `restartCloudSession`, `startRunWithWorkspace` share ~200 lines of near-identical logic
   - Setup spec loading: 9 lines duplicated 3 times
   - Setup spec application: 35 lines duplicated 3 times
   - `mainRepoPath` fallback: duplicated 3 times
   - `projectId` construction: duplicated 2 times (+ 1 helper that exists but is unused)

4. **6 scattered `isPlaygroundRepoId` checks** in cloudHandler.ts

## Design

### 1. Data Model

**New `projects` table:**

```typescript
export type ProjectType = "repo" | "playground";

export interface ProjectsTable {
  id: string;              // UUID
  identity_id: string;     // FK -> identities
  type: ProjectType;       // "repo" | "playground"
  repo_id: string | null;  // FK -> repos (only when type="repo")
  name: string;            // Display name: "my-app" or "playground"
  created_at: number;
  updated_at: number;
}
// Constraint: UNIQUE(identity_id, repo_id)
```

**Modified existing tables:**

| Table | Old Field | New Field |
|-------|-----------|-----------|
| `cloud_runs` | `primary_repo_id: string \| null` | `project_id: string` (NOT NULL, FK -> projects) |
| `setup_specs` | `repo_id: string` | `project_id: string` (NOT NULL, FK -> projects) |
| `identities` | `active_repo_id: string \| null` | `active_project_id: string \| null` (FK -> projects) |
| `cloud_run_repos` | `repo_id: string` (NOT NULL) | `repo_id: string \| null` (nullable for playground) |

**Deleted concepts:**
- `PLAYGROUND_REPO_ID = "__playground__"` constant
- `isPlaygroundRepoId()` function
- `cloud_runs.primary_repo_id` column
- `setup_specs.repo_id` column

### 2. Playground Directory Structure & Git Init

**Unified directory layout:**

| Scenario | mount_path | Agent cwd |
|----------|-----------|-----------|
| Repo project | `repo/{slug}` | `workspace/repo/{slug}/` |
| Playground | `repo/playground` | `workspace/repo/playground/` |

**Playground initialization (replaces git clone):**

```typescript
mkdir repo/playground
git init  // enables pullDiff to track changes
```

**Eliminates the diff branching in handleSessionFinished:**

```typescript
// Before (2 branches)
if (run.primary_repo_id) {
  diff = await this.provider.pullDiff({ workspace, cwd });
} else {
  diff = { diff: "", summary: "Playground run (no repo attached)." };
}

// After (unified)
diff = await this.provider.pullDiff({ workspace, cwd });
```

### 3. Setup Spec Support for Playground

- `setup_specs` table changes `repo_id` -> `project_id`, enabling playground projects to have setup specs
- `setup status` command: works for both project types (no more playground blocking)
- `setup lift` command: remains repo-only (requires source code to analyze), uses `project.type` check instead of `isPlaygroundRepoId`
- Setup spec application logic is project-type agnostic (env, files, commands work the same)

### 4. manager.ts Refactoring

**Three methods with duplicated code:**

| Method | Purpose | Workspace Lifecycle |
|--------|---------|-------------------|
| `startRun` | Standard cloud run | Self-created (supports snapshot restore) |
| `restartCloudSession` | Restart existing session | Self-created (supports snapshot restore) |
| `startRunWithWorkspace` | Run in connection-bound workspace | Externally provided |

**Five extracted helper methods:**

```typescript
// 1. Playground directory init (new)
private async initPlaygroundDir(
  workspace: CloudWorkspace,
  runId: string,
): Promise<{ mountPath: string; absPath: string }>

// 2. Single repo mount operation (extract inner loop)
private async mountSingleRepo(opts: {
  workspace: CloudWorkspace;
  repoId: string;
  mountPath: string;
  absPath: string;
  mode: "clone" | "ensureRemote" | "refresh";
}): Promise<void>

// 3. Load setup spec from repo file (3x exact duplicate)
private async discoverSetupSpec(
  mainRepoAbsPath: string,
  projectId: string,
  existingSpec: SetupSpecsTable | null,
): Promise<SetupSpecsTable | null>

// 4. Apply setup spec - env + files + commands (3x core logic same)
private async applySetupSpec(opts: {
  workspace: CloudWorkspace;
  setupSpec: SetupSpecsTable;
  cwd: string;
  identityId: string;
}): Promise<void>

// 5. Main project path (3x exact duplicate)
private getMainProjectPath(
  mounts: Array<{ absPath: string }>,
  workspace: CloudWorkspace,
): string
```

**Preserved differences (NOT merged into helpers):**

| Difference | Reason |
|-----------|--------|
| Workspace creation/provision | Fundamentally different lifecycles |
| Repo source (opts vs DB) | Different data sources |
| Whether to call addRunRepo | restart doesn't need it (records exist) |
| mountSingleRepo mode parameter | Each method chooses by its own semantics |
| Post-setup snapshot creation | Connection-bound workspace doesn't need it |
| Error handling and cleanup | Each method owns different resources |

### 5. Eliminated Playground Branching

**Deleted:**
- `PLAYGROUND_REPO_ID` constant (commands.ts)
- `isPlaygroundRepoId()` function (commands.ts)
- 6x `isPlaygroundRepoId` checks (cloudHandler.ts)
- 3x `isPlayground` inference (cloud.ts, manager.ts)
- `listCloudRunsForRepo` + `listCloudRunsForPlayground` (store.ts) -> unified `listCloudRunsForProject`
- `playground?: boolean` parameter in startRun/startRunWithWorkspace

**Retained (with semantic change):**
- `isPlaygroundTarget()`: kept for user input parsing ("playground", "none", "0" etc.), returns intent not repo ID

**WebSocket protocol:**

```typescript
// Before
interface CloudRunMessage {
  repoIds?: string[];     // empty = playground (implicit)
}

// After
interface CloudRunMessage {
  projectId: string;      // explicit project reference
}
```

### 6. Database Migration (0027_projects.ts)

**Execution order:**

```
1. Create projects table
2. Generate project records from existing data
3. Add project_id to cloud_runs, backfill, drop primary_repo_id
4. Add project_id to setup_specs, backfill, drop repo_id
5. Add active_project_id to identities, backfill, drop active_repo_id
6. Make cloud_run_repos.repo_id nullable
```

## File Change Summary

| File | Change Type | Description |
|------|-------------|-------------|
| `src/runtime/cloud/project.ts` | **New** | Project type, ProjectType, getActiveProject, isPlayground |
| `src/runtime/migrations/0027_projects.ts` | **New** | Migration: projects table + backfill + drop old columns |
| `src/runtime/db.ts` | Modify | Add ProjectsTable; update CloudRunsTable, SetupSpecsTable, IdentitiesTable, CloudRunReposTable |
| `src/runtime/cloud/store.ts` | Modify | Add project CRUD; unify run queries; update setup spec functions |
| `src/runtime/cloud/manager.ts` | Modify | Add 5 helpers; update method signatures; remove playground branches |
| `src/runtime/controller/commands.ts` | Modify | Delete PLAYGROUND_REPO_ID, isPlaygroundRepoId |
| `src/runtime/controller/cloudHandler.ts` | Modify | Replace 6 isPlaygroundRepoId checks with project.type |
| `src/runtime/websocket/types.ts` | Modify | CloudRunMessage: repoIds -> projectId |
| `src/runtime/websocket/services/cloud.ts` | Modify | Remove isPlayground inference; use project object |
| `src/runtime/cloud/disconnectCleanup.ts` | Modify | primary_repo_id queries -> project_id |
| `src/runtime/service/http/cloudApiRoutes.ts` | Modify | Artifact path resolution via project_id |
| `frontend/src/types.ts` | Modify | RunSummary: primary_repo_id -> project_id, project_name, project_type |
| `frontend/src/components/RunListPage.tsx` | Modify | Display project_name |
| `src/locales/en.ts` | Modify | Remove playground block messages; add setup.lift_requires_repo |
| `src/locales/zh.ts` | Modify | Same as en.ts |
| `src/runtime/cloud/lift.ts` | No change | generateSetupSpecFromPath is project-agnostic |
| `src/runtime/cloud/setupSpec.ts` | No change | Parse/stringify logic is project-agnostic |

**Total: 2 new files, 15 modified files, 0 deleted files**

## Appendix: Review Corrections (2026-02-13)

### A. Mainstream Platform Alignment

Our design follows the **CodeSandbox Hybrid** pattern (standalone sandbox + repo-backed project coexist under a unified entity). Compared to 5 mainstream platforms (Replit, CodeSandbox, Gitpod, GitHub Codespaces, StackBlitz), the design is well-aligned. No structural changes needed.

### B. Identified Gaps (post-review)

#### B.1 Bug: `manager.ts:4334` — empty string query for playground mounts

Current code queries `cloud_run_repos` with `repo_id = ""` when `primary_repo_id` is null, which always returns nothing. After migration, playground mounts will have `repo_id = null`. Fix: query by `run_id` only, take first mount.

#### B.2 `listRunRepoIds` needs null filtering

`store.ts:441` returns `repo_id[]`. After making `repo_id` nullable, the return type becomes `(string | null)[]`. Callers like `restoreSnapshot` expect `string[]`. Fix: filter null values.

#### B.3 `detectLatestSnapshot` and `restoreSnapshot` not covered

`manager.ts:408-536` — these methods use `primary_repo_id` for snapshot queries and `listRunRepoIds` for playground inference. Must be updated to use `project_id`.

#### B.4 `githubWebhook.ts` has `addRunRepo` call

`src/runtime/cloud/githubWebhook.ts:67` — additional caller of `addRunRepo` not in original file list. Must be updated when `addRunRepo` signature changes.

#### B.5 `tests/e2e/agents-md-e2e.test.ts` uses `repoIds: []`

3 test cases use old WebSocket message format. Must be updated in Task 7.

### C. Additional Files to Modify

| File | Reason |
|------|--------|
| `src/runtime/cloud/githubWebhook.ts` | Calls `addRunRepo`, references `active_repo_id` |
| `tests/e2e/agents-md-e2e.test.ts` | Uses `repoIds: []` in WebSocket messages |

### D. Unchanged Tables (confirmed)

- `shared_repos` — repo-level sharing in TG/Slack chats. Stays as-is (repo_id, not project_id). This is correct because sharing is about giving chat access to a specific git repo, not about the project abstraction.
