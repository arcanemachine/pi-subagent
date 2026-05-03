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
  timeoutSeconds?: number;
  timeoutAt?: number;
  timeoutNotified?: boolean;
  timeoutHandle?: NodeJS.Timeout;
  completionNotified?: boolean;
}

const activeAgents = new Map<string, SubAgent>();
let currentCtx: ExtensionContext | null = null;
let watchedAgentIds: Set<string> = new Set();
let nextAgentId = 1;
let watchAllMode = false; // True when watching all agents (auto-add new ones)
let configuredAgents: Record<string, SubagentProfile> = {};
let maxActiveSubagents: number | undefined = undefined;
let defaultTimeoutSeconds: number | undefined = undefined;
let allowNestedSubagents = false;
let startupAgentGuideSent = false;
let sendCompletionMessage: ((content: string) => void) | null = null;

const DEFAULT_REPORT_COUNT = 3;
const MAX_REPORT_COUNT = 50;
const DEFAULT_WAIT_TIMEOUT_MS = 15000;
const MAX_WAIT_TIMEOUT_MS = 60000;
const MAX_ACTIVE_SUBAGENTS_CAP = 100;
const MAX_DEFAULT_TIMEOUT_SECONDS = 86400;

type SubagentProfile = {
  model: string;
  when_to_use?: string;
  extra_context?: string;
};

