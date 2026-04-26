import type {
  ExtensionAPI,
  ExtensionContext,
} from "@mariozechner/pi-coding-agent";
import { getAgentDir } from "@mariozechner/pi-coding-agent";
import { spawn, ChildProcess } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

interface SubAgent {
  id: string;
  process: ChildProcess;
  task: string;
  taskTitle: string;
  agentType?: string;
  model?: string;
  extraContext?: string;
  status: "starting" | "running" | "completed" | "error";
  output: string[];
  startTime: number;
  endTime?: number;
  exitCode?: number;
  currentTool?: string;
  lastAction?: string;
  progressPercent?: number;
  progressBuffer?: string;
  lastActivity: number;
  receivedEvent: boolean;
}

const activeAgents = new Map<string, SubAgent>();
let currentCtx: ExtensionContext | null = null;
let watchedAgentIds: Set<string> = new Set();
let nextAgentId = 1;
let watchAllMode = false; // True when watching all agents (auto-add new ones)
let configuredAgents: Record<string, SubagentProfile> = {};
let maxActiveSubagents: number | undefined = undefined;
let startupAgentGuideSent = false;

const DEFAULT_REPORT_COUNT = 3;
const MAX_REPORT_COUNT = 50;
const DEFAULT_WAIT_TIMEOUT_MS = 5000;
const MAX_WAIT_TIMEOUT_MS = 120000;
const MAX_ACTIVE_SUBAGENTS_CAP = 100;

type SubagentProfile = {
  model: string;
  when_to_use?: string;
  extra_context?: string;
};

type PiSubagentSettings = {
  agents?: Record<string, SubagentProfile>;
  max_active_subagents?: number;
};

function readJsonFile(path: string): Record<string, unknown> {
  if (!existsSync(path)) return {};

  try {
    const raw = readFileSync(path, "utf-8");
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function normalizeMaxActiveSubagents(raw: unknown): number | undefined {
  if (typeof raw !== "number" || !Number.isFinite(raw)) return undefined;

  const normalized = Math.trunc(raw);
  if (normalized < 1) return undefined;

  return Math.min(normalized, MAX_ACTIVE_SUBAGENTS_CAP);
}

function getPiSubagentSettings(cwd: string): PiSubagentSettings {
  const globalSettingsPath = join(getAgentDir(), "settings.json");
  const projectSettingsPath = join(cwd, ".pi", "settings.json");

  const globalSettings = readJsonFile(globalSettingsPath);
  const projectSettings = readJsonFile(projectSettingsPath);

  const globalSubagent = globalSettings["pi-subagent"];
  const projectSubagent = projectSettings["pi-subagent"];

  const globalSubagentObj =
    globalSubagent && typeof globalSubagent === "object"
      ? (globalSubagent as Record<string, unknown>)
      : {};

  const projectSubagentObj =
    projectSubagent && typeof projectSubagent === "object"
      ? (projectSubagent as Record<string, unknown>)
      : {};

  const globalAgentsValue = globalSubagentObj.agents;
  const projectAgentsValue = projectSubagentObj.agents;

  const globalAgents =
    globalAgentsValue && typeof globalAgentsValue === "object"
      ? (globalAgentsValue as Record<string, unknown>)
      : {};

  const projectAgents =
    projectAgentsValue && typeof projectAgentsValue === "object"
      ? (projectAgentsValue as Record<string, unknown>)
      : {};

  const mergedAgents: Record<string, SubagentProfile> = {};

  for (const [agentName, agentConfig] of [
    ...Object.entries(globalAgents),
    ...Object.entries(projectAgents),
  ]) {
    if (!agentConfig || typeof agentConfig !== "object") continue;

    const configObject = agentConfig as Record<string, unknown>;
    const modelValue = configObject.model;
    const whenToUseValue = configObject.when_to_use;
    const extraContextValue = configObject.extra_context;
    const model = typeof modelValue === "string" ? modelValue.trim() : "";

    if (!model) continue;

    const whenToUse =
      typeof whenToUseValue === "string" ? whenToUseValue.trim() : undefined;
    const extraContext =
      typeof extraContextValue === "string"
        ? extraContextValue.trim()
        : undefined;

    mergedAgents[agentName] = {
      model,
      ...(whenToUse ? { when_to_use: whenToUse } : {}),
      ...(extraContext ? { extra_context: extraContext } : {}),
    };
  }

  const projectMaxActive = normalizeMaxActiveSubagents(
    projectSubagentObj.max_active_subagents,
  );
  const globalMaxActive = normalizeMaxActiveSubagents(
    globalSubagentObj.max_active_subagents,
  );

  return {
    agents: mergedAgents,
    max_active_subagents: projectMaxActive ?? globalMaxActive,
  };
}

function refreshConfiguredAgents(cwd: string): void {
  const settings = getPiSubagentSettings(cwd);
  configuredAgents = settings.agents || {};
  maxActiveSubagents = settings.max_active_subagents;
}

function resolveSubagentProfile(
  agentName: string,
  ctx: ExtensionContext | null | undefined,
): SubagentProfile {
  const normalizedAgentName = agentName.trim();
  if (!normalizedAgentName) {
    throw new Error("Missing agent type");
  }

  refreshConfiguredAgents(ctx?.cwd ?? process.cwd());
  const profile = configuredAgents[normalizedAgentName];
  if (profile) return profile;

  const availableAgents = Object.keys(configuredAgents);
  const suffix =
    availableAgents.length > 0
      ? ` Available agents: ${availableAgents.join(", ")}`
      : " No agents configured in settings.";

  throw new Error(
    `Unknown sub-agent type \`${normalizedAgentName}\`.${suffix}`,
  );
}

function getConfiguredAgentEntries(
  ctx: ExtensionContext | null | undefined,
): Array<{ name: string; profile: SubagentProfile }> {
  refreshConfiguredAgents(ctx?.cwd ?? process.cwd());
  return Object.entries(configuredAgents)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, profile]) => ({ name, profile }));
}

