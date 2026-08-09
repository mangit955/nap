"use client";

/**
 * The list, wired to the server and to the address bar.
 *
 * Split from `ProjectList` the way every pane in this app is split: the half that renders is
 * pure and is what the tests mount, and this half owns the requests and the navigation. There
 * is no way to render a router or a live `fetch` in jsdom that proves anything the two halves
 * do not already prove separately.
 *
 * Opening a project goes to `/p/<projectId>` rather than to a session: which conversation you
 * land in is the server's decision, and a link that named a session would go stale the moment
 * the project grew another one.
 */

import type { ProjectSummaryPayload } from "@nap/shared/projects-protocol";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { ProjectList } from "./project-list.tsx";
import { useProjects } from "./use-projects.ts";

export function LiveProjectList() {
  const router = useRouter();
  const { projects, status, actionError, create, close, remove } = useProjects();
  const [busyProjectId, setBusyProjectId] = useState<string | undefined>(undefined);

  /** Runs one action against one project, with that row held still while it is in flight. */
  const run = (projectId: string, action: (id: string) => Promise<void>) => {
    setBusyProjectId(projectId);
    void action(projectId).finally(() => setBusyProjectId(undefined));
  };

  return (
    <ProjectList
      projects={projects}
      status={status}
      actionError={actionError}
      busyProjectId={busyProjectId}
      onCreate={() => {
        void create().then((projectId) => {
          // Straight into the new project: nobody makes one in order to look at it in a list.
          if (projectId !== undefined) router.push(`/p/${projectId}`);
        });
      }}
      onOpen={(project: ProjectSummaryPayload) => router.push(`/p/${project.projectId}`)}
      onClose={(projectId) => run(projectId, close)}
      onDelete={(projectId) => run(projectId, remove)}
    />
  );
}
