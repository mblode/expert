/**
 * Wire paths and JSON shapes for computer.v1 Connect unary.
 * Proto file: ../computer.proto (must stay identical to api/computer.proto).
 */
export {
  DISPLAY,
  WORKSPACE,
  SPEC_ID,
  SPEC_VERSION,
  TOOLS,
  type SeatState,
  type ErrorCode,
  type Action,
  type ActionResult,
  type PendingCheck,
  type BoxStatus,
  type Button,
  type Point,
  type RequestId,
} from "@computer/shared";

export const PACKAGE = "computer.v1" as const;

export const AgentMethods = {
  Spec: "/computer.v1.Agent/Spec",
  Computer: "/computer.v1.Agent/Computer",
  Shell: "/computer.v1.Agent/Shell",
  ReadFile: "/computer.v1.Agent/ReadFile",
  WriteFile: "/computer.v1.Agent/WriteFile",
} as const;

export const SeatMethods = {
  Pair: "/computer.v1.Seat/Pair",
  Status: "/computer.v1.Seat/Status",
  SetPresence: "/computer.v1.Seat/SetPresence",
  Pointer: "/computer.v1.Seat/Pointer",
  Type: "/computer.v1.Seat/Type",
  ClipboardGet: "/computer.v1.Seat/ClipboardGet",
  ClipboardSet: "/computer.v1.Seat/ClipboardSet",
} as const;

export const ALL_METHODS = [
  ...Object.values(AgentMethods),
  ...Object.values(SeatMethods),
] as const;

export type AuthPolicy = "public" | "pair" | "agent" | "seat";
