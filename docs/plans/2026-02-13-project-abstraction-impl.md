# Project Abstraction Layer Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Introduce a `Project` abstraction that unifies repo and playground execution under a single entity, eliminating scattered playground conditionals and enabling playground feature parity.

**Architecture:** New `projects` table as the source of truth. All downstream code (cloud_runs, setup_specs, identities, WebSocket, controllers) references `project_id` instead of `repo_id`/`primary_repo_id`. manager.ts extracts 5 helper methods to eliminate ~200 lines of duplication across `startRun`, `restartCloudSession`, and `startRunWithWorkspace`.

**Tech Stack:** TypeScript, Kysely (ORM), Node.js test runner, SQLite

**Design doc:** `docs/plans/2026-02-13-project-abstraction-design.md`

---

### Task 1: Create Project type module

**Files:**
- Create: `src/runtime/cloud/project.ts`
- Test: `tests/cloud/project.test.ts`

**Step 1: Write the test**

```typescript
// tests/cloud/project.test.ts
import test from "node:test";
import assert from "node:assert/strict";
import { isPlayground, type Project, type ProjectType } from "../../src/runtime/cloud/project.js";

test("isPlayground returns true for playground projects", () => {
  const p: Project = { id: "p1", identityId: "i1", type: "playground", repoId: null, name: "playground" };
  assert.equal(isPlayground(p), true);
});

test("isPlayground returns false for repo projects", () => {
  const p: Project = { id: "p2", identityId: "i1", type: "repo", repoId: "r1", name: "my-app" };
  assert.equal(isPlayground(p), false);
});
```

**Step 2: Run test to verify it fails**

Run: `npm run build && node --test dist/tests/cloud/project.test.js`
Expected: FAIL (module not found)

**Step 3: Write the module**

```typescript
// src/runtime/cloud/project.ts
export type ProjectType = "repo" | "playground";

export interface Project {
  id: string;
  identityId: string;
  type: ProjectType;
  repoId: string | null;
  name: string;
}

export function isPlayground(project: Project): boolean {
  return project.type === "playground";
}
```

**Step 4: Run test to verify it passes**

Run: `npm run build && node --test dist/tests/cloud/project.test.js`
Expected: PASS

**Step 5: Commit**

```bash
git add src/runtime/cloud/project.ts tests/cloud/project.test.ts
git commit -m "feat(cloud): add Project type module"
```

---

### Task 2: Database migration — create projects table

**Files:**
- Create: `src/runtime/migrations/0028_projects.ts`
- Modify: `src/runtime/db.ts` (lines 123-134, 138-154, 264-272)

**Step 1: Add ProjectsTable interface to db.ts**

Add after the `ReposTable` interface (~line 134):

```typescript
export type ProjectType = "repo" | "playground";

export interface ProjectsTable {
  id: string;
  identity_id: string;
  type: string; // ProjectType
  repo_id: string | null;
  name: string;
  created_at: number;
  updated_at: number;
}
```

Add `projects: ProjectsTable` to the Database interface.

**Step 2: Update CloudRunsTable — add project_id**

In the `CloudRunsTable` interface (~line 138), add:

```typescript
project_id: string | null; // added, will become NOT NULL after backfill
```

Keep `primary_repo_id` for now (removed in a later task after backfill).

**Step 3: Update SetupSpecsTable — add project_id**

In the `SetupSpecsTable` interface (~line 264), add:

```typescript
project_id: string | null; // added, will become NOT NULL after backfill
```

Keep `repo_id` for now.

**Step 4: Update IdentitiesTable — add active_project_id**

Find the IdentitiesTable interface, add:

```typescript
active_project_id: string | null;
```

Keep `active_repo_id` for now.

**Step 5: Update CloudRunReposTable — make repo_id nullable**

Change `repo_id: string` to `repo_id: string | null` in the interface.

**Step 6: Write migration file**