function getConfiguredAgentsText(
  ctx: ExtensionContext | null | undefined,
): string {
  const entries = getConfiguredAgentEntries(ctx);

  if (entries.length === 0) {
    return "No sub-agent types configured. Add `pi-subagent.agents` entries to settings.";
  }

  return entries
    .map(({ name, profile }) => {
      const whenToUse = profile.when_to_use || "(no when_to_use provided)";
      return `- ${name}: model=${profile.model}; when_to_use=${whenToUse}`;
    })
    .join("\n");
}

function getTaskTitle(task: string, maxLength = 80): string {
  const firstNonEmptyLine = task
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.length > 0);

  const title = firstNonEmptyLine ?? task.trim();
  if (!title) return "(empty task)";

  if (title.length <= maxLength) return title;
  return `${title.slice(0, Math.max(1, maxLength - 3))}...`;
}

function formatSubagentPrompt(task: string, extraContext?: string): string {
  if (!extraContext?.trim()) return task;

  return `Additional context:\n${extraContext.trim()}\n\nTask:\n${task}`;
}

function spawnSubAgent(
  task: string,
  model: string,
  agentType: string,
  extraContext?: string,
): SubAgent {
  const id = String(nextAgentId++);

  const args = ["--mode", "rpc", "--no-session", "--model", model];

  const proc = spawn("pi", args, {
    stdio: ["pipe", "pipe", "pipe"],
    detached: false,
  });

  // Handle spawn errors
  proc.on("error", (err) => {
    console.error(`Failed to spawn sub-agent ${id}:`, err);
  });

  const agent: SubAgent = {
    id,
    process: proc,
    task,
    taskTitle: getTaskTitle(task),
    agentType,
    model,
    extraContext,
    status: "starting",
    output: [],
    startTime: Date.now(),
    lastAction: "starting",
    lastActivity: Date.now(),
    receivedEvent: false,
  };

  // Handle stdout (JSON events)
  let buffer = "";
  proc.stdout?.on("data", (data: Buffer) => {
    buffer += data.toString();
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";

    for (const line of lines) {
      if (!line.trim()) continue;
      agent.output.push(line);
      agent.lastActivity = Date.now();

      try {
        const event = JSON.parse(line);
        agent.receivedEvent = true;

        // Track what the sub-agent is currently doing
        if (event.type === "tool_execution_start") {
          agent.currentTool = `${event.toolName}(${JSON.stringify(event.args).slice(0, 50)}...)`;
          agent.lastAction = `🔧 ${event.toolName}`;
        } else if (event.type === "tool_execution_end") {
          agent.currentTool = undefined;
          agent.lastAction = event.toolName
            ? `✅ ${event.toolName}`
            : "tool finished";
        } else if (
          event.type === "message_update" &&
          event.assistantMessageEvent
        ) {
          const delta = event.assistantMessageEvent;
          if (delta.type === "text_delta") {
            updateProgressFromTextDelta(agent, delta.delta || "");
            if (!agent.currentTool && agent.progressPercent === undefined) {
              agent.lastAction = "💬 responding";
            }
          }
        } else if (event.type === "agent_end") {
          agent.currentTool = undefined;
        }

        // Update status
        if (event.type === "agent_start") {
          agent.status = "running";
          agent.lastAction = "started";
        } else if (event.type === "agent_end") {
          agent.status = "completed";
          agent.endTime = Date.now();
          agent.currentTool = undefined;
          agent.lastAction = "finished";
          // Force immediate widget update on completion
          updateSubAgentStatus();
          // Update watch widget if being watched
          if (watchedAgentIds.has(id)) {
            updateWatchWidget();
          }
        }
      } catch (e) {
        // Ignore parse errors
      }
    }

    // Update widget to show current activity
    updateSubAgentStatus();

    // Update watch widget if this agent is being watched
    if (watchedAgentIds.has(id)) {
      updateWatchWidget();
    }
  });

  // Handle stderr
  proc.stderr?.on("data", (data: Buffer) => {
    const stderrText = data.toString().trim();
    agent.output.push(`[stderr]: ${stderrText}`);
    if (stderrText) {
      agent.lastAction = `stderr: ${stderrText.slice(0, 60)}`;
    }
    agent.lastActivity = Date.now();
  });

  // Handle process exit
  proc.on("exit", (code) => {
    agent.exitCode = code ?? undefined;
    if (code !== 0 && agent.status !== "completed") {
      agent.status = "error";
      agent.endTime = Date.now();
      agent.lastAction = `exited with code ${code ?? "unknown"}`;
    }
    updateSubAgentStatus();
    // Update watch widget if being watched
    if (watchedAgentIds.has(id)) {
      updateWatchWidget();
    }
  });

  // Send the initial prompt
  const prompt = JSON.stringify({
    type: "prompt",
    message: formatSubagentPrompt(task, extraContext),
  });
  proc.stdin?.write(prompt + "\n");

  activeAgents.set(id, agent);

  // Auto-add to watch list if in watch-all mode
  if (watchAllMode) {
    watchedAgentIds.add(id);
    updateWatchWidget();
  }

  updateSubAgentStatus();
  return agent;
}

function getActiveAgentCount(): number {
  return Array.from(activeAgents.values()).filter(
    (a) => a.status !== "completed" && a.status !== "error",
  ).length;
}

function getStatusText(): string {
  const activeCount = getActiveAgentCount();
  if (!maxActiveSubagents) return `active subagents: ${activeCount}`;

  return `active subagents: ${activeCount}/${maxActiveSubagents}`;
}

function getSpawnLimitErrorMessage(attemptedCount = 1): string | null {
  if (!maxActiveSubagents) return null;

  const activeCount = getActiveAgentCount();
  if (activeCount + attemptedCount <= maxActiveSubagents) return null;

  const remainingSlots = Math.max(0, maxActiveSubagents - activeCount);
  return (
    `Too many active sub-agents (${activeCount}/${maxActiveSubagents}). ` +
    `Requested ${attemptedCount}, available slots: ${remainingSlots}. ` +
    "Wait for some sub-agents to finish and try again."
  );
}

