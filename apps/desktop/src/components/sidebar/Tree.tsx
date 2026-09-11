import { AllThreads } from "./AllThreads";
import { ProjectTree } from "./ProjectTree";
import type { SidebarProps } from "./types";

export function Tree(props: SidebarProps) {
  return props.threadView === "all" ? <AllThreads {...props} /> : <ProjectTree {...props} />;
}