```typescript
// src/runtime/migrations/0028_projects.ts
import type { Kysely } from "kysely";

export async function up(db: Kysely<any>): Promise<void> {
  // 1. Create projects table
  await db.schema
    .createTable("projects")
    .addColumn("id", "varchar(36)", (c) => c.primaryKey())
    .addColumn("identity_id", "varchar(36)", (c) => c.notNull())
    .addColumn("type", "varchar(16)", (c) => c.notNull())
    .addColumn("repo_id", "varchar(36)")
    .addColumn("name", "varchar(255)", (c) => c.notNull())
    .addColumn("created_at", "bigint", (c) => c.notNull())
    .addColumn("updated_at", "bigint", (c) => c.notNull())
    .execute();

  await db.schema.createIndex("projects_identity_idx").on("projects").column("identity_id").execute();
  await db.schema.createIndex("projects_repo_idx").on("projects").column("repo_id").execute();

  // 2. Add project_id to cloud_runs
  await db.schema.alterTable("cloud_runs").addColumn("project_id", "varchar(36)").execute();

  // 3. Add project_id to setup_specs
  await db.schema.alterTable("setup_specs").addColumn("project_id", "varchar(36)").execute();

  // 4. Add active_project_id to identities
  await db.schema.alterTable("identities").addColumn("active_project_id", "varchar(36)").execute();
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.alterTable("identities").dropColumn("active_project_id").execute();
  await db.schema.alterTable("setup_specs").dropColumn("project_id").execute();
  await db.schema.alterTable("cloud_runs").dropColumn("project_id").execute();
  await db.schema.dropTable("projects").execute();
}
```

**Step 7: Register migration**

Find the migrations registry file and add `0028_projects` to the list.

**Step 8: Run migration**

Run: `npm run build && npm run migrate`
Expected: Migration applied successfully

**Step 9: Commit**

```bash
git add src/runtime/db.ts src/runtime/migrations/0028_projects.ts
git commit -m "feat(db): add projects table and new columns for project abstraction"
```

---

### Task 3: Project store functions

**Files:**
- Modify: `src/runtime/cloud/store.ts`
- Test: `tests/cloud/project.test.ts` (extend)

**Step 1: Write failing tests**

Append to `tests/cloud/project.test.ts`:

```typescript
import { createProject, getProject, getOrCreatePlaygroundProject, listCloudRunsForProject } from "../../src/runtime/cloud/store.js";
// Use in-memory SQLite DB for tests — follow existing test patterns in the project

test("createProject creates a repo project", async () => {
  // Setup: create in-memory DB, run migrations
  // Call createProject with type="repo", repoId="r1"
  // Assert: returned project has correct fields
});

test("getOrCreatePlaygroundProject creates on first call, returns existing on second", async () => {
  // Call getOrCreatePlaygroundProject twice with same identityId
  // Assert: both return same id
});
```

Note: Check existing test patterns (e.g., `tests/cloud-config.test.ts`) for DB setup conventions. If no DB test helper exists, create a minimal one.

**Step 2: Write store functions**

Add to `src/runtime/cloud/store.ts`:

```typescript
import type { ProjectType } from "../db.js";

export async function createProject(db: Db, opts: {
  identityId: string;
  type: ProjectType;
  repoId: string | null;
  name: string;
}) {
  const now = nowMs();
  const id = crypto.randomUUID();
  await db.insertInto("projects").values({
    id,
    identity_id: opts.identityId,
    type: opts.type,
    repo_id: opts.repoId,
    name: opts.name,
    created_at: now,
    updated_at: now,
  }).execute();
  return await db.selectFrom("projects").selectAll().where("id", "=", id).executeTakeFirstOrThrow();
}

export async function getProject(db: Db, projectId: string) {
  return await db.selectFrom("projects").selectAll().where("id", "=", projectId).executeTakeFirst();
}

export async function getOrCreatePlaygroundProject(db: Db, identityId: string) {
  const existing = await db.selectFrom("projects").selectAll()
    .where("identity_id", "=", identityId)
    .where("type", "=", "playground")
    .executeTakeFirst();
  if (existing) return existing;
  return await createProject(db, { identityId, type: "playground", repoId: null, name: "playground" });
}

export async function getOrCreateRepoProject(db: Db, identityId: string, repoId: string, name: string) {
  const existing = await db.selectFrom("projects").selectAll()
    .where("identity_id", "=", identityId)
    .where("repo_id", "=", repoId)
    .executeTakeFirst();
  if (existing) return existing;
  return await createProject(db, { identityId, type: "repo", repoId, name });
}
```

