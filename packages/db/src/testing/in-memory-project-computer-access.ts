import type {
  ComputerAdmissionError,
  ComputerReservation,
  ComputerReservationRequest,
  ComputerScopeIdentity,
  ProjectComputerAccess,
} from "@nap/shared/ports/project-computer-access";
import type { Result } from "@nap/shared/result";
import type { InMemoryTurnQueue } from "./in-memory-turn-queue.ts";

type Project = {
  projectId: string;
  userId: string;
  sandboxId: string | null;
  revision: string;
  sessionIds: string[];
};
export class InMemoryProjectComputerAccess implements ProjectComputerAccess {
  readonly projects = new Map<string, Project>();
  readonly reservations = new Map<string, ComputerReservation>();
  readonly now: () => number;
  constructor(
    readonly queue?: InMemoryTurnQueue,
    now: () => number = Date.now,
  ) {
    this.now = now;
    queue?.attachComputerAccess(this);
  }
  setProject(project: Omit<Project, "revision"> & { revision?: string }): void {
    this.projects.set(project.projectId, {
      ...project,
      revision: project.revision ?? crypto.randomUUID(),
    });
  }
  projectForSession(sessionId: string): Project | undefined {
    return [...this.projects.values()].find((project) => project.sessionIds.includes(sessionId));
  }
  blocked(projectId: string): boolean {
    return this.reservations.has(projectId);
  }
  claimed(sessionId: string): void {
    const project = this.projectForSession(sessionId);
    if (project) project.revision = crypto.randomUUID();
  }
  async occupied(projectId: string): Promise<boolean> {
    return this.blocked(projectId);
  }
  async read(request: {
    projectId: string;
    userId: string;
  }): ReturnType<ProjectComputerAccess["read"]> {
    const project = this.projects.get(request.projectId);
    if (!project || project.userId !== request.userId) return denied("not_found");
    if (this.blocked(project.projectId)) return denied("recovery_pending");
    if (this.queue?.computerLeases().some((row) => project.sessionIds.includes(row.sessionId)))
      return denied("busy");
    return { ok: true, value: { sandboxId: project.sandboxId, revision: project.revision } };
  }
  async reserve(request: ComputerReservationRequest): ReturnType<ProjectComputerAccess["reserve"]> {
    const project = this.projects.get(request.projectId);
    if (!project) return denied("not_found");
    if (this.blocked(project.projectId)) return denied("recovery_pending");
    if (project.sandboxId !== request.sandboxId) return denied("stale_grant");
    const leases =
      this.queue?.computerLeases().filter((row) => project.sessionIds.includes(row.sessionId)) ??
      [];
    if (request.actor.kind === "owner") {
      const b = request.actor.binding;
      if (b.userId !== project.userId) return denied("not_found");
      if (
        b.projectId !== project.projectId ||
        b.sandboxId !== project.sandboxId ||
        !project.sessionIds.includes(b.sessionId) ||
        b.revision !== project.revision ||
        b.expiresAt <= this.now()
      )
        return denied("stale_grant");
      if (leases.length) return denied("busy");
    } else {
      const actor = request.actor;
      const owned = leases.find(
        (row) =>
          row.id === actor.lease.requestId &&
          row.leaseOwner === actor.lease.owner &&
          !row.cancelRequested &&
          (row.leaseExpiresAt ?? 0) > this.now(),
      );
      if (!owned || leases.some((row) => row.id !== owned.id)) return denied("busy");
    }
    const row: ComputerReservation = {
      ...request,
      state: "active",
      createdAt: new Date(this.now()).toISOString(),
      nextRecoveryAt: new Date(this.now() + 15_000).toISOString(),
    };
    this.reservations.set(project.projectId, row);
    return { ok: true, value: structuredClone(row) };
  }
  async markRecovering(scope: ComputerScopeIdentity): Promise<void> {
    const row = this.reservations.get(scope.projectId);
    if (row?.scopeId === scope.scopeId && row.sandboxId === scope.sandboxId) {
      row.state = "recovering";
      const project = this.projects.get(scope.projectId);
      if (project) project.revision = crypto.randomUUID();
    }
  }
  async clear(scope: Parameters<ProjectComputerAccess["clear"]>[0]): Promise<boolean> {
    const row = this.reservations.get(scope.projectId);
    if (
      row?.scopeId !== scope.scopeId ||
      row.sandboxId !== scope.sandboxId ||
      scope.proof.scopeId !== scope.scopeId ||
      scope.proof.sandboxId !== scope.sandboxId
    )
      return false;
    return this.reservations.delete(scope.projectId);
  }
  async defer(scope: ComputerScopeIdentity): Promise<void> {
    const row = this.reservations.get(scope.projectId);
    if (row?.scopeId === scope.scopeId)
      row.nextRecoveryAt = new Date(this.now() + 60_000).toISOString();
  }
  async recoverable(limit: number): Promise<ComputerReservation[]> {
    const leases = this.queue?.computerLeases() ?? [];
    return [...this.reservations.values()]
      .filter((row) => {
        if (Date.parse(row.nextRecoveryAt) > this.now()) return false;
        const actor = row.actor;
        return (
          row.state === "recovering" ||
          actor.kind === "owner" ||
          !leases.some((lease) => lease.id === actor.lease.requestId)
        );
      })
      .sort((a, b) => a.nextRecoveryAt.localeCompare(b.nextRecoveryAt))
      .slice(0, limit)
      .map((row) => structuredClone(row));
  }
}
function denied(code: ComputerAdmissionError["code"]): Result<never, ComputerAdmissionError> {
  return { ok: false, error: { code } };
}
