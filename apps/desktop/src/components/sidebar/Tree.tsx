import { AllThreads } from "./AllThreads";
import { ProjectTree } from "./ProjectTree";
import type { SidebarProps } from "./types";

/** Sessions column is the cross-project inbox. The unused project-tree
 *  path stays for anything that still mounts Tree without `sessionsOnly`. */
export function Tree(props: SidebarProps) {
  return props.sessionsOnly ? <AllThreads {...props} /> : <ProjectTree {...props} />;
}
