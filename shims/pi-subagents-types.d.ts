export interface Usage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  turns: number;
}

export interface AgentProgress {
  index: number;
  agent: string;
  status: "pending" | "running" | "completed" | "failed" | "detached";
  task: string;
  currentTool?: string;
  currentToolArgs?: string;
  recentTools: Array<{ tool: string; args: string; endMs: number }>;
  recentOutput: string[];
  toolCount: number;
  tokens: number;
  durationMs: number;
  error?: string;
  failedTool?: string;
}

export interface SingleResult {
  agent: string;
  task: string;
  exitCode: number;
  detached?: boolean;
  detachedReason?: string;
  messages?: Array<{
    role?: string;
    content?: Array<{ type?: string; text?: string }>;
  }>;
  usage: Usage;
  model?: string;
  attemptedModels?: string[];
  modelAttempts?: unknown[];
  error?: string;
  sessionFile?: string;
  skills?: string[];
  skillsWarning?: string;
  progress?: AgentProgress;
  progressSummary?: {
    toolCount: number;
    tokens: number;
    durationMs: number;
  };
  artifactPaths?: unknown;
  truncation?: unknown;
  finalOutput?: string;
  savedOutputPath?: string;
  outputSaveError?: string;
}

export interface Details {
  mode: "single" | "parallel" | "chain" | "management";
  context?: "fresh" | "fork";
  results: SingleResult[];
  asyncId?: string;
  asyncDir?: string;
  progress?: AgentProgress[];
  progressSummary?: {
    toolCount: number;
    tokens: number;
    durationMs: number;
  };
}