**Step 3: Update existing store functions to support project_id**

Modify `putSetupSpec` — add `projectId` parameter:

```typescript
export async function putSetupSpec(db: Db, opts: { projectId: string; ymlBlob: string; hash: string }) {
  // Change repo_id references to project_id
}
```

Modify `getLatestSetupSpec` — change param from `repoId` to `projectId`:

```typescript
export async function getLatestSetupSpec(db: Db, projectId: string) {
  return await db.selectFrom("setup_specs").selectAll()
    .where("project_id", "=", projectId)
    .orderBy("created_at", "desc")
    .limit(1)
    .executeTakeFirst();
}
```

Modify `createCloudRun` — add `projectId` parameter:

```typescript
// In createCloudRun opts, add: projectId: string
// In the insert values, add: project_id: opts.projectId
```

Modify `addRunRepo` — make `repoId` nullable:

```typescript
export async function addRunRepo(db: Db, opts: { runId: string; repoId: string | null; mountPath: string }) {
```

Replace `listCloudRunsForRepo` + `listCloudRunsForPlayground` with:

```typescript
export async function listCloudRunsForProject(db: Db, projectId: string, limit = 20) {
  return await db.selectFrom("cloud_runs").selectAll()
    .where("project_id", "=", projectId)
    .orderBy("created_at", "desc")
    .limit(limit)
    .execute();
}
```

Fix `listRunRepoIds` — filter null repo_id values:

```typescript
export async function listRunRepoIds(db: Db, runId: string): Promise<string[]> {
  const rows = await db.selectFrom("cloud_run_repos").select("repo_id")
    .where("run_id", "=", runId).execute();
  return rows.map(r => r.repo_id).filter((id): id is string => id !== null);
}
```

**Step 4: Run tests**

Run: `npm run build && node --test dist/tests/cloud/project.test.js`
Expected: PASS

**Step 5: Typecheck**

Run: `npm run build`
Expected: No type errors (some callers may need updating in later tasks)

**Step 6: Commit**

```bash
git add src/runtime/cloud/store.ts tests/cloud/project.test.ts
git commit -m "feat(store): add project CRUD and migrate store functions to project_id"
```

---

### Task 4: manager.ts — extract 5 helper methods

**Files:**
- Modify: `src/runtime/cloud/manager.ts`

This task focuses on extracting helpers WITHOUT changing behavior. All existing logic stays identical.

**Step 1: Extract `getMainProjectPath`**

Add private method:

```typescript
private getMainProjectPath(
  mounts: Array<{ absPath: string }>,
  workspace: CloudWorkspace,
): string {
  return mounts.length > 0 ? mounts[0]!.absPath : workspace.rootPath;
}
```

Replace 3 call sites (lines 1101, 4004, 4625) with `this.getMainProjectPath(repoMounts, workspace)`.

**Step 2: Extract `discoverSetupSpec`**

Add private method:

```typescript
private async discoverSetupSpec(
  mainRepoAbsPath: string,
  projectId: string,
  existingSpec: SetupSpecsTable | null,
): Promise<SetupSpecsTable | null> {
  if (existingSpec) return existingSpec;
  const specPath = path.join(mainRepoAbsPath, "tintin-setup.yml");
  const specText = await readFile(specPath, "utf8").catch(() => null);
  if (!specText) return null;
  const hash = hashSetupSpec(specText);
  await putSetupSpec(this.db, { projectId, ymlBlob: specText, hash });
  return await getLatestSetupSpec(this.db, projectId) ?? null;
}
```

