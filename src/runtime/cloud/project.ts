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
