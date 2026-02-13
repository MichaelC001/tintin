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