Replace 3 call sites (lines 1042-1050, 3946-3954, 4575-4583).

Note: The condition at each site varies slightly — `repoMounts.length > 0 && primaryRepoId && !setupSpec` etc. Move the `repoMounts.length > 0` guard to the caller; the helper only checks `existingSpec`.

**Step 3: Extract `applySetupSpec`**

Add private method:

```typescript
private async applySetupSpec(opts: {
  workspace: CloudWorkspace;
  setupSpec: SetupSpecsTable;
  cwd: string;
  identityId: string;
}): Promise<void> {
  const spec = parseSetupSpec(opts.setupSpec.yml_blob);
  const secrets = await this.time(
    "secrets.load",
    () => this.loadSecretsMap(opts.identityId),
    `identity=${opts.identityId}`,
    "debug",
  );
  const envVars: Record<string, string> = {};
  for (const entry of spec.env ?? []) {
    if (!entry.value) continue;
    envVars[entry.name] = interpolateSecrets(entry.value, (name) => secrets.get(name) ?? null);
  }

  if (spec.files && spec.files.length > 0) {
    const files = spec.files
      .filter((f) => f.content !== undefined)
      .map((f) => ({ path: f.path, content: f.content ?? "", mode: f.mode }));
    if (files.length > 0) {
      await this.time(
        "setupSpec.uploadFiles",
        () => this.provider.uploadFiles(opts.workspace, files),
        `files=${files.length}`,
      );
    }
  }

  const commands = spec.commands ?? [];
  if (commands.length > 0) {
    this.logger.info(`[cloud] applying setup spec commands count=${commands.length}`);
    await this.time(
      "setupSpec.runCommands",
      () => this.provider.runCommands({ workspace: opts.workspace, cwd: opts.cwd, commands, env: envVars }),
      `commands=${commands.length}`,
    );
  }
}
```

Replace 3 call sites (lines 1052-1087, 3956-3991, 4586-4621). Each caller retains its own snapshot/condition logic around the call.

**Step 4: Extract `initPlaygroundDir`**

Add private method (new — will be wired in Task 6):

```typescript
private async initPlaygroundDir(
  workspace: CloudWorkspace,
  runId: string,
): Promise<{ repoId: null; mountPath: string; absPath: string }> {
  const mountPath = path.posix.join("repo", "playground");
  const absPath = this.joinWorkspacePath(workspace.rootPath, mountPath);
  await this.provider.runCommands({
    workspace,
    cwd: workspace.rootPath,
    commands: [`mkdir -p ${absPath}`, `git init ${absPath}`],
    env: {},
  });
  await addRunRepo(this.db, { runId, repoId: null, mountPath });
  return { repoId: null, mountPath, absPath };
}
```

**Step 5: Extract `mountSingleRepo`**

Add private method:

```typescript
private async mountSingleRepo(opts: {
  workspace: CloudWorkspace;
  repoId: string;
  mountPath: string;
  absPath: string;
  cloneUrl: string;
  authHeader: string | null;
  mode: "clone" | "ensureRemote" | "refresh";
}): Promise<void> {
  switch (opts.mode) {
    case "clone":
      await this.cloneRepo({ workspace: opts.workspace, absPath: opts.absPath, cloneUrl: opts.cloneUrl, authHeader: opts.authHeader });
      break;
    case "ensureRemote":
      await this.ensureRepoRemote({ workspace: opts.workspace, absPath: opts.absPath, cloneUrl: opts.cloneUrl, authHeader: opts.authHeader });
      break;
    case "refresh":
      await this.refreshRepo({ workspace: opts.workspace, absPath: opts.absPath, cloneUrl: opts.cloneUrl, authHeader: opts.authHeader });
      break;
  }
}
```

Replace the inner loop bodies in startRun (1023-1037), restartCloudSession (3928-3942), startRunWithWorkspace (4565-4570). Each caller passes the appropriate `mode`.

