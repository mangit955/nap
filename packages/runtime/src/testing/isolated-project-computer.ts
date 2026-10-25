import type { DesktopInputTransport } from "@nap/shared/ports/desktop-input-transport";
import type {
  ComputerReservation,
  ProjectComputerAccess,
} from "@nap/shared/ports/project-computer-access";
import { ProjectComputer } from "../project-computer.ts";

/** Explicit standalone composition for a sandbox owned exclusively by a test or CLI.
 * Production composition always supplies its durable store and real queue lease.
 */
export function isolatedProjectComputer(transport: DesktopInputTransport): ProjectComputer {
  const reservations = new Map<string, ComputerReservation>();
  const access: ProjectComputerAccess = {
    read: async () => ({ ok: false, error: { code: "not_found" } }),
    reserve: async (request) => {
      if (reservations.has(request.projectId))
        return { ok: false, error: { code: "recovery_pending" } };
      const row: ComputerReservation = {
        ...request,
        state: "active",
        createdAt: new Date().toISOString(),
        nextRecoveryAt: new Date().toISOString(),
      };
      reservations.set(request.projectId, row);
      return { ok: true, value: row };
    },
    occupied: async (id) => reservations.has(id),
    markRecovering: async (scope) => {
      const row = reservations.get(scope.projectId);
      if (row?.scopeId === scope.scopeId) row.state = "recovering";
    },
    clear: async (scope) => {
      if (
        reservations.get(scope.projectId)?.scopeId !== scope.scopeId ||
        scope.proof.scopeId !== scope.scopeId ||
        scope.proof.sandboxId !== scope.sandboxId
      )
        return false;
      return reservations.delete(scope.projectId);
    },
    recoverable: async (limit) => [...reservations.values()].slice(0, limit),
    defer: async () => {},
  };
  class IsolatedProjectComputer extends ProjectComputer {
    override forTurn(request: Parameters<ProjectComputer["forTurn"]>[0]) {
      return super.forTurn({
        ...request,
        lease: request.lease ?? { requestId: crypto.randomUUID(), owner: "isolated" },
      });
    }
  }
  return new IsolatedProjectComputer({ access, transport });
}
