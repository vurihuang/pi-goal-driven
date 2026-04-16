import type { SingleResult } from "./pi-subagents-types";

export function getSingleResultOutput(result: Pick<SingleResult, "finalOutput" | "messages">): string;