**Step 6: Use `normalizeCloudProjectId` in all 3 methods**

Replace inline `primaryRepoId ? \`cloud:${primaryRepoId}\` : \`cloud:playground:${run.id}\`` at lines 1102 and 4626 with `this.normalizeCloudProjectId(run)`.

**Step 7: Build and run all tests**

Run: `npm run build && npm run test`
Expected: All existing tests pass (behavior unchanged)

**Step 8: Commit**

```bash
git add src/runtime/cloud/manager.ts
git commit -m "refactor(cloud): extract 5 helper methods from manager.ts to eliminate duplication"
```

---

### Task 5: Wire Project into manager.ts method signatures

**Files:**
- Modify: `src/runtime/cloud/manager.ts`
- Modify: `src/runtime/websocket/services/cloud.ts`
- Modify: `src/runtime/controller/cloudHandler.ts`

**Step 1: Update startRun signature**

Change:
```typescript
async startRun(opts: {
  // ...
  repoIds: string[];
  playground?: boolean;
  // ...
})
```

To:
```typescript
async startRun(opts: {
  // ...
  project: Project;
  repoIds: string[];  // keep for repo clone info
  // ...
})
```

Remove `playground?: boolean`. Replace `isPlayground` usage with `isPlayground(opts.project)`. Replace `primaryRepoId` with `opts.project.repoId`. Replace `createCloudRun({ primaryRepoId })` with `createCloudRun({ projectId: opts.project.id })`.

**Step 2: Update startRunWithWorkspace signature**

Same changes as Step 1.

**Step 3: Update restartCloudSession**

This method reads from DB, so it needs to resolve the project from `cloud_runs.project_id`:

```typescript
const project = await getProject(this.db, run.project_id!);
```

Replace `primaryRepoId` usage with `project.repoId`.

**Step 4: Update normalizeCloudProjectId**

```typescript
private normalizeCloudProjectId(run: CloudRunsTable): string {
  return run.project_id ? `cloud:${run.project_id}` : `cloud:playground:${run.id}`;
}
```

**Step 5: Wire playground init into startRun**

In the repo mounting section, add playground branch:

```typescript
const mounts: Array<{ repoId: string | null; mountPath: string; absPath: string }> = [];
if (isPlayground(opts.project)) {
  const mount = await this.initPlaygroundDir(workspace, run.id);
  mounts.push(mount);
} else if (opts.repoIds.length > 0) {
  // existing repo clone loop using mountSingleRepo
}
```

Apply the same pattern to `startRunWithWorkspace`.

**Step 6: Update handleSessionFinished (manager.ts:4322-4377)**

Remove the `if (run.primary_repo_id)` branch. Fix the existing bug at line 4334 where
`repo_id = ""` is queried for playground runs. Unified:

```typescript
// Before (buggy for playground: queries repo_id = "" which never matches)
const mount = await this.db.selectFrom("cloud_run_repos").selectAll()
  .where("run_id", "=", run.id)
  .where("repo_id", "=", run.primary_repo_id ?? "")
  .executeTakeFirst();

// After (query by run_id only, take first mount — works for both repo and playground)
const mount = await this.db.selectFrom("cloud_run_repos").selectAll()
  .where("run_id", "=", run.id)
  .orderBy("id", "asc")
  .executeTakeFirst();
const cwd = mount ? path.join(workspace.rootPath, mount.mount_path) : workspace.rootPath;
try {
  diff = await this.provider.pullDiff({ workspace, cwd });
} catch (e) {
  this.logger.warn(`[cloud] diff pull failed session=${sessionId}: ${String(e)}`);
}
```

**Step 7: Update detectLatestSnapshot and restoreSnapshot (manager.ts:408-536)**

These methods use `primary_repo_id` for snapshot queries and `listRunRepoIds` for
playground inference. Update to use `project_id`:

```typescript
// detectLatestSnapshot: change query to filter by project_id
// restoreSnapshot: replace `playground: repoIds.length === 0` with project type check
const project = await getProject(this.db, run.project_id!);
// pass project to startRun instead of playground boolean
```