type PiSubagentSettings = {
  agents?: Record<string, SubagentProfile>;
  max_active_subagents?: number;
  default_timeout_seconds?: number;
  allow_nested_subagents?: boolean;
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

function normalizeDefaultTimeoutSeconds(raw: unknown): number | undefined {
  if (typeof raw !== "number" || !Number.isFinite(raw)) return undefined;

  const normalized = Math.trunc(raw);
  if (normalized < 1) return undefined;

  return Math.min(normalized, MAX_DEFAULT_TIMEOUT_SECONDS);
}

function normalizeAllowNestedSubagents(raw: unknown): boolean | undefined {
  if (typeof raw !== "boolean") return undefined;
  return raw;
}

function isTruthyEnv(value: string | undefined): boolean {
  if (!value) return false;
  const normalized = value.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes";
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

  const projectDefaultTimeoutSeconds = normalizeDefaultTimeoutSeconds(
    projectSubagentObj.default_timeout_seconds,
  );
  const globalDefaultTimeoutSeconds = normalizeDefaultTimeoutSeconds(
    globalSubagentObj.default_timeout_seconds,
  );

  const projectAllowNestedSubagents = normalizeAllowNestedSubagents(
    projectSubagentObj.allow_nested_subagents,
  );
  const globalAllowNestedSubagents = normalizeAllowNestedSubagents(
    globalSubagentObj.allow_nested_subagents,
  );

  return {
    agents: mergedAgents,
    max_active_subagents: projectMaxActive ?? globalMaxActive,
    default_timeout_seconds:
      projectDefaultTimeoutSeconds ?? globalDefaultTimeoutSeconds,
    allow_nested_subagents:
      projectAllowNestedSubagents ?? globalAllowNestedSubagents ?? false,
  };
}

function refreshConfiguredAgents(cwd: string): void {
  const settings = getPiSubagentSettings(cwd);
  configuredAgents = settings.agents || {};
  maxActiveSubagents = settings.max_active_subagents;
  defaultTimeoutSeconds = settings.default_timeout_seconds;
  allowNestedSubagents = settings.allow_nested_subagents ?? false;
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

  const limitText = maxActiveSubagents
    ? `Max active sub-agents: ${maxActiveSubagents}`
    : "Max active sub-agents: (unlimited)";
  const timeoutText = defaultTimeoutSeconds
    ? `Default timeout: ${defaultTimeoutSeconds}s`
    : "Default timeout: (none)";
  const nestedText = allowNestedSubagents
    ? "Nested sub-agents: enabled"
    : "Nested sub-agents: disabled (default)";

  const agentLines = entries
    .map(({ name, profile }) => {
      const whenToUse = profile.when_to_use || "(no when_to_use provided)";
      return `- ${name}: model=${profile.model}; when_to_use=${whenToUse}`;
    })
    .join("\n");

  return `${limitText}\n${timeoutText}\n${nestedText}\n\n${agentLines}`;
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

function clearSubAgentTimeout(agent: SubAgent): void {
  if (!agent.timeoutHandle) return;

  clearTimeout(agent.timeoutHandle);
  agent.timeoutHandle = undefined;
}

function scheduleSubAgentTimeout(agent: SubAgent): void {
  if (!defaultTimeoutSeconds) return;

  agent.timeoutSeconds = defaultTimeoutSeconds;
  agent.timeoutAt = agent.startTime + defaultTimeoutSeconds * 1000;

  agent.timeoutHandle = setTimeout(() => {
    agent.timeoutHandle = undefined;

    if (agent.status === "completed" || agent.status === "error") {
      return;
    }

    const timeoutText =
      `Time budget reached (${defaultTimeoutSeconds}s). ` +
      "Please report what you have so far in a concise summary, then finish up now.";

    const result = notifySubAgent(agent.id, timeoutText);
    if (result.ok) {
      agent.timeoutNotified = true;
      agent.lastAction = `⏰ timeout reached (${defaultTimeoutSeconds}s)`;
    }
  }, defaultTimeoutSeconds * 1000);
}

function notifyAgentCompletion(agent: SubAgent) {
  if (agent.completionNotified) return;
  if (agent.status !== "completed" && agent.status !== "error") return;

  const durationSec = Math.max(
    0,
    Math.round(((agent.endTime || Date.now()) - agent.startTime) / 1000),
  );
  const statusEmoji = agent.status === "completed" ? "✅" : "❌";
  const statusText = agent.status === "completed" ? "completed" : "errored";
  const exitText =
    agent.exitCode !== undefined ? ` | exit=${agent.exitCode}` : "";

  sendCompletionMessage?.(
    `${statusEmoji} Sub-agent ${agent.id} ${statusText} in ${durationSec}s` +
      ` | [${agent.agentType || "unknown"}] ${agent.taskTitle}${exitText}`,
  );
  agent.completionNotified = true;
}

function spawnSubAgent(
  task: string,
  model: string,
  agentType: string,
  extraContext?: string,
): SubAgent {
  const id = String(nextAgentId++);

  const args = ["--mode", "rpc", "--no-session", "--model", model];

  const childEnv: NodeJS.ProcessEnv = { ...process.env };
  if (!allowNestedSubagents) {
    childEnv.PI_SUBAGENT_DISABLE_RECURSION = "1";
  }

  const proc = spawn("pi", args, {
    stdio: ["pipe", "pipe", "pipe"],
    detached: false,
    env: childEnv,
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
          notifyAgentCompletion(agent);
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
    clearSubAgentTimeout(agent);
    agent.exitCode = code ?? undefined;
    if (code !== 0 && agent.status !== "completed") {
      agent.status = "error";
      agent.endTime = Date.now();
      agent.lastAction = `exited with code ${code ?? "unknown"}`;
    } else if (agent.status !== "completed" && agent.status !== "error") {
      agent.status = "completed";
      agent.endTime = Date.now();
      agent.lastAction = "process exited";
    }
    notifyAgentCompletion(agent);
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
  scheduleSubAgentTimeout(agent);

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
    timeoutSeconds: agent.timeoutSeconds,
    timeoutAt: agent.timeoutAt,
    timeoutNotified: agent.timeoutNotified,
  };
}

function buildCompactAgentStatusSnapshot(agent: SubAgent) {
  const snapshot = buildAgentStatusSnapshot(agent);
  return {
    id: snapshot.id,
    status: snapshot.status,
    agentType: snapshot.agentType,
    taskTitle: snapshot.taskTitle,
    durationSec: snapshot.durationSec,
    progressPercent: snapshot.progressPercent,
  };
}

function buildStatusSummary() {
  const activeCount = getActiveAgentCount();
  return {
    activeCount,
    maxActiveSubagents: maxActiveSubagents ?? null,
    remainingSlots: maxActiveSubagents
      ? Math.max(0, maxActiveSubagents - activeCount)
      : null,
    defaultTimeoutSeconds: defaultTimeoutSeconds ?? null,
    totalKnownAgents: activeAgents.size,
  };
}

function updateSubAgentStatus() {
  if (!currentCtx) return;

  const activeCount = getActiveAgentCount();
  if (activeCount === 0) {
    currentCtx.ui.setStatus("subagent", undefined);
    return;
  }

  currentCtx.ui.setStatus("subagent", getStatusText());
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
      } else if (event.type === "parent_notify") {
        if (currentMessage.trim()) {
          transcript.push(`💬 ${currentMessage.trim()}`);
          currentMessage = "";
        }
        const notifyText =
          typeof event.text === "string" ? event.text : "(no text)";
        transcript.push(`📨 Parent notify: ${notifyText}`);
      } else if (event.type === "response") {
        if (currentMessage.trim()) {
          transcript.push(`💬 ${currentMessage.trim()}`);
          currentMessage = "";
        }

        const command =
          typeof event.command === "string" ? event.command : "(unknown)";
        const success = event.success === true;
        transcript.push(
          `${success ? "✅" : "❌"} RPC response (${command})${success ? "" : " failed"}`,
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
      } else if (event.type === "parent_notify") {
        if (currentMessage.trim()) {
          entries.push(`💬 ${currentMessage.trim()}`);
          currentMessage = "";
        }

        const notifyText =
          typeof event.text === "string" ? event.text : "(no text)";
        entries.push(`📨 Parent notify: ${notifyText}`);
      } else if (event.type === "response") {
        if (currentMessage.trim()) {
          entries.push(`💬 ${currentMessage.trim()}`);
          currentMessage = "";
        }

        const command =
          typeof event.command === "string" ? event.command : "(unknown)";
        const success = event.success === true;
        entries.push(
          `${success ? "✅" : "❌"} RPC response (${command})${success ? "" : " failed"}`,
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

function getAgentReportData(
  id: string,
  requestedCount?: number,
): {
  found: boolean;
  agentId: string;
  status?: SubAgent["status"];
  done?: boolean;
  diagnostics: string[];
  recentEntries: string[];
  count: number;
} {
  const agent = activeAgents.get(id);
  const count = normalizeReportCount(requestedCount);

  if (!agent) {
    return {
      found: false,
      agentId: id,
      diagnostics: [],
      recentEntries: [],
      count,
    };
  }

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

  return {
    found: true,
    agentId: id,
    status: agent.status,
    done: agent.status === "completed" || agent.status === "error",
    diagnostics,
    recentEntries,
    count,
  };
}

function getAgentReport(id: string, requestedCount?: number): string {
  const report = getAgentReportData(id, requestedCount);
  if (!report.found) return `Agent ${id} not found`;

  const diagnosticsBlock =
    report.diagnostics.length > 0
      ? `${report.diagnostics.join("\n\n")}\n\n`
      : "";

  return `## Sub-Agent ${id} recent activity (last ${report.count})\n\n${diagnosticsBlock}${report.recentEntries.join("\n\n") || "(no activity yet)"}`;
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

  clearSubAgentTimeout(agent);
  agent.process.kill();
  activeAgents.delete(id);
  watchedAgentIds.delete(id);
  updateSubAgentStatus();
  updateWatchWidget();
  return { ok: true };
}

function notifySubAgent(
  id: string,
  text: string,
): {
  ok: boolean;
  reason?:
    | "not_found"
    | "already_finished"
    | "stdin_unavailable"
    | "empty_message";
} {
  const trimmed = text.trim();
  if (!trimmed) {
    return { ok: false, reason: "empty_message" };
  }

  const agent = activeAgents.get(id);
  if (!agent) {
    return { ok: false, reason: "not_found" };
  }

  if (agent.status === "completed" || agent.status === "error") {
    return { ok: false, reason: "already_finished" };
  }

  if (!agent.process.stdin || agent.process.stdin.destroyed) {
    return { ok: false, reason: "stdin_unavailable" };
  }

  const requestId = `notify-${id}-${Date.now()}`;
  const steer = JSON.stringify({
    id: requestId,
    type: "steer",
    message: trimmed,
  });

  agent.process.stdin.write(steer + "\n");
  agent.output.push(
    JSON.stringify({
      type: "parent_notify",
      mode: "steer",
      requestId,
      text: trimmed,
      timestamp: Date.now(),
    }),
  );
  agent.lastAction = "📨 steer sent";
  agent.lastActivity = Date.now();
  updateSubAgentStatus();
  if (watchedAgentIds.has(id)) {
    updateWatchWidget();
  }

  return { ok: true };
}

export default function (pi: ExtensionAPI) {
  sendCompletionMessage = (content: string) => {
    pi.sendMessage({
      customType: "subagent-complete",
      content,
      display: true,
    });
  };
  if (isTruthyEnv(process.env.PI_SUBAGENT_DISABLE_RECURSION)) {
    return;
  }

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
        {
          value: "notify",
          label: "notify <id> <text> — Send guidance to a running sub-agent",
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
          "Usage: /subagent spawn:<agent>|report|status|append|notify|kill|killall|prune|show|hide",
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
              const notFound = {
                found: false,
                error: {
                  code: "not_found",
                  message: `Sub-agent ${statusId} not found`,
                  agentId: statusId,
                },
              };
              ctx.ui.notify(JSON.stringify(notFound, null, 2), "error");
              return;
            }

            const targeted = {
              found: true,
              agent: buildAgentStatusSnapshot(agent),
            };
            ctx.ui.notify(JSON.stringify(targeted, null, 2), "info");
            return;
          }

          const status = {
            summary: buildStatusSummary(),
            agents: Array.from(activeAgents.values()).map((agent) =>
              buildCompactAgentStatusSnapshot(agent),
            ),
          };
          ctx.ui.notify(JSON.stringify(status, null, 2), "info");
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

        case "notify": {
          const targetId = rest[0];
          const text = rest.slice(1).join(" ");

          if (!targetId || !text.trim()) {
            ctx.ui.notify("Usage: /subagent notify <id> <text>", "error");
            return;
          }

          const result = notifySubAgent(targetId, text);
          if (result.ok) {
            ctx.ui.notify(
              `Sent guidance notification to sub-agent ${targetId}`,
              "info",
            );
            return;
          }

          if (result.reason === "already_finished") {
            ctx.ui.notify(
              `Sub-agent ${targetId} already finished. Start a new one to continue.`,
              "warning",
            );
            return;
          }

          if (result.reason === "stdin_unavailable") {
            ctx.ui.notify(
              `Sub-agent ${targetId} cannot receive messages right now.`,
              "error",
            );
            return;
          }

          if (result.reason === "empty_message") {
            ctx.ui.notify("Message text cannot be empty", "error");
            return;
          }

          ctx.ui.notify(`Sub-agent ${targetId} not found`, "error");
          return;
        }

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
            "Usage: /subagent spawn:<agent> <task> | report|status|append|notify|kill|killall|prune|show|hide",
            "error",
          );
      }
    },
  });

  // Tool: Spawn a sub-agent and immediately show it in conversation
  pi.registerTool({
    name: "subagent_spawn",
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

  // Tool: Get recent activity entries for a sub-agent
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
      const normalizedCount = normalizeReportCount(params.count);
      const reportData = getAgentReportData(params.agent_id, normalizedCount);
      const reportText = getAgentReport(params.agent_id, normalizedCount);

      return {
        content: [
          {
            type: "text",
            text: reportText,
          },
        ],
        details: {
          agentId: params.agent_id,
          found: reportData.found,
          done: reportData.done,
          status: reportData.status,
          diagnostics: reportData.diagnostics,
          count: reportData.count,
          recentEntries: reportData.recentEntries,
        },
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
          const notFound = {
            found: false,
            error: {
              code: "not_found",
              message: `Sub-agent ${params.agent_id} not found`,
              agentId: params.agent_id,
            },
          };

          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(notFound, null, 2),
              },
            ],
            isError: true,
            details: notFound,
          };
        }

        const targeted = {
          found: true,
          agent: buildAgentStatusSnapshot(agent),
        };

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(targeted, null, 2),
            },
          ],
          details: targeted,
        };
      }

      const status = {
        summary: buildStatusSummary(),
        agents: Array.from(activeAgents.values()).map((agent) =>
          buildCompactAgentStatusSnapshot(agent),
        ),
      };

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(status, null, 2),
          },
        ],
        details: status,
      };
    },
  });

  // Tool: Send a follow-up notification to a running sub-agent
  pi.registerTool({
    name: "subagent_notify",
    label: "Notify Sub-Agent",
    description:
      "Send guidance to a running sub-agent by ID. " +
      "Useful for follow-up instructions during long tasks.",
    parameters: {
      type: "object",
      properties: {
        agent_id: {
          type: "string",
          description: "The sub-agent ID to message",
        },
        text: {
          type: "string",
          description: "Guidance text to send to the running sub-agent",
        },
      },
      required: ["agent_id", "text"],
    } as any,
    async execute(
      toolCallId,
      params: { agent_id: string; text: string },
      signal,
      onUpdate,
      ctx,
    ) {
      const result = notifySubAgent(params.agent_id, params.text);

      if (!result.ok) {
        const message =
          result.reason === "already_finished"
            ? `Sub-agent ${params.agent_id} already finished. Start a new one to continue.`
            : result.reason === "stdin_unavailable"
              ? `Sub-agent ${params.agent_id} cannot receive messages right now.`
              : result.reason === "empty_message"
                ? "Message text cannot be empty"
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
            sent: false,
            reason: result.reason,
            agentId: params.agent_id,
          },
        };
      }

      const sentText = params.text.trim();

      return {
        content: [
          {
            type: "text",
            text:
              `Sent guidance notification to sub-agent ${params.agent_id}\n` +
              `Message: ${sentText}`,
          },
        ],
        details: {
          sent: true,
          agentId: params.agent_id,
          message: sentText,
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

  // Tool: Wait for a sub-agent (or all active sub-agents) to complete
  pi.registerTool({
    name: "subagent_wait",
    label: "Wait for Sub-Agent",
    description:
      "Wait for a sub-agent to finish without tight polling. " +
      "If `agent_id` is omitted, waits for all currently active sub-agents.",
    parameters: {
      type: "object",
      properties: {
        agent_id: {
          type: "string",
          description:
            "The sub-agent ID to wait for. If omitted, waits for all active sub-agents.",
        },
        timeout_ms: {
          type: "number",
          description:
            "How long to wait before returning. Defaults to 15000ms.",
          default: DEFAULT_WAIT_TIMEOUT_MS,
        },
      },
      required: [],
    } as any,
    async execute(
      toolCallId,
      params: { agent_id?: string; timeout_ms?: number },
      signal,
      onUpdate,
      ctx,
    ) {
      const requestedTimeoutMs = params.timeout_ms;
      const timeoutMs = normalizeWaitTimeout(requestedTimeoutMs);
      const waitLimitApplied =
        typeof requestedTimeoutMs === "number" &&
        Number.isFinite(requestedTimeoutMs) &&
        Math.trunc(requestedTimeoutMs) > MAX_WAIT_TIMEOUT_MS;
      const waitLimitNote = waitLimitApplied
        ? `Requested timeout ${Math.trunc(requestedTimeoutMs!)}ms exceeds max ${MAX_WAIT_TIMEOUT_MS}ms; using ${MAX_WAIT_TIMEOUT_MS}ms.`
        : undefined;

      if (params.agent_id) {
        const result = await waitForSubAgent(
          params.agent_id,
          timeoutMs,
          signal,
        );

        if (!result.found) {
          return {
            content: [
              {
                type: "text",
                text: waitLimitNote
                  ? `${waitLimitNote}\nSub-agent ${params.agent_id} not found`
                  : `Sub-agent ${params.agent_id} not found`,
              },
            ],
            isError: true,
            details: {
              scope: "single",
              agentId: params.agent_id,
              found: false,
              done: false,
              waitLimitApplied,
              maxWaitMs: MAX_WAIT_TIMEOUT_MS,
            },
          };
        }

        if (!result.done) {
          const baseText = `Sub-agent ${params.agent_id} is still ${result.status} after waiting ${timeoutMs}ms.`;
          return {
            content: [
              {
                type: "text",
                text: waitLimitNote
                  ? `${waitLimitNote}\n${baseText}`
                  : baseText,
              },
            ],
            details: {
              scope: "single",
              agentId: params.agent_id,
              found: true,
              done: false,
              status: result.status,
              timedOut: result.timedOut,
              retryAfterMs: DEFAULT_WAIT_TIMEOUT_MS,
              waitLimitApplied,
              maxWaitMs: MAX_WAIT_TIMEOUT_MS,
            },
          };
        }

        const doneText =
          result.status === "completed"
            ? "completed successfully"
            : "finished with error";
        const baseDoneText =
          `Sub-agent ${params.agent_id} ${doneText}.\n` +
          `Use \`subagent_report\` for full details if needed.`;

        return {
          content: [
            {
              type: "text",
              text: waitLimitNote
                ? `${waitLimitNote}\n${baseDoneText}`
                : baseDoneText,
            },
          ],
          details: {
            scope: "single",
            agentId: params.agent_id,
            found: true,
            done: true,
            status: result.status,
            exitCode: result.exitCode,
            waitLimitApplied,
            maxWaitMs: MAX_WAIT_TIMEOUT_MS,
          },
        };
      }

      const activeIds = Array.from(activeAgents.values())
        .filter((a) => a.status === "starting" || a.status === "running")
        .map((a) => a.id);

      if (activeIds.length === 0) {
        return {
          content: [
            {
              type: "text",
              text: waitLimitNote
                ? `${waitLimitNote}\nNo active sub-agents to wait for.`
                : "No active sub-agents to wait for.",
            },
          ],
          details: {
            scope: "all",
            done: true,
            agentCount: 0,
            waitLimitApplied,
            maxWaitMs: MAX_WAIT_TIMEOUT_MS,
          },
        };
      }

      const startTime = Date.now();
      while (true) {
        const allDone = activeIds.every((id) => {
          const agent = activeAgents.get(id);
          return (
            !agent || agent.status === "completed" || agent.status === "error"
          );
        });

        if (allDone) break;
        if (signal?.aborted) break;
        if (Date.now() - startTime >= timeoutMs) break;

        await new Promise((r) => setTimeout(r, 100));
      }

      const statuses = activeIds.map((id) => {
        const agent = activeAgents.get(id);
        if (!agent)
          return { id, found: false, done: false, status: "missing" as const };
        const done = agent.status === "completed" || agent.status === "error";
        return {
          id,
          found: true,
          done,
          status: agent.status,
          exitCode: agent.exitCode,
        };
      });

      const doneCount = statuses.filter((s) => s.done).length;
      const allDone = doneCount === statuses.length;
      const baseText = allDone
        ? `All ${statuses.length} sub-agents completed.`
        : `${doneCount}/${statuses.length} sub-agents completed after waiting ${timeoutMs}ms.`;

      return {
        content: [
          {
            type: "text",
            text: waitLimitNote ? `${waitLimitNote}\n${baseText}` : baseText,
          },
        ],
        details: {
          scope: "all",
          done: allDone,
          timedOut: !allDone,
          waitedForIds: activeIds,
          agents: statuses,
          waitLimitApplied,
          maxWaitMs: MAX_WAIT_TIMEOUT_MS,
        },
      };
    },
  });

  // Tool: List configured sub-agent types from settings
  pi.registerTool({
    name: "subagent_list_types",
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

  // Tool: Spawn multiple sub-agents in parallel
  pi.registerTool({
    name: "subagent_spawn_parallel",
    label: "Spawn Parallel Sub-Agents",
    description:
      "Spawn multiple sub-agents to work on different tasks in parallel. " +
      "Each task must include an `agent` key that matches a configured type in `pi-subagent.agents`. " +
      "Returns immediately after spawning and sends automatic completion messages. Use subagent_report/subagent_status for deeper inspection.",
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
      },
      required: ["tasks"],
    } as any,
    async execute(
      toolCallId,
      params: {
        tasks: Array<{ task: string; agent: string }>;
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

      return {
        content: [
          {
            type: "text",
            text:
              `Spawned ${agents.length} sub-agents and returning immediately. ` +
              "You will get automatic completion messages; use subagent_report/subagent_status for details.",
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
      clearSubAgentTimeout(agent);
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
          "Sub-agent types loaded from settings. Use `subagent_spawn` with required `agent` (or `/subagent spawn:<agent> ...`). Completion messages are automatic.\n\n" +
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
        clearSubAgentTimeout(agent);
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