function updateProgressFromTextDelta(agent: SubAgent, deltaText: string): void {
  if (!deltaText) return;

  const combined = `${agent.progressBuffer || ""}${deltaText}`.slice(-240);
  agent.progressBuffer = combined;

  const progressMatches = [
    ...combined.matchAll(/\b(\d{1,3})\s*(?:%|percent)\b/gi),
  ];
  const lastMatch = progressMatches[progressMatches.length - 1];
  if (!lastMatch) return;

  const parsed = Number.parseInt(lastMatch[1], 10);
  if (!Number.isFinite(parsed)) return;

  const normalized = Math.max(0, Math.min(100, parsed));
  agent.progressPercent = normalized;
  agent.lastAction = `progress ${normalized}%`;
}

function buildAgentStatusSnapshot(agent: SubAgent) {
  const now = Date.now();
  const durationSec = agent.endTime
    ? Math.floor((agent.endTime - agent.startTime) / 1000)
    : Math.floor((now - agent.startTime) / 1000);

  return {
    id: agent.id,
    status: agent.status,
    task: agent.task,
    taskTitle: agent.taskTitle,
    agentType: agent.agentType || "(unknown)",
    model: agent.model || "(unknown)",
    durationSec,
    currentTool: agent.currentTool,
    lastAction: agent.lastAction,
    progressPercent: agent.progressPercent,
    lastActivityMsAgo: Math.max(0, now - agent.lastActivity),
    receivedEvent: agent.receivedEvent,
    exitCode: agent.exitCode,
  };
}

function updateSubAgentStatus() {
  if (!currentCtx) return;

  if (activeAgents.size === 0) {
    currentCtx.ui.setStatus("subagent", undefined);
  } else {
    currentCtx.ui.setStatus("subagent", getStatusText());
  }
}

function buildTranscriptLines(
  agent: SubAgent,
  maxLines: number = 10,
): string[] {
  const transcript: string[] = [];
  let currentMessage = "";

  for (const line of agent.output) {
    try {
      const event = JSON.parse(line);

      if (event.type === "tool_execution_start") {
        // Flush any pending message first
        if (currentMessage.trim()) {
          transcript.push(`💬 ${currentMessage.trim()}`);
          currentMessage = "";
        }
        transcript.push(
          `🔧 ${event.toolName}: ${JSON.stringify(event.args).slice(0, 100)}`,
        );
      } else if (
        event.type === "message_update" &&
        event.assistantMessageEvent
      ) {
        const delta = event.assistantMessageEvent;
        if (delta.type === "text_delta") {
          currentMessage += delta.delta;
        } else if (delta.type === "toolcall_start") {
          if (currentMessage.trim()) {
            transcript.push(`💬 ${currentMessage.trim()}`);
            currentMessage = "";
          }
        }
      }
    } catch {}
  }

  // Don't include incomplete message - it will be added on next update

  // Return last N lines
  return transcript.slice(-maxLines);
}

function normalizeReportCount(rawCount: number | undefined): number {
  if (rawCount === undefined) return DEFAULT_REPORT_COUNT;
  if (!Number.isFinite(rawCount)) return DEFAULT_REPORT_COUNT;

  const count = Math.trunc(rawCount);
  if (count < 1) return DEFAULT_REPORT_COUNT;
  return Math.min(count, MAX_REPORT_COUNT);
}

function parseReportCountFromArg(rawCount: string | undefined): {
  count: number;
  error?: string;
} {
  if (!rawCount) return { count: DEFAULT_REPORT_COUNT };

  const parsed = Number.parseInt(rawCount, 10);
  if (!Number.isFinite(parsed) || parsed < 1) {
    return {
      count: DEFAULT_REPORT_COUNT,
      error: "Count must be a positive integer",
    };
  }

  return { count: Math.min(parsed, MAX_REPORT_COUNT) };
}

function normalizeWaitTimeout(rawTimeout: number | undefined): number {
  if (rawTimeout === undefined) return DEFAULT_WAIT_TIMEOUT_MS;
  if (!Number.isFinite(rawTimeout)) return DEFAULT_WAIT_TIMEOUT_MS;

  const timeout = Math.trunc(rawTimeout);
  if (timeout < 1) return DEFAULT_WAIT_TIMEOUT_MS;

  return Math.min(timeout, MAX_WAIT_TIMEOUT_MS);
}

function buildReportEntries(agent: SubAgent): string[] {
  const entries: string[] = [];
  let currentMessage = "";

  for (const line of agent.output) {
    try {
      const event = JSON.parse(line);

      if (event.type === "tool_execution_start") {
        if (currentMessage.trim()) {
          entries.push(`💬 ${currentMessage.trim()}`);
          currentMessage = "";
        }

        entries.push(
          `🔧 ${event.toolName}: ${JSON.stringify(event.args).slice(0, 100)}`,
        );
      } else if (
        event.type === "message_update" &&
        event.assistantMessageEvent
      ) {
        const delta = event.assistantMessageEvent;
        if (delta.type === "text_delta") {
          currentMessage += delta.delta;
        } else if (delta.type === "toolcall_start") {
          if (currentMessage.trim()) {
            entries.push(`💬 ${currentMessage.trim()}`);
            currentMessage = "";
          }
        }
      }
    } catch {}
  }

  if (currentMessage.trim()) {
    entries.push(`💬 ${currentMessage.trim()}`);
  }

  if (entries.length === 0 && agent.output.length > 0) {
    const fallbackLines = agent.output
      .slice(-8)
      .map(
        (line) => `📄 ${line.slice(0, 200)}${line.length > 200 ? "..." : ""}`,
      );
    entries.push(...fallbackLines);
  }

  return entries;
}

