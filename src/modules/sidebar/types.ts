// SSH, Docker, and S3 are now main-editor tabs (not sidebar views), so they are
// no longer part of this union.
export type SidebarViewId =
  | "explorer"
  | "source-control"
  | "projects";
