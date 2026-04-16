import type { AgentToolResult } from "@mariozechner/pi-agent-core";
import type { AgentConfig } from "./pi-subagents-agents";
import type { Details, SingleResult } from "./pi-subagents-types";

export function runSync(
  runtimeCwd: string,
  agents: AgentConfig[],
  agentName: string,
  task: string,
  options: {
    cwd?: string;
    signal?: AbortSignal;
    onUpdate?: (r: AgentToolResult<Details>) => void;
    runId: string;
    modelOverride?: string;
  },
): Promise<SingleResult>;