function updateWatchWidget() {
  if (!currentCtx) return;

  // Clean up watched IDs that no longer exist
  for (const id of watchedAgentIds) {
    if (!activeAgents.has(id)) {
      watchedAgentIds.delete(id);
    }
  }

  // If no agents to watch, show empty state or clear
  if (watchedAgentIds.size === 0) {
    if (watchAllMode) {
      const emptyMessage =
        "👁 Watching all sub-agents\n────────────────────────────────────────\nNo sub-agents running";
      currentCtx.ui.setWidget("subagent-watch", emptyMessage.split("\n"));
    } else {
      currentCtx.ui.setWidget("subagent-watch", undefined);
    }
    return;
  }

  const agentCount = watchedAgentIds.size;
  const compactMode = agentCount >= 3;

  const widgetLines: string[] = [
    "👁 Watching all sub-agents",
    "────────────────────────────────────────",
  ];

  const orderedWatchedIds = watchAllMode
    ? Array.from(watchedAgentIds).reverse()
    : Array.from(watchedAgentIds);

  for (const id of orderedWatchedIds) {
    const agent = activeAgents.get(id);
    if (!agent) continue;

    const duration = agent.endTime
      ? Math.floor((agent.endTime - agent.startTime) / 1000)
      : Math.floor((Date.now() - agent.startTime) / 1000);

    const statusIcon =
      agent.status === "running"
        ? "⏳"
        : agent.status === "completed"
          ? "✓"
          : "✗";
    const modelLabel = agent.model || "(model unknown)";

    const noResponseYet =
      (agent.status === "starting" || agent.status === "running") &&
      !agent.receivedEvent &&
      Date.now() - agent.startTime > 5000;

    if (compactMode) {
      // Compact: one line per agent
      const actionInfo = agent.currentTool
        ? agent.currentTool
        : agent.lastAction
          ? agent.lastAction
          : noResponseYet
            ? "no response yet"
            : "idle";
      const progressInfo =
        agent.progressPercent !== undefined &&
        (agent.status === "starting" || agent.status === "running")
          ? `~${agent.progressPercent}% | `
          : "";
      widgetLines.push(
        `${statusIcon} ${id} ${agent.status} ${duration}s | ${modelLabel} | ${progressInfo}${actionInfo.slice(0, 60)}`,
      );
    } else {
      // Verbose: full info with transcript
      widgetLines.push(
        `${statusIcon} ${id} (${agent.status}) | ${duration}s | ${modelLabel}`,
      );
      widgetLines.push(`Task: ${agent.taskTitle}`);

      if (noResponseYet) {
        widgetLines.push("⚠ No response from sub-agent process yet");
      }

      const transcriptLines = buildTranscriptLines(agent, 5);
      if (transcriptLines.length > 0) {
        widgetLines.push(...transcriptLines);
      }
      widgetLines.push("────────────────────────────────────────");
    }
  }

  currentCtx.ui.setWidget("subagent-watch", widgetLines);
}

async function waitForSubAgent(
  id: string,
  timeoutMs = DEFAULT_WAIT_TIMEOUT_MS,
  signal?: AbortSignal,
): Promise<
  | { found: false }
  | {
      found: true;
      done: boolean;
      status: SubAgent["status"];
      exitCode?: number;
      timedOut: boolean;
    }
> {
  const agent = activeAgents.get(id);
  if (!agent) return { found: false };

  const startTime = Date.now();
  while (agent.status !== "completed" && agent.status !== "error") {
    if (signal?.aborted) {
      return {
        found: true,
        done: false,
        status: agent.status,
        exitCode: agent.exitCode,
        timedOut: false,
      };
    }

    if (Date.now() - startTime >= timeoutMs) {
      return {
        found: true,
        done: false,
        status: agent.status,
        exitCode: agent.exitCode,
        timedOut: true,
      };
    }

    await new Promise((r) => setTimeout(r, 100));
  }

  return {
    found: true,
    done: true,
    status: agent.status,
    exitCode: agent.exitCode,
    timedOut: false,
  };
}

function getAgentReport(id: string, requestedCount?: number): string {
  const agent = activeAgents.get(id);
  if (!agent) return `Agent ${id} not found`;

  const count = normalizeReportCount(requestedCount);

  const duration = agent.endTime
    ? Math.floor((agent.endTime - agent.startTime) / 1000)
    : Math.floor((Date.now() - agent.startTime) / 1000);

  const noResponseEver =
    !agent.receivedEvent &&
    (agent.status === "completed" || agent.status === "error");

  const noResponseYet =
    !agent.receivedEvent &&
    (agent.status === "starting" || agent.status === "running");

  const diagnostics: string[] = [];

  if (noResponseYet) {
    diagnostics.push(
      "⚠ No response from the sub-agent process yet. The process may still be starting or blocked.",
    );
  }

  if (noResponseEver) {
    diagnostics.push(
      "⚠ The sub-agent process exited without emitting any events. This often indicates startup or model-resolution failures.",
    );
  }

  const entries = buildReportEntries(agent);
  const recentEntries = entries.slice(-count);

  let exitCodeText = "(unknown)";
  if (agent.exitCode !== undefined) {
    exitCodeText = String(agent.exitCode);
  } else if (agent.status === "starting" || agent.status === "running") {
    exitCodeText = "(running)";
  } else if (agent.status === "completed" || agent.status === "error") {
    exitCodeText = "(not yet reported)";
  }

  const currentTool =
    agent.status === "starting" || agent.status === "running"
      ? agent.currentTool || "(idle)"
      : undefined;

  return `
## Sub-Agent ${id}

**Task:** ${agent.task}
**Task title:** ${agent.taskTitle}
**Agent type:** ${agent.agentType || "(unknown)"}
**Model:** ${agent.model || "(unknown)"}
**Extra context:** ${agent.extraContext ? "configured" : "none"}
**Status:** ${agent.status}
**Duration:** ${duration}s
**Exit code:** ${exitCodeText}${currentTool ? `\n**Current tool:** ${currentTool}` : ""}

### Diagnostics
${diagnostics.join("\n\n") || "(none)"}

### Recent activity (last ${count})
${recentEntries.join("\n\n") || "(no activity yet)"}
`;
}

