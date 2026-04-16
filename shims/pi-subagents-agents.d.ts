export type AgentScope = "user" | "project" | "both";
export type AgentSource = "builtin" | "user" | "project";

export interface AgentConfig {
  name: string;
  description: string;
  tools?: string[];
  mcpDirectTools?: string[];
  model?: string;
  fallbackModels?: string[];
  thinking?: string;
  systemPrompt: string;
  source: AgentSource;
  filePath: string;
  skills?: string[];
  extensions?: string[];
  output?: string;
  defaultReads?: string[];
  defaultProgress?: boolean;
  interactive?: boolean;
  maxSubagentDepth?: number;
  extraFields?: Record<string, string>;
  override?: unknown;
}

export function discoverAgents(cwd: string, scope: AgentScope): {
  agents: AgentConfig[];
  projectAgentsDir: string | null;
};