**Step 8: Update all callers**

Modify `src/runtime/websocket/services/cloud.ts` to resolve project before calling startRun/startRunWithWorkspace:

```typescript
const project = isPlayground
  ? await getOrCreatePlaygroundProject(db, dbIdentityId)
  : await getOrCreateRepoProject(db, dbIdentityId, repoIds[0]!, repoName);
```

Modify `src/runtime/controller/cloudHandler.ts` action_run handler similarly.

**Step 8: Build and run all tests**

Run: `npm run build && npm run test`
Expected: All tests pass. Fix any type errors from changed signatures.

**Step 9: Commit**

```bash
git add src/runtime/cloud/manager.ts src/runtime/websocket/services/cloud.ts src/runtime/controller/cloudHandler.ts
git commit -m "feat(cloud): wire Project into manager method signatures and add playground init"
```

---

### Task 6: Eliminate playground conditionals from controllers

**Files:**
- Modify: `src/runtime/controller/commands.ts`
- Modify: `src/runtime/controller/cloudHandler.ts`
- Modify: `src/locales/en.ts`
- Modify: `src/locales/zh.ts`

**Step 1: Update commands.ts**

- Delete `PLAYGROUND_REPO_ID` constant (line 4)
- Delete `isPlaygroundRepoId()` function (lines 120-122)
- Keep `isPlaygroundTarget()` (lines 124+) — still needed for user input parsing
- Add: `export { isPlayground } from "../cloud/project.js";`

**Step 2: Update cloudHandler.ts — replace all isPlaygroundRepoId checks**

For each of the 6 locations, replace the pattern. Example for `repo_current` (line 973):

```typescript
// Before
if (isPlaygroundRepoId(identity.active_repo_id)) { ... }

// After
const project = identity.active_project_id
  ? await getProject(this.deps.db, identity.active_project_id)
  : null;
if (project && isPlayground(project)) { ... }
```

For `repo_select` (line 953-954):

```typescript
// Before
await setIdentityActiveRepo(this.deps.db, identity.id, PLAYGROUND_REPO_ID);

// After
const playgroundProject = await getOrCreatePlaygroundProject(this.deps.db, identity.id);
await setIdentityActiveProject(this.deps.db, identity.id, playgroundProject.id);
```

For `setup_status` (line 1346): Remove the playground block — now works for both types.

For `setup_lift` (line 1363):

```typescript
// Before
if (isPlaygroundRepoId(identity.active_repo_id)) {
  await replyText("setup.playground_no_repo_lift");
  return true;
}

// After
if (project && isPlayground(project)) {
  await replyText("setup.lift_requires_repo");
  return true;
}
```

**Step 3: Update action_run handler (lines 1262-1274)**

```typescript
// Before: complex playground inference from active_repo_id
// After:
const project = identity.active_project_id
  ? await getProject(this.deps.db, identity.active_project_id)
  : await getOrCreatePlaygroundProject(this.deps.db, identity.id);
const repoIds = project.repoId ? [project.repoId] : [];
```

**Step 4: Update locale files**

In `src/locales/en.ts`:
- Delete: `"setup.playground_no_repo_manage"`
- Delete: `"setup.playground_no_repo_lift"`
- Add: `"setup.lift_requires_repo": "Setup lift requires a repo project. Select a repo first."`

Same changes in `src/locales/zh.ts`.

**Step 5: Build and run all tests**

Run: `npm run build && npm run test`
Expected: PASS

**Step 6: Commit**

```bash
git add src/runtime/controller/commands.ts src/runtime/controller/cloudHandler.ts src/locales/en.ts src/locales/zh.ts
git commit -m "refactor(controller): replace playground conditionals with Project type checks"
```

---

### Task 7: Update WebSocket layer