function killSubAgent(id: string): {
  ok: boolean;
  reason?: "not_found" | "already_finished";
} {
  const agent = activeAgents.get(id);
  if (!agent) {
    return { ok: false, reason: "not_found" };
  }

  if (agent.status === "completed" || agent.status === "error") {
    return { ok: false, reason: "already_finished" };
  }

  agent.process.kill();
  activeAgents.delete(id);
  watchedAgentIds.delete(id);
  updateSubAgentStatus();
  updateWatchWidget();
  return { ok: true };
}

export default function (pi: ExtensionAPI) {
  // Register /subagent command
  pi.registerCommand("subagent", {
    description: "Spawn and manage sub-agents",
    getArgumentCompletions: (prefix: string) => {
      refreshConfiguredAgents(currentCtx?.cwd ?? process.cwd());

      const baseItems = [
        {
          value: "report",
          label: "report <id> [count] — Get recent sub-agent activity",
        },
        {
          value: "status",
          label: "status [id] — Show current structured status",
        },
        { value: "list", label: "list — List all sub-agents" },
        { value: "kill", label: "kill <id> — Kill a specific sub-agent" },
        { value: "killall", label: "killall — Kill all sub-agents" },
        {
          value: "prune",
          label: "prune — Remove completed sub-agents from list",
        },
        { value: "show", label: "show [id] — Watch sub-agent (no ID = all)" },
        { value: "hide", label: "hide [id] — Stop watching (no ID = all)" },
        {
          value: "append",
          label: "append <id> [count] — Add report to context",
        },
      ];

      const spawnItems = Object.entries(configuredAgents).map(
        ([agentType, profile]) => ({
          value: `spawn:${agentType}`,
          label:
            `spawn:${agentType} <task> — ` +
            (profile.when_to_use || `Uses ${profile.model}`),
        }),
      );

      const commandPrefix = prefix.trimStart();
      if (commandPrefix.includes(" ")) {
        return null;
      }

      const items = [...spawnItems, ...baseItems];
      if ("spawn:".startsWith(commandPrefix)) {
        items.unshift({ value: "spawn:", label: "spawn:<agent> <task>" });
      }

      return items.filter((i) => i.value.startsWith(commandPrefix));
    },
    handler: async (args: string, ctx) => {
      refreshConfiguredAgents(ctx.cwd);
      const trimmedArgs = args.trim();
      if (!trimmedArgs) {
        ctx.ui.notify(
          "Usage: /subagent spawn:<agent>|report|status|append|list|kill|killall|prune|show|hide",
          "error",
        );
        return;
      }

      const [subcommand, ...rest] = trimmedArgs.split(/\s+/);
      const subArgs = rest.join(" ");

      if (subcommand.startsWith("spawn:")) {
        const agentType = subcommand.slice("spawn:".length).trim();

        if (!agentType || !subArgs) {
          ctx.ui.notify("Usage: /subagent spawn:<agent> <task>", "error");
          return;
        }

        try {
          const limitError = getSpawnLimitErrorMessage(1);
          if (limitError) {
            ctx.ui.notify(limitError, "error");
            return;
          }

          const profile = resolveSubagentProfile(agentType, ctx);
          const agent = spawnSubAgent(
            subArgs,
            profile.model,
            agentType,
            profile.extra_context,
          );
          ctx.ui.notify(`Spawned sub-agent ${agent.id}`, "info");

          // Send a message to the conversation showing what was spawned
          pi.sendMessage({
            customType: "subagent-spawned",
            content:
              `🚀 Spawned sub-agent **${agent.id}**\n` +
              `Task: ${agent.task}\n` +
              `Agent type: ${agent.agentType || "(unknown)"}\n` +
              `Model: ${agent.model || "(unknown)"}`,
            display: true,
          });
        } catch (error: unknown) {
          ctx.ui.notify(
            error instanceof Error ? error.message : String(error),
            "error",
          );
        }

        return;
      }

      switch (subcommand) {
        case "report": {
          const reportId = rest[0];
          const { count, error } = parseReportCountFromArg(rest[1]);

          if (!reportId) {
            ctx.ui.notify("Usage: /subagent report <id> [count]", "error");
            return;
          }
          if (error) {
            ctx.ui.notify(
              `${error}. Using default count ${DEFAULT_REPORT_COUNT}.`,
              "warning",
            );
          }

          const report = getAgentReport(reportId, count);
          // Just display to user, don't add to context
          const separator = "─".repeat(40);
          ctx.ui.notify(`${separator}\n${report}\n${separator}`, "info");
          break;
        }

        case "status": {
          const statusId = rest[0];

          if (statusId) {
            const agent = activeAgents.get(statusId);
            if (!agent) {
              ctx.ui.notify(`Sub-agent ${statusId} not found`, "error");
              return;
            }

            const snapshot = buildAgentStatusSnapshot(agent);
            ctx.ui.notify(
              `Sub-agent ${statusId} status:\n${JSON.stringify(snapshot, null, 2)}`,
              "info",
            );
            return;
          }

          if (activeAgents.size === 0) {
            ctx.ui.notify("No sub-agents found", "info");
            return;
          }

          const snapshots = Array.from(activeAgents.values()).map((agent) =>
            buildAgentStatusSnapshot(agent),
          );
          ctx.ui.notify(
            `Sub-agent status:\n${JSON.stringify(snapshots, null, 2)}`,
            "info",
          );
          return;
        }

        case "append": {
          const reportId = rest[0];
          const { count, error } = parseReportCountFromArg(rest[1]);

          if (!reportId) {
            ctx.ui.notify("Usage: /subagent append <id> [count]", "error");
            return;
          }
          if (error) {
            ctx.ui.notify(
              `${error}. Using default count ${DEFAULT_REPORT_COUNT}.`,
              "warning",
            );
          }

          const reportToAppend = getAgentReport(reportId, count);
          // Send to conversation so LLM can see it
          pi.sendMessage({
            customType: "subagent-report",
            content: reportToAppend,
            display: true,
          });
          ctx.ui.notify(
            `Report for ${reportId} (last ${count}) added to conversation`,
            "info",
          );
          break;
        }

        case "list":
          if (activeAgents.size === 0) {
            ctx.ui.notify("No active sub-agents", "info");
          } else {
            const list = Array.from(activeAgents.entries())
              .map(
                ([id, a]) =>
                  `${id}: ${a.status} | ${a.agentType || "unknown"} | ${a.model || "(unknown)"} | Task: ${a.taskTitle}`,
              )
              .join("\n");
            ctx.ui.notify(`Active sub-agents:\n${list}`, "info");
          }
          break;

        case "kill":
          if (!subArgs) {
            ctx.ui.notify("Usage: /subagent kill <id>", "error");
            return;
          }
          const result = killSubAgent(subArgs);
          if (result.ok) {
            ctx.ui.notify(`Killed sub-agent ${subArgs}`, "info");
          } else if (result.reason === "already_finished") {
            ctx.ui.notify(
              `Sub-agent ${subArgs} already finished. Use /subagent prune to remove it.`,
              "warning",
            );
          } else {
            ctx.ui.notify(`Sub-agent ${subArgs} not found`, "error");
          }
          break;

        case "killall":
          for (const [id] of activeAgents) {
            killSubAgent(id);
          }
          ctx.ui.notify("Killed all sub-agents", "info");
          break;

        case "prune": {
          let pruned = 0;
          for (const [id, agent] of activeAgents) {
            if (agent.status === "completed" || agent.status === "error") {
              activeAgents.delete(id);
              pruned++;
            }
          }
          updateSubAgentStatus();
          updateWatchWidget(); // Clean up pruned agents from widget
          ctx.ui.notify(`Pruned ${pruned} completed sub-agents`, "info");
          break;
        }

        case "show":
          if (!subArgs) {
            // No ID provided, watch all
            watchAllMode = true;
            for (const [id] of activeAgents) {
              watchedAgentIds.add(id);
            }
            updateWatchWidget();
            ctx.ui.notify("Watching all sub-agents", "info");
            return;
          }
          // Watching specific agent, disable watch-all mode and clear existing
          watchAllMode = false;
          watchedAgentIds.clear();
          if (!activeAgents.has(subArgs)) {
            ctx.ui.notify(`Sub-agent ${subArgs} not found`, "error");
            return;
          }
          watchedAgentIds.add(subArgs);
          updateWatchWidget();
          ctx.ui.notify(`Now watching sub-agent ${subArgs}`, "info");
          break;

        case "hide":
          if (!subArgs) {
            // No ID provided, hide all
            watchAllMode = false;
            watchedAgentIds.clear();
            updateWatchWidget();
            ctx.ui.notify("Stopped watching all sub-agents", "info");
            return;
          }
          // Hiding specific agent, disable watch-all mode
          watchAllMode = false;
          watchedAgentIds.delete(subArgs);
          updateWatchWidget();
          ctx.ui.notify(`Stopped watching sub-agent ${subArgs}`, "info");
          break;

        default:
          ctx.ui.notify(
            "Usage: /subagent spawn:<agent> <task> | report|status|append|list|kill|killall|prune|show|hide",
            "error",
          );
      }
    },
  });

  // Tool: Spawn a sub-agent and immediately show it in conversation
  pi.registerTool({
    name: "spawn_subagent",
    label: "Spawn Sub-Agent",
    description:
      "Spawn a sub-agent to work on a task in parallel. " +
      "`agent` is required and must match a configured key in settings `pi-subagent.agents`. " +
      "The sub-agent will appear in the active agents widget. " +
      "Use subagent_wait to wait for completion and subagent_report to inspect details.",
    parameters: {
      type: "object",
      properties: {
        task: {
          type: "string",
          description: "Clear, specific task for the sub-agent to complete",
        },
        agent: {
          type: "string",
          description:
            "Configured sub-agent type key from settings (for example: simple, smart, code-review)",
        },
      },
      required: ["task", "agent"],
    } as any,
    async execute(
      toolCallId,
      params: { task: string; agent: string },
      signal,
      onUpdate,
      ctx,
    ) {
      refreshConfiguredAgents(ctx.cwd);

      const limitError = getSpawnLimitErrorMessage(1);
      if (limitError) {
        return {
          content: [{ type: "text", text: limitError }],
          isError: true,
          details: {
            rejected: true,
            reason: "max_active_subagents_reached",
            active: getActiveAgentCount(),
            maxActive: maxActiveSubagents,
          },
        };
      }

      const profile = resolveSubagentProfile(params.agent, ctx);
      const agent = spawnSubAgent(
        params.task,
        profile.model,
        params.agent,
        profile.extra_context,
      );

      return {
        content: [
          {
            type: "text",
            text:
              `🚀 Spawned sub-agent **${agent.id}**\n` +
              `Task: ${agent.task}\n` +
              `Agent type: ${agent.agentType || "(unknown)"}\n` +
              `Model: ${agent.model || "(unknown)"}\n\n` +
              `The sub-agent is now running in parallel. You can:\n` +
              `- Watch its progress in the widget above\n` +
              `- Run \`/subagent report ${agent.id}\` to see full details\n` +
              `- Spawn more sub-agents for parallel work`,
          },
        ],
        details: {
          agentId: agent.id,
          task: agent.task,
          taskTitle: agent.taskTitle,
          agentType: agent.agentType,
          model: agent.model,
        },
      };
    },
  });

  // Tool: Get a detailed report of what a sub-agent did
  pi.registerTool({
    name: "subagent_report",
    label: "Sub-Agent Report",
    description:
      "Get a sub-agent report. " +
      "Returns recent sub-agent activity entries. " +
      "Use `count` to choose how many entries to include (default: 3).",
    parameters: {
      type: "object",
      properties: {
        agent_id: {
          type: "string",
          description: "The sub-agent ID to get the report for",
        },
        count: {
          type: "number",
          description:
            "How many recent activity entries to include. Defaults to 3.",
          default: DEFAULT_REPORT_COUNT,
        },
      },
      required: ["agent_id"],
    } as any,
    async execute(
      toolCallId,
      params: { agent_id: string; count?: number },
      signal,
      onUpdate,
      ctx,
    ) {
      const report = getAgentReport(
        params.agent_id,
        normalizeReportCount(params.count),
      );

      return {
        content: [
          {
            type: "text",
            text: report,
          },
        ],
        details: { agentId: params.agent_id },
      };
    },
  });

  // Tool: Get live structured status for one or all sub-agents
  pi.registerTool({
    name: "subagent_status",
    label: "Sub-Agent Status",
    description:
      "Get current sub-agent status. " +
      "Returns structured state for one agent (`agent_id`) or all known agents when omitted.",
    parameters: {
      type: "object",
      properties: {
        agent_id: {
          type: "string",
          description: "Optional sub-agent ID to inspect",
        },
      },
      required: [],
    } as any,
    async execute(
      toolCallId,
      params: { agent_id?: string },
      signal,
      onUpdate,
      ctx,
    ) {
      if (params.agent_id) {
        const agent = activeAgents.get(params.agent_id);
        if (!agent) {
          return {
            content: [
              {
                type: "text",
                text: `Sub-agent ${params.agent_id} not found`,
              },
            ],
            isError: true,
            details: {
              found: false,
              agentId: params.agent_id,
            },
          };
        }

        const snapshot = buildAgentStatusSnapshot(agent);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(snapshot, null, 2),
            },
          ],
          details: {
            found: true,
            agent: snapshot,
          },
        };
      }

      const snapshots = Array.from(activeAgents.values()).map((agent) =>
        buildAgentStatusSnapshot(agent),
      );

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(snapshots, null, 2),
          },
        ],
        details: {
          found: true,
          agents: snapshots,
        },
      };
    },
  });

  // Tool: Kill a specific sub-agent
  pi.registerTool({
    name: "subagent_kill",
    label: "Kill Sub-Agent",
    description: "Kill a running sub-agent by ID.",
    parameters: {
      type: "object",
      properties: {
        agent_id: {
          type: "string",
          description: "The sub-agent ID to terminate",
        },
      },
      required: ["agent_id"],
    } as any,
    async execute(
      toolCallId,
      params: { agent_id: string },
      signal,
      onUpdate,
      ctx,
    ) {
      const result = killSubAgent(params.agent_id);
      if (!result.ok) {
        const message =
          result.reason === "already_finished"
            ? `Sub-agent ${params.agent_id} already finished. Use prune if you want to remove it from tracking.`
            : `Sub-agent ${params.agent_id} not found`;

        return {
          content: [
            {
              type: "text",
              text: message,
            },
          ],
          isError: true,
          details: {
            killed: false,
            reason: result.reason,
            agentId: params.agent_id,
          },
        };
      }

      return {
        content: [
          {
            type: "text",
            text: `Killed sub-agent ${params.agent_id}`,
          },
        ],
        details: {
          killed: true,
          agentId: params.agent_id,
        },
      };
    },
  });

  // Tool: Wait for a sub-agent to complete with a short default timeout
  pi.registerTool({
    name: "subagent_wait",
    label: "Wait for Sub-Agent",
    description:
      "Wait for a sub-agent to finish without tight polling. " +
      "Returns done=true when status is completed/error; otherwise returns still running after timeout.",
    parameters: {
      type: "object",
      properties: {
        agent_id: {
          type: "string",
          description: "The sub-agent ID to wait for",
        },
        timeout_ms: {
          type: "number",
          description: "How long to wait before returning. Defaults to 5000ms.",
          default: DEFAULT_WAIT_TIMEOUT_MS,
        },
      },
      required: ["agent_id"],
    } as any,
    async execute(
      toolCallId,
      params: { agent_id: string; timeout_ms?: number },
      signal,
      onUpdate,
      ctx,
    ) {
      const timeoutMs = normalizeWaitTimeout(params.timeout_ms);
      const result = await waitForSubAgent(params.agent_id, timeoutMs, signal);

      if (!result.found) {
        return {
          content: [
            {
              type: "text",
              text: `Sub-agent ${params.agent_id} not found`,
            },
          ],
          isError: true,
          details: {
            agentId: params.agent_id,
            found: false,
            done: false,
          },
        };
      }

      if (!result.done) {
        return {
          content: [
            {
              type: "text",
              text: `Sub-agent ${params.agent_id} is still ${result.status} after waiting ${timeoutMs}ms.`,
            },
          ],
          details: {
            agentId: params.agent_id,
            found: true,
            done: false,
            status: result.status,
            timedOut: result.timedOut,
            retryAfterMs: DEFAULT_WAIT_TIMEOUT_MS,
          },
        };
      }

      const doneText =
        result.status === "completed"
          ? "completed successfully"
          : "finished with error";

      return {
        content: [
          {
            type: "text",
            text:
              `Sub-agent ${params.agent_id} ${doneText}.\n` +
              `Use \`subagent_report\` for full details if needed.`,
          },
        ],
        details: {
          agentId: params.agent_id,
          found: true,
          done: true,
          status: result.status,
          exitCode: result.exitCode,
        },
      };
    },
  });

  // Tool: List configured sub-agent types from settings
  pi.registerTool({
    name: "list_subagent_agents",
    label: "List Sub-Agent Types",
    description:
      "List configured sub-agent types from `pi-subagent.agents`, including model and usage metadata.",
    parameters: {
      type: "object",
      properties: {},
      required: [],
    } as any,
    async execute(
      toolCallId,
      params: Record<string, never>,
      signal,
      onUpdate,
      ctx,
    ) {
      const entries = getConfiguredAgentEntries(ctx);

      if (entries.length === 0) {
        return {
          content: [
            {
              type: "text",
              text: "No sub-agent types are configured. Add `pi-subagent.agents` in settings.",
            },
          ],
          isError: true,
          details: { agents: [] },
        };
      }

      const lines = entries.map(({ name, profile }) => {
        const whenToUse = profile.when_to_use || "(not provided)";
        return `- ${name}\n  model: ${profile.model}\n  when_to_use: ${whenToUse}`;
      });

      return {
        content: [
          {
            type: "text",
            text: `Configured sub-agent types:\n${lines.join("\n")}`,
          },
        ],
        details: {
          agents: entries.map(({ name, profile }) => ({
            name,
            model: profile.model,
            whenToUse: profile.when_to_use,
          })),
        },
      };
    },
  });

  // Tool: Spawn multiple sub-agents in parallel and wait for all
  pi.registerTool({
    name: "spawn_parallel",
    label: "Spawn Parallel Sub-Agents",
    description:
      "Spawn multiple sub-agents to work on different tasks in parallel. " +
      "Each task must include an `agent` key that matches a configured type in `pi-subagent.agents`. " +
      "Returns when all complete. Great for analyzing multiple files or components.",
    parameters: {
      type: "object",
      properties: {
        tasks: {
          type: "array",
          items: {
            type: "object",
            properties: {
              task: {
                type: "string",
                description: "Task prompt to run in this sub-agent",
              },
              agent: {
                type: "string",
                description:
                  "Configured sub-agent type key from settings (for example: simple, smart, code-review)",
              },
            },
            required: ["task", "agent"],
          },
          description: "Array of task descriptors, each with task + agent type",
        },
        timeout_ms: {
          type: "number",
          description: "Max time to wait for all to complete",
          default: 120000,
        },
      },
      required: ["tasks"],
    } as any,
    async execute(
      toolCallId,
      params: {
        tasks: Array<{ task: string; agent: string }>;
        timeout_ms?: number;
      },
      signal,
      onUpdate,
      ctx,
    ) {
      refreshConfiguredAgents(ctx.cwd);

      const limitError = getSpawnLimitErrorMessage(params.tasks.length);
      if (limitError) {
        return {
          content: [{ type: "text", text: limitError }],
          isError: true,
          details: {
            rejected: true,
            reason: "max_active_subagents_reached",
            active: getActiveAgentCount(),
            maxActive: maxActiveSubagents,
            requested: params.tasks.length,
          },
        };
      }

      const agents: SubAgent[] = [];

      // Spawn all agents
      for (const taskSpec of params.tasks) {
        const profile = resolveSubagentProfile(taskSpec.agent, ctx);
        agents.push(
          spawnSubAgent(
            taskSpec.task,
            profile.model,
            taskSpec.agent,
            profile.extra_context,
          ),
        );
      }

      onUpdate?.({
        content: [
          {
            type: "text",
            text:
              `Spawned ${agents.length} sub-agents:\n` +
              agents
                .map(
                  (a) =>
                    `- ${a.id}: [${a.agentType || "unknown"}] ${a.model || "(unknown)"} | ${a.taskTitle}`,
                )
                .join("\n"),
          },
        ],
        details: { agentCount: agents.length },
      });

      // Wait for all to complete
      const timeout = params.timeout_ms || 120000;
      const startTime = Date.now();

      while (true) {
        const allDone = agents.every(
          (a) => a.status === "completed" || a.status === "error",
        );
        if (allDone) break;

        if (Date.now() - startTime > timeout) {
          return {
            content: [
              {
                type: "text",
                text: `Timeout after ${timeout}ms. Some sub-agents still running.`,
              },
            ],
            isError: true,
            details: {
              agents: agents.map((a) => ({ id: a.id, status: a.status })),
            },
          };
        }

        await new Promise((r) => setTimeout(r, 100));
      }

      // Generate reports for all
      const reports = agents.map((a) => getAgentReport(a.id));

      return {
        content: [
          {
            type: "text",
            text:
              `## All ${agents.length} Sub-Agents Complete\n\n` +
              reports.join("\n---\n"),
          },
        ],
        details: {
          agents: agents.map((a) => ({
            id: a.id,
            status: a.status,
            taskTitle: a.taskTitle,
            agentType: a.agentType,
            model: a.model,
          })),
        },
      };
    },
  });

  // Clean up on shutdown
  pi.on("session_shutdown", async () => {
    for (const [id, agent] of activeAgents) {
      agent.process.kill();
    }
    activeAgents.clear();
    startupAgentGuideSent = false;
  });

  // Set up status on session start
  pi.on("session_start", async (_event, ctx) => {
    currentCtx = ctx;
    refreshConfiguredAgents(ctx.cwd);
    updateSubAgentStatus();

    if (!startupAgentGuideSent) {
      const configuredAgentsText = getConfiguredAgentsText(ctx);
      pi.sendMessage({
        customType: "subagent-agents",
        content:
          "Sub-agent types loaded from settings. Use `spawn_subagent` with required `agent` (or `/subagent spawn:<agent> ...`).\n\n" +
          configuredAgentsText,
        display: false,
      });
      startupAgentGuideSent = true;
    }
  });

  // Clear subagents when a new session is created (/new command)
  // Use session_before_switch to clean up in the OLD session before switching
  pi.on("session_before_switch", async (event) => {
    if (event.reason === "new") {
      // Kill any remaining processes and clear the list
      for (const [id, agent] of activeAgents) {
        agent.process.kill();
      }
      activeAgents.clear();
      updateSubAgentStatus();
      // Clear watch list, widget, and watch-all mode
      watchedAgentIds.clear();
      watchAllMode = false;
      updateWatchWidget();
      startupAgentGuideSent = false;
    }
  });
}
