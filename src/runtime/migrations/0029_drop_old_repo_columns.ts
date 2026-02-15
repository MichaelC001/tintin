import { sql, type Kysely } from "kysely";

export async function up(db: Kysely<any>): Promise<void> {
  await db.schema.alterTable("cloud_runs").dropColumn("primary_repo_id").execute();
  await db.schema.alterTable("identities").dropColumn("active_repo_id").execute();

  // SQLite cannot drop a column that's part of a UNIQUE constraint.
  // Recreate setup_specs without the repo_id column.
  await sql`CREATE TABLE "setup_specs_new" (
    "id" varchar(36) PRIMARY KEY,
    "yml_blob" text NOT NULL,
    "hash" varchar(64) NOT NULL,
    "created_at" bigint NOT NULL,
    "updated_at" bigint NOT NULL,
    "snapshot_id" varchar(128),
    "project_id" varchar(36),
    CONSTRAINT "setup_specs_unique" UNIQUE ("project_id", "hash")
  )`.execute(db);
  await sql`INSERT INTO "setup_specs_new" ("id", "yml_blob", "hash", "created_at", "updated_at", "snapshot_id", "project_id")
    SELECT "id", "yml_blob", "hash", "created_at", "updated_at", "snapshot_id", "project_id" FROM "setup_specs"`.execute(db);
  await sql`DROP TABLE "setup_specs"`.execute(db);
  await sql`ALTER TABLE "setup_specs_new" RENAME TO "setup_specs"`.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.alterTable("identities").addColumn("active_repo_id", "varchar(36)").execute();
  await db.schema.alterTable("cloud_runs").addColumn("primary_repo_id", "varchar(36)").execute();

  // Recreate setup_specs with repo_id column
  await sql`CREATE TABLE "setup_specs_new" (
    "id" varchar(36) PRIMARY KEY,
    "repo_id" varchar(36),
    "yml_blob" text NOT NULL,
    "hash" varchar(64) NOT NULL,
    "created_at" bigint NOT NULL,
    "updated_at" bigint NOT NULL,
    "snapshot_id" varchar(128),
    "project_id" varchar(36),
    CONSTRAINT "setup_specs_unique" UNIQUE ("repo_id", "hash")
  )`.execute(db);
  await sql`INSERT INTO "setup_specs_new" ("id", "yml_blob", "hash", "created_at", "updated_at", "snapshot_id", "project_id")
    SELECT "id", "yml_blob", "hash", "created_at", "updated_at", "snapshot_id", "project_id" FROM "setup_specs"`.execute(db);
  await sql`DROP TABLE "setup_specs"`.execute(db);
  await sql`ALTER TABLE "setup_specs_new" RENAME TO "setup_specs"`.execute(db);
}