**Files:**
- Modify: `src/runtime/websocket/types.ts`
- Modify: `src/runtime/websocket/services/cloud.ts`
- Modify: `src/runtime/cloud/githubWebhook.ts` (calls `addRunRepo`, references `active_repo_id`)
- Test: `tests/websocket/cloud-service.test.ts`
- Test: `tests/e2e/agents-md-e2e.test.ts` (uses `repoIds: []` in WebSocket messages)

**Step 1: Update CloudRunMessage type**

```typescript
// Before
export interface CloudRunMessage {
  type: 'cloud_run';
  chatId: string;
  repoIds?: string[];
  // ...
}

// After
export interface CloudRunMessage {
  type: 'cloud_run';
  chatId: string;
  projectId: string;
  // ...
}
```

**Step 2: Update CloudRunService.handleCloudRun**

Remove `isPlayground` inference. Instead:

```typescript
const project = await getProject(db, message.projectId);
if (!project) throw new Error("Project not found");
const repoIds = project.repoId ? [project.repoId] : [];
```

Remove `isPlayground` from status messages — use `isPlayground(project)`.

Remove `playground: isPlayground` from startRun/startRunWithWorkspace calls — pass `project` instead.

**Step 3: Update githubWebhook.ts**

Update `addRunRepo` call at line 67 to pass nullable `repoId`. Update any `active_repo_id` references to `active_project_id`:

```typescript
// Update addRunRepo call to match new signature (repoId is now nullable)
await addRunRepo(db, { runId, repoId: repoId ?? null, mountPath });

// Update active_repo_id references (~line 389-390)
// Before: identity.active_repo_id
// After: identity.active_project_id (resolve project from project_id)
```

**Step 4: Update existing tests**

In `tests/websocket/cloud-service.test.ts`, update mock `CloudRunMessage` to use `projectId` instead of `repoIds`.

In `tests/e2e/agents-md-e2e.test.ts`, update 3 test cases that use `repoIds: []` to use `projectId`:

```typescript
// Before
{ type: "cloud_run", repoIds: [], ... }

// After
{ type: "cloud_run", projectId: "<playground-project-id>", ... }
```

**Step 5: Build and run tests**

Run: `npm run build && npm run test`
Expected: PASS

**Step 6: Commit**

```bash
git add src/runtime/websocket/types.ts src/runtime/websocket/services/cloud.ts src/runtime/cloud/githubWebhook.ts tests/websocket/cloud-service.test.ts tests/e2e/agents-md-e2e.test.ts
git commit -m "refactor(websocket): replace repoIds with projectId in CloudRunMessage"
```

---

### Task 8: Update API routes and cleanup logic

**Files:**
- Modify: `src/runtime/service/http/cloudApiRoutes.ts`
- Modify: `src/runtime/cloud/disconnectCleanup.ts`

**Step 1: Update cloudApiRoutes.ts**

Find artifact baseline resolution (~line 344). Replace:

```typescript
// Before
const mount = run.primary_repo_id
  ? await db.selectFrom("cloud_run_repos")...where("repo_id", "=", run.primary_repo_id)...
  : null;

// After
const mount = await db.selectFrom("cloud_run_repos").selectAll()
  .where("run_id", "=", run.id)
  .orderBy("id", "asc")
  .executeTakeFirst();
```

**Step 2: Update disconnectCleanup.ts**

Replace `primary_repo_id` queries with `project_id`-based queries:

```typescript
// Find projects linked to these repos
const projects = await db.selectFrom("projects").select(["id"])
  .where("repo_id", "in", repoIds)
  .execute();
const projectIds = projects.map(p => p.id);

// Find runs for these projects
const runs = await db.selectFrom("cloud_runs").select(["id"])
  .where("project_id", "in", projectIds)
  .execute();
```

Replace the bulk update:

```typescript
// Before
await trx.updateTable("cloud_runs").set({ primary_repo_id: null }).where("primary_repo_id", "in", repoIds).execute();

// After
await trx.updateTable("cloud_runs").set({ project_id: null }).where("project_id", "in", projectIds).execute();
```

**Step 3: Build**

