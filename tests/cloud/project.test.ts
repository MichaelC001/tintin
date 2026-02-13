import test, { describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { Kysely, SqliteDialect } from "kysely";
import Database from "better-sqlite3";
import type { DatabaseSchema } from "../../src/runtime/db.js";
import { runMigrations } from "../../src/runtime/migrations.js";
import { isPlayground, type Project, type ProjectType } from "../../src/runtime/cloud/project.js";
import {
  createProject,
  getProject,
  getOrCreatePlaygroundProject,
  getOrCreateRepoProject,
  listCloudRunsForProject,
  createCloudRun,
  getOrCreateIdentity,
} from "../../src/runtime/cloud/store.js";

const noopLogger = { info() {}, warn() {}, error() {}, debug() {} } as any;

test("isPlayground returns true for playground projects", () => {
  const p: Project = { id: "p1", identityId: "i1", type: "playground", repoId: null, name: "playground" };
  assert.equal(isPlayground(p), true);
});

test("isPlayground returns false for repo projects", () => {
  const p: Project = { id: "p2", identityId: "i1", type: "repo", repoId: "r1", name: "my-app" };
  assert.equal(isPlayground(p), false);
});

describe("Project store functions", () => {
  let db: Kysely<DatabaseSchema>;

  before(async () => {
    db = new Kysely<DatabaseSchema>({
      dialect: new SqliteDialect({ database: new Database(":memory:") }),
    });
    await runMigrations(db, noopLogger);
  });

  after(async () => {
    await db.destroy();
  });

  test("createProject creates a repo project", async () => {
    const identity = await getOrCreateIdentity(db, { platform: "test", workspaceId: null, userId: "u1" });
    const project = await createProject(db, {
      identityId: identity.id,
      type: "repo",
      repoId: "r1",
      name: "my-app",
    });
    assert.equal(project.type, "repo");
    assert.equal(project.repo_id, "r1");
    assert.equal(project.name, "my-app");
    assert.equal(project.identity_id, identity.id);
  });

  test("createProject creates a playground project", async () => {
    const identity = await getOrCreateIdentity(db, { platform: "test", workspaceId: null, userId: "u2" });
    const project = await createProject(db, {
      identityId: identity.id,
      type: "playground",
      repoId: null,
      name: "playground",
    });
    assert.equal(project.type, "playground");
    assert.equal(project.repo_id, null);
    assert.equal(project.name, "playground");
  });

  test("getProject returns project by id", async () => {
    const identity = await getOrCreateIdentity(db, { platform: "test", workspaceId: null, userId: "u3" });
    const created = await createProject(db, {
      identityId: identity.id,
      type: "repo",
      repoId: "r2",
      name: "other-app",
    });
    const fetched = await getProject(db, created.id);
    assert.ok(fetched);
    assert.equal(fetched.id, created.id);
    assert.equal(fetched.name, "other-app");
  });

  test("getProject returns undefined for unknown id", async () => {
    const result = await getProject(db, "nonexistent-id");
    assert.equal(result, undefined);
  });

  test("getOrCreatePlaygroundProject creates on first call, returns existing on second", async () => {
    const identity = await getOrCreateIdentity(db, { platform: "test", workspaceId: null, userId: "u4" });
    const first = await getOrCreatePlaygroundProject(db, identity.id);
    const second = await getOrCreatePlaygroundProject(db, identity.id);
    assert.equal(first.id, second.id);
    assert.equal(first.type, "playground");
    assert.equal(first.repo_id, null);
  });

  test("getOrCreateRepoProject creates on first call, returns existing on second", async () => {
    const identity = await getOrCreateIdentity(db, { platform: "test", workspaceId: null, userId: "u5" });
    const first = await getOrCreateRepoProject(db, identity.id, "r3", "my-repo");
    const second = await getOrCreateRepoProject(db, identity.id, "r3", "my-repo");
    assert.equal(first.id, second.id);
    assert.equal(first.type, "repo");
    assert.equal(first.repo_id, "r3");
  });

  test("listCloudRunsForProject returns runs for a project", async () => {
    const identity = await getOrCreateIdentity(db, { platform: "test", workspaceId: null, userId: "u6" });
    const project = await createProject(db, {
      identityId: identity.id,
      type: "playground",
      repoId: null,
      name: "playground",
    });
    await createCloudRun(db, {
      identityId: identity.id,
      projectId: project.id,
      provider: "modal",
      workspaceId: "ws1",
      status: "running",
      prompt: "test prompt",
    });
    const runs = await listCloudRunsForProject(db, project.id);
    assert.equal(runs.length, 1);
    assert.equal(runs[0]!.project_id, project.id);
  });
});