Run: `npm run build`
Expected: No type errors

**Step 4: Commit**

```bash
git add src/runtime/service/http/cloudApiRoutes.ts src/runtime/cloud/disconnectCleanup.ts
git commit -m "refactor(api): update API routes and cleanup to use project_id"
```

---

### Task 9: Update frontend

**Files:**
- Modify: `frontend/src/types.ts`
- Modify: `frontend/src/components/RunListPage.tsx`

**Step 1: Update RunSummary type**

```typescript
// Before
export interface RunSummary {
  primary_repo_id: string | null;
  // ...
}

// After
export interface RunSummary {
  project_id: string | null;
  project_name: string | null;
  project_type: string | null; // "repo" | "playground"
  // ...
}
```

**Step 2: Update RunListPage.tsx display**

```typescript
// Before (line 53)
<span>Repo: {run.primary_repo_id ?? "Playground"}</span>

// After
<span>Project: {run.project_name ?? "Unknown"}</span>
```

**Step 3: Update API response in cloudApiRoutes.ts**

Ensure the runs list query joins with projects table to include `project_name` and `project_type` in the response.

**Step 4: Build frontend**

Run: `cd frontend && npm run build` (or equivalent)
Expected: No type errors

**Step 5: Commit**

```bash
git add frontend/src/types.ts frontend/src/components/RunListPage.tsx src/runtime/service/http/cloudApiRoutes.ts
git commit -m "feat(frontend): display project name instead of repo ID in run list"
```

---

### Task 10: Drop old columns — final migration

**Files:**
- Create: `src/runtime/migrations/0029_drop_old_repo_columns.ts`
- Modify: `src/runtime/db.ts`

**Step 1: Write migration**

```typescript
// src/runtime/migrations/0029_drop_old_repo_columns.ts
import type { Kysely } from "kysely";

export async function up(db: Kysely<any>): Promise<void> {
  // Drop old columns
  await db.schema.alterTable("cloud_runs").dropColumn("primary_repo_id").execute();
  await db.schema.alterTable("setup_specs").dropColumn("repo_id").execute();
  await db.schema.alterTable("identities").dropColumn("active_repo_id").execute();
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.alterTable("identities").addColumn("active_repo_id", "varchar(36)").execute();
  await db.schema.alterTable("setup_specs").addColumn("repo_id", "varchar(36)").execute();
  await db.schema.alterTable("cloud_runs").addColumn("primary_repo_id", "varchar(36)").execute();
}
```

**Step 2: Remove old fields from db.ts interfaces**

- `CloudRunsTable`: remove `primary_repo_id`, make `project_id` non-nullable
- `SetupSpecsTable`: remove `repo_id`, make `project_id` non-nullable
- `IdentitiesTable`: remove `active_repo_id`

**Step 3: Register migration and run**

Run: `npm run build && npm run migrate`
Expected: Migration applied

**Step 4: Full test suite**

Run: `npm run test`
Expected: All tests pass

**Step 5: Commit**

```bash
git add src/runtime/migrations/0029_drop_old_repo_columns.ts src/runtime/db.ts
git commit -m "chore(db): drop legacy primary_repo_id, repo_id, active_repo_id columns"
```

---

### Task 11: Final verification and cleanup

**Step 1: Grep for any remaining references to old concepts**

```bash
grep -r "primary_repo_id\|PLAYGROUND_REPO_ID\|isPlaygroundRepoId\|active_repo_id" src/ --include="*.ts" -l
```

Expected: No matches (only in migration files)

**Step 2: Grep for remaining `isPlayground` inference patterns**

```bash
grep -rn "repoIds.length === 0" src/ --include="*.ts"
```

Expected: No matches

**Step 3: Run full build and tests**

Run: `npm run build && npm run test`
Expected: All pass

**Step 4: Typecheck**

Run: `npm run typecheck`
Expected: No errors

**Step 5: Commit any remaining cleanup**

```bash
git add -A
git commit -m "chore: final cleanup of legacy playground references"
```
