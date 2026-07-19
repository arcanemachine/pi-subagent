import type {
  ExtensionAPI,
  ExtensionContext,
  Theme,
} from "@earendil-works/pi-coding-agent";
import { getAgentDir, getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import { Box, Markdown, type Component, Text } from "@earendil-works/pi-tui";
import { spawn, ChildProcess } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  openSubagentFleet,
  type FleetAgentDetail,
  type FleetAgentSummary,
  type FleetDataSource,
} from "./fleet";

interface SubAgent {
  id: string;
  process: ChildProcess;
  task: string;
  taskTitle: string;
  agentType?: string;
  model?: string;
  extraContext?: string;
  status: "starting" | "running" | "completed" | "error" | "interrupted";
  activity: string[];
  currentResponsePreview: string;
  lastAssistantText?: string;
  lastAssistantStopReason?: string;
  lastAssistantError?: string;
  completionResult?: string;
  pendingCompletionResult?: string;
  pendingCompletionToolCallId?: string;
  partialResult?: string;
  failureReason?:
    | "missing_result"
    | "incomplete_result"
    | "assistant_error"
    | "process_error";
  interruptionReason?: "reload";
  startTime: number;
  endTime?: number;
  exitCode?: number;
  processExited?: boolean;
  currentTool?: string;
  lastAction?: string;
  progressPercent?: number;
  progressBuffer?: string;
  lastActivity: number;
  receivedEvent: boolean;
  timeoutSeconds?: number;
  timeoutAt?: number;
  timeoutNotified?: boolean;
  timeoutWarningHandle?: NodeJS.Timeout;
  timeoutHandle?: NodeJS.Timeout;
  timeoutEscalationHandle?: NodeJS.Timeout;
  shutdownHandle?: NodeJS.Timeout;
  completionNotified?: boolean;
  lastStateChangeAt?: number;
}

const activeAgents = new Map<string, SubAgent>();
const recentFleetAgents = new Map<string, FleetAgentDetail>();
let currentCtx: ExtensionContext | null = null;
let nextAgentId = 1;
let configuredAgents: Record<string, SubagentProfile> = {};
let maxActiveSubagents: number | undefined = undefined;
let defaultTimeoutSeconds: number | undefined = 180;
let allowNestedSubagents = false;
let sendCompletionMessage:
  | ((
      content: string,
      details?: Record<string, unknown>,
      options?: { triggerTurn?: boolean },
    ) => void)
  | null = null;

const MAX_ACTIVE_SUBAGENTS_CAP = 100;
const MAX_DEFAULT_TIMEOUT_SECONDS = 86400;
const MAX_ACTIVITY_ENTRIES = 50;
const MAX_ACTIVITY_ENTRY_CHARS = 1000;
const MAX_RESPONSE_PREVIEW_CHARS = 4000;
const MAX_RECENT_FLEET_AGENTS = 20;
const PROCESS_SHUTDOWN_GRACE_MS = 2000;
const TIMEOUT_WRAP_UP_WARNING_SECONDS = 60;
let timeoutEscalationDelayMs = 30000;

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

const STALE_RUNNING_MS = 60_000;
const EXTRA_SUBAGENT_INSTRUCTIONS =
  "Ensure that your work stays scoped to the assigned task.";

const SUBAGENT_COMPLETION_INSTRUCTIONS = `Do the requested task only; do not expand scope. If the task is too large, complete the highest-value slice and clearly state what remains.

When finished or blocked, call the \`subagent_complete\` tool with the complete deliverable for the parent in its \`result\` field. A successful call should be your final action. If the tool returns an error, correct the result and call it again. The result may use normal Markdown and should include evidence, changed files, commands, or open questions only when relevant. Do not include planning or process narration.

If the completion tool is unavailable, return the complete deliverable as your final response instead.`;
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

function normalizeManualTimeoutSeconds(raw: unknown): number | undefined {
  if (raw === undefined || raw === null) return undefined;
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
  defaultTimeoutSeconds = settings.default_timeout_seconds ?? 180;
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
  const taskWithContext = !extraContext?.trim()
    ? task
    : `Additional context:\n${extraContext.trim()}\n\nTask:\n${task}`;

  return `${EXTRA_SUBAGENT_INSTRUCTIONS}\n\n${taskWithContext}\n\n${SUBAGENT_COMPLETION_INSTRUCTIONS}`;
}

function isAgentFinished(agent: SubAgent): boolean {
  return (
    agent.status === "completed" ||
    agent.status === "error" ||
    agent.status === "interrupted"
  );
}

function transitionAgentStatus(
  agent: SubAgent,
  nextStatus: SubAgent["status"],
  nextAction: string,
): void {
  const rank: Record<SubAgent["status"], number> = {
    starting: 0,
    running: 1,
    completed: 2,
    error: 2,
    interrupted: 2,
  };

  if (rank[nextStatus] < rank[agent.status]) {
    return;
  }

  if (isAgentFinished(agent)) {
    return;
  }

  agent.status = nextStatus;
  agent.lastAction = nextAction;
  agent.lastStateChangeAt = Date.now();

  if (
    nextStatus === "completed" ||
    nextStatus === "error" ||
    nextStatus === "interrupted"
  ) {
    agent.endTime = Date.now();
    agent.currentTool = undefined;
  }
}

function clearSubAgentTimeout(agent: SubAgent): void {
  if (agent.timeoutWarningHandle) {
    clearTimeout(agent.timeoutWarningHandle);
    agent.timeoutWarningHandle = undefined;
  }

  if (agent.timeoutHandle) {
    clearTimeout(agent.timeoutHandle);
    agent.timeoutHandle = undefined;
  }

  if (agent.timeoutEscalationHandle) {
    clearTimeout(agent.timeoutEscalationHandle);
    agent.timeoutEscalationHandle = undefined;
  }
}

function scheduleSubAgentTimeout(
  agent: SubAgent,
  timeoutSecondsOverride?: number,
): void {
  const timeoutSeconds = timeoutSecondsOverride ?? defaultTimeoutSeconds;
  if (!timeoutSeconds) return;

  agent.timeoutSeconds = timeoutSeconds;
  agent.timeoutAt = agent.startTime + timeoutSeconds * 1000;

  if (timeoutSeconds > TIMEOUT_WRAP_UP_WARNING_SECONDS) {
    const warningDelayMs =
      (timeoutSeconds - TIMEOUT_WRAP_UP_WARNING_SECONDS) * 1000;
    agent.timeoutWarningHandle = setTimeout(() => {
      agent.timeoutWarningHandle = undefined;

      if (agent.status === "completed" || agent.status === "error") {
        return;
      }

      const elapsedSeconds = Math.max(
        0,
        Math.floor((Date.now() - agent.startTime) / 1000),
      );
      steerSubAgent(
        agent.id,
        `You have been running for ${elapsedSeconds} seconds. You have ${TIMEOUT_WRAP_UP_WARNING_SECONDS} seconds to finish your task.`,
      );
    }, warningDelayMs);
  }

  agent.timeoutHandle = setTimeout(() => {
    agent.timeoutHandle = undefined;

    if (agent.status === "completed" || agent.status === "error") {
      return;
    }

    const timeoutText =
      `Time budget reached (${timeoutSeconds}s). ` +
      "Do not continue expanding scope. Submit what you completed and what remains through subagent_complete now.";
    const result = steerSubAgent(agent.id, timeoutText);
    if (result.ok) {
      agent.timeoutNotified = true;
      agent.lastAction = `⏰ timeout reached (${timeoutSeconds}s)`;

      agent.timeoutEscalationHandle = setTimeout(() => {
        agent.timeoutEscalationHandle = undefined;

        if (agent.status === "completed" || agent.status === "error") {
          return;
        }

        steerSubAgent(
          agent.id,
          "You are still running past the time budget. Stop now and call subagent_complete immediately with the best result available.",
        );

        sendCompletionMessage?.(
          `⚠️ Sub-agent ${agent.id} is still running after timeout finalize request. Consider checking status and using an aggressive steering message to instruct the agent to finish immediately. If the agent fails to respond, you may want to use subagent_kill to forcefully end it.`,
          {
            agentId: agent.id,
            timeoutSeconds: timeoutSeconds,
            timeoutStage: "escalation",
          },
        );
      }, timeoutEscalationDelayMs);
    }
  }, timeoutSeconds * 1000);
}

function clearSubAgentShutdown(agent: SubAgent): void {
  if (!agent.shutdownHandle) return;
  clearTimeout(agent.shutdownHandle);
  agent.shutdownHandle = undefined;
}

function recordActivity(agent: SubAgent, entry: string): void {
  const compact = entry.trim().slice(0, MAX_ACTIVITY_ENTRY_CHARS);
  if (!compact) return;

  agent.activity.push(compact);
  if (agent.activity.length > MAX_ACTIVITY_ENTRIES) {
    agent.activity.splice(0, agent.activity.length - MAX_ACTIVITY_ENTRIES);
  }
}

function requestProcessShutdown(agent: SubAgent): void {
  clearSubAgentTimeout(agent);
  if (agent.processExited || agent.shutdownHandle) return;

  try {
    if (agent.process.stdin && !agent.process.stdin.destroyed) {
      agent.process.stdin.end();
    }
  } catch {}

  agent.shutdownHandle = setTimeout(() => {
    agent.shutdownHandle = undefined;
    if (!agent.processExited) {
      agent.process.kill();
    }
  }, PROCESS_SHUTDOWN_GRACE_MS);
  agent.shutdownHandle.unref?.();
}

function rememberAgentForFleet(agent: SubAgent): void {
  if (!isAgentFinished(agent)) return;

  recentFleetAgents.delete(agent.id);
  recentFleetAgents.set(agent.id, {
    ...toFleetAgentDetail(agent),
    activity: [...agent.activity],
    currentResponsePreview: "",
  });
  while (recentFleetAgents.size > MAX_RECENT_FLEET_AGENTS) {
    const oldestId = recentFleetAgents.keys().next().value;
    if (oldestId === undefined) break;
    recentFleetAgents.delete(oldestId);
  }
}

function removeAgentFromTracking(id: string): void {
  const agent = activeAgents.get(id);
  if (agent) rememberAgentForFleet(agent);
  activeAgents.delete(id);
  updateSubAgentStatus();
}

function interruptSubAgentForReload(agent: SubAgent): void {
  agent.interruptionReason = "reload";
  transitionAgentStatus(
    agent,
    "interrupted",
    "interrupted by extension reload",
  );
  notifyAgentCompletion(agent, { triggerTurn: false });
}

function terminateSubAgentWithoutNotification(
  agent: SubAgent,
  action: string,
): void {
  clearSubAgentTimeout(agent);
  clearSubAgentShutdown(agent);
  transitionAgentStatus(agent, "interrupted", action);
  agent.completionNotified = true;
  agent.process.kill();
  removeAgentFromTracking(agent.id);
}

function getFailureMessage(agent: SubAgent): string {
  if (agent.failureReason === "incomplete_result") {
    return "The sub-agent response was truncated before completion.";
  }
  if (agent.failureReason === "assistant_error") {
    return agent.lastAssistantError || "The sub-agent failed while responding.";
  }
  if (agent.failureReason === "process_error") {
    return `The sub-agent process exited unexpectedly${agent.exitCode === undefined ? "." : ` with code ${agent.exitCode}.`}`;
  }
  return "The sub-agent did not return a usable result.";
}

function shouldSuggestNarrowerTask(agent: SubAgent): boolean {
  return (
    agent.failureReason === "missing_result" ||
    agent.failureReason === "incomplete_result" ||
    agent.failureReason === "assistant_error"
  );
}

function notifyAgentCompletion(
  agent: SubAgent,
  options?: { triggerTurn?: boolean },
) {
  if (agent.completionNotified) return;
  if (!isAgentFinished(agent)) return;

  const durationSec = Math.max(
    0,
    Math.round(((agent.endTime || Date.now()) - agent.startTime) / 1000),
  );
  const statusEmoji =
    agent.status === "completed"
      ? "✅"
      : agent.status === "interrupted"
        ? "⚠️"
        : "❌";
  const statusText =
    agent.status === "completed"
      ? "completed"
      : agent.status === "interrupted"
        ? "was interrupted"
        : "errored";
  const exitText =
    agent.exitCode !== undefined ? ` | exit=${agent.exitCode}` : "";
  const resultText = agent.completionResult?.trim();
  const partialResult = agent.partialResult?.trim();
  const resultBlock = resultText
    ? `\nresult:\n${resultText}`
    : partialResult
      ? `\npartial result:\n${partialResult}`
      : "";
  const failureBlock =
    agent.status === "error"
      ? `\nreason: ${getFailureMessage(agent)}` +
        (shouldSuggestNarrowerTask(agent)
          ? "\nSuggestion: If retrying, use a simpler or more narrowly scoped task."
          : "")
      : agent.status === "interrupted" && agent.interruptionReason === "reload"
        ? "\nreason: Extension reload intentionally terminated the child process (SIGTERM, commonly reported as exit 143). Its work may be incomplete; retry if still needed."
        : "";

  sendCompletionMessage?.(
    `${statusEmoji} Sub-agent ${agent.id} ${statusText} in ${durationSec}s` +
      ` | [${agent.agentType || "unknown"}] ${agent.taskTitle}${exitText}` +
      failureBlock +
      resultBlock,
    {
      agentId: agent.id,
      status: agent.status,
      taskTitle: agent.taskTitle,
      agentType: agent.agentType,
      model: agent.model,
      durationSec,
      exitCode: agent.exitCode,
      timedOut: !!agent.timeoutNotified,
      timeoutSeconds: agent.timeoutSeconds,
      result: resultText,
      partialResult,
      failureReason: agent.failureReason,
      interruptionReason: agent.interruptionReason,
      finalReportText: resultText || partialResult || "",
    },
    options,
  );
  agent.completionNotified = true;
  requestProcessShutdown(agent);
  removeAgentFromTracking(agent.id);
}

function settleSubAgent(agent: SubAgent, completionAction: string): void {
  if (isAgentFinished(agent)) return;

  const toolResult = agent.completionResult?.trim();
  if (toolResult) {
    agent.completionResult = toolResult;
    transitionAgentStatus(agent, "completed", completionAction);
    notifyAgentCompletion(agent);
    return;
  }

  const fallbackResult = agent.lastAssistantText?.trim();
  const stopReason = agent.lastAssistantStopReason;
  if (fallbackResult && (!stopReason || stopReason === "stop")) {
    agent.completionResult = fallbackResult;
    transitionAgentStatus(
      agent,
      "completed",
      `${completionAction} (text fallback)`,
    );
    notifyAgentCompletion(agent);
    return;
  }

  if (fallbackResult) {
    agent.partialResult = fallbackResult;
  }

  if (stopReason === "length") {
    agent.failureReason = "incomplete_result";
  } else if (stopReason === "error" || stopReason === "aborted") {
    agent.failureReason = "assistant_error";
  } else {
    agent.failureReason = "missing_result";
  }

  transitionAgentStatus(agent, "error", getFailureMessage(agent));
  notifyAgentCompletion(agent);
}

function extractAssistantMessageText(message: unknown): string {
  if (!message || typeof message !== "object") return "";
  const candidate = message as Record<string, unknown>;
  if (candidate.role !== "assistant" || !Array.isArray(candidate.content)) {
    return "";
  }

  return candidate.content
    .filter(
      (item): item is { type: string; text: string } =>
        !!item &&
        typeof item === "object" &&
        (item as Record<string, unknown>).type === "text" &&
        typeof (item as Record<string, unknown>).text === "string",
    )
    .map((item) => item.text)
    .join("")
    .trim();
}

function handleSubAgentEvent(
  agent: SubAgent,
  event: Record<string, any>,
): void {
  agent.receivedEvent = true;
  agent.lastActivity = Date.now();

  if (event.type === "agent_start") {
    transitionAgentStatus(agent, "running", "started");
    return;
  }

  if (event.type === "message_start" && event.message?.role === "assistant") {
    agent.currentResponsePreview = "";
    return;
  }

  if (event.type === "message_update" && event.assistantMessageEvent) {
    const delta = event.assistantMessageEvent;
    if (delta.type === "text_delta") {
      const deltaText = typeof delta.delta === "string" ? delta.delta : "";
      updateProgressFromTextDelta(agent, deltaText);
      agent.currentResponsePreview =
        `${agent.currentResponsePreview}${deltaText}`.slice(
          -MAX_RESPONSE_PREVIEW_CHARS,
        );
      if (!agent.currentTool && agent.progressPercent === undefined) {
        agent.lastAction = "💬 responding";
      }
    }
    return;
  }

  if (event.type === "message_end" && event.message?.role === "assistant") {
    const text = extractAssistantMessageText(event.message);
    agent.lastAssistantText = text || undefined;
    agent.lastAssistantStopReason =
      typeof event.message.stopReason === "string"
        ? event.message.stopReason
        : undefined;
    agent.lastAssistantError =
      typeof event.message.errorMessage === "string"
        ? event.message.errorMessage.trim()
        : undefined;
    if (text) recordActivity(agent, `💬 ${text}`);
    agent.currentResponsePreview = "";
    return;
  }

  if (event.type === "tool_execution_start") {
    const toolName =
      typeof event.toolName === "string" ? event.toolName : "unknown";
    agent.currentTool = `${toolName}(${JSON.stringify(event.args).slice(0, 50)}...)`;
    agent.lastAction = `🔧 ${toolName}`;

    if (toolName === "subagent_complete") {
      const result =
        event.args && typeof event.args.result === "string"
          ? event.args.result.trim()
          : "";
      agent.pendingCompletionResult = result || undefined;
      agent.pendingCompletionToolCallId =
        typeof event.toolCallId === "string" ? event.toolCallId : undefined;
      recordActivity(agent, "🏁 Completion requested");
    } else {
      recordActivity(
        agent,
        `🔧 ${toolName}: ${JSON.stringify(event.args).slice(0, 100)}`,
      );
    }
    return;
  }

  if (event.type === "tool_execution_end") {
    const toolName =
      typeof event.toolName === "string" ? event.toolName : undefined;
    agent.currentTool = undefined;

    if (toolName === "subagent_complete") {
      const toolCallId =
        typeof event.toolCallId === "string" ? event.toolCallId : undefined;
      const matchesPendingCall =
        !agent.pendingCompletionToolCallId ||
        !toolCallId ||
        agent.pendingCompletionToolCallId === toolCallId;

      if (matchesPendingCall && event.isError !== true) {
        agent.completionResult = agent.pendingCompletionResult;
        agent.lastAction = "✅ completion accepted";
        recordActivity(agent, "🏁 Completion accepted");
      } else {
        agent.lastAction = "❌ completion rejected";
        recordActivity(agent, "❌ Completion rejected; retry required");
      }

      if (matchesPendingCall) {
        agent.pendingCompletionResult = undefined;
        agent.pendingCompletionToolCallId = undefined;
      }
      return;
    }

    agent.lastAction = toolName ? `✅ ${toolName}` : "tool finished";
    return;
  }

  if (event.type === "agent_end") {
    agent.currentTool = undefined;
    agent.lastAction = event.willRetry
      ? "automatic retry pending"
      : "finishing";
    return;
  }

  if (event.type === "agent_settled") {
    settleSubAgent(agent, "finished");
    return;
  }

  if (event.type === "auto_retry_start") {
    agent.lastAction = `retrying (${event.attempt ?? "?"}/${event.maxAttempts ?? "?"})`;
    recordActivity(agent, `↻ ${agent.lastAction}`);
    return;
  }

  if (event.type === "response") {
    const command =
      typeof event.command === "string" ? event.command : "unknown";
    recordActivity(
      agent,
      `${event.success === true ? "✅" : "❌"} RPC response (${command})${event.success === true ? "" : " failed"}`,
    );
  }
}

function spawnSubAgent(
  task: string,
  model: string,
  agentType: string,
  extraContext?: string,
  timeoutSecondsOverride?: number,
): SubAgent {
  const id = String(nextAgentId++);

  const args = ["--mode", "rpc", "--no-session", "--model", model];

  const childEnv: NodeJS.ProcessEnv = {
    ...process.env,
    PI_SUBAGENT_CHILD: "1",
  };
  if (!allowNestedSubagents) {
    childEnv.PI_SUBAGENT_DISABLE_RECURSION = "1";
  }

  const proc = spawn("pi", args, {
    stdio: ["pipe", "pipe", "pipe"],
    detached: false,
    env: childEnv,
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
    activity: [],
    currentResponsePreview: "",
    startTime: Date.now(),
    lastAction: "starting",
    lastActivity: Date.now(),
    receivedEvent: false,
  };

  proc.on("error", (error) => {
    console.error(`Failed to spawn sub-agent ${id}:`, error);
    agent.failureReason = "process_error";
    agent.lastAssistantError = error.message;
    transitionAgentStatus(agent, "error", error.message);
    notifyAgentCompletion(agent);
  });

  // Handle stdout (JSON events)
  let buffer = "";
  proc.stdout?.on("data", (data: Buffer) => {
    buffer += data.toString();
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";

    for (const line of lines) {
      if (!line.trim()) continue;

      try {
        handleSubAgentEvent(agent, JSON.parse(line));
      } catch {
        recordActivity(agent, `📄 Unparseable RPC output: ${line}`);
      }
    }

    updateSubAgentStatus();
  });

  // Handle stderr
  proc.stderr?.on("data", (data: Buffer) => {
    const stderrText = data.toString().trim();
    if (stderrText) {
      recordActivity(agent, `stderr: ${stderrText}`);
      agent.lastAction = `stderr: ${stderrText.slice(0, 60)}`;
    }
    agent.lastActivity = Date.now();
  });

  proc.on("exit", (code, signal) => {
    clearSubAgentTimeout(agent);
    clearSubAgentShutdown(agent);
    agent.processExited = true;
    agent.exitCode = code ?? undefined;

    if (!isAgentFinished(agent)) {
      if (
        agent.completionResult ||
        agent.lastAssistantText ||
        (code === 0 && !signal)
      ) {
        settleSubAgent(agent, "process exited");
      }

      if (!isAgentFinished(agent)) {
        agent.failureReason = "process_error";
        transitionAgentStatus(
          agent,
          "error",
          `process exited${signal ? ` from ${signal}` : ` with code ${code ?? "unknown"}`}`,
        );
        notifyAgentCompletion(agent);
      }
    } else {
      notifyAgentCompletion(agent);
    }

    updateSubAgentStatus();
  });

  // Send the initial prompt
  const prompt = JSON.stringify({
    type: "prompt",
    message: formatSubagentPrompt(task, extraContext),
  });
  proc.stdin?.write(prompt + "\n");

  activeAgents.set(id, agent);
  scheduleSubAgentTimeout(agent, timeoutSecondsOverride);

  updateSubAgentStatus();
  return agent;
}

function getActiveAgentCount(): number {
  return Array.from(activeAgents.values()).filter(
    (agent) => !isAgentFinished(agent),
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

function getBlockedReason(agent: SubAgent, now = Date.now()): string | null {
  if (agent.status !== "running") return null;
  if (now - agent.lastActivity < STALE_RUNNING_MS) return null;
  return "no_recent_activity";
}

function buildAgentStatusSnapshot(agent: SubAgent) {
  const now = Date.now();
  const durationSec = agent.endTime
    ? Math.floor((agent.endTime - agent.startTime) / 1000)
    : Math.floor((now - agent.startTime) / 1000);
  const blockedReason = getBlockedReason(agent, now);

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
    lastMeaningfulEvent: agent.lastAction || "(none)",
    lastActivityMsAgo: Math.max(0, now - agent.lastActivity),
    blockedReason,
    etaConfidence: agent.status === "running" ? "low" : "high",
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
    blockedReason: snapshot.blockedReason,
    lastMeaningfulEvent: snapshot.lastMeaningfulEvent,
    etaConfidence: snapshot.etaConfidence,
  };
}

function buildStatusSummary() {
  const agents = Array.from(activeAgents.values());
  const activeCount = agents.filter(
    (agent) => agent.status === "starting" || agent.status === "running",
  ).length;
  const completedCount = agents.filter(
    (agent) => agent.status === "completed",
  ).length;
  const errorCount = agents.filter((agent) => agent.status === "error").length;
  const blockedCount = agents.filter(
    (agent) => !!getBlockedReason(agent),
  ).length;

  return {
    activeCount,
    queuedCount: 0,
    completedCount,
    errorCount,
    blockedCount,
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

function killSubAgent(id: string): {
  ok: boolean;
  reason?: "not_found" | "already_finished";
} {
  const agent = activeAgents.get(id);
  if (!agent) {
    return { ok: false, reason: "not_found" };
  }

  if (isAgentFinished(agent)) {
    return { ok: false, reason: "already_finished" };
  }

  terminateSubAgentWithoutNotification(agent, "killed by parent");
  return { ok: true };
}

function steerSubAgent(
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

  if (isAgentFinished(agent)) {
    return { ok: false, reason: "already_finished" };
  }

  if (!agent.process.stdin || agent.process.stdin.destroyed) {
    return { ok: false, reason: "stdin_unavailable" };
  }

  const requestId = `steer-${id}-${Date.now()}`;
  const steer = JSON.stringify({
    id: requestId,
    type: "steer",
    message: trimmed,
  });

  agent.process.stdin.write(steer + "\n");
  recordActivity(agent, `📨 Parent guidance: ${trimmed}`);
  agent.lastAction = "📨 steer sent";
  agent.lastActivity = Date.now();
  updateSubAgentStatus();

  return { ok: true };
}

type SteerDelivery = {
  agentId: string;
  sent: boolean;
  reason?:
    | "not_found"
    | "already_finished"
    | "stdin_unavailable"
    | "empty_message";
};

type SteerAllSummary = {
  targeted: number;
  sent: number;
  failed: number;
  deliveries: SteerDelivery[];
};

function steerAllSubAgents(text: string): SteerAllSummary {
  const deliveries = Array.from(activeAgents.keys()).map((agentId) => {
    const result = steerSubAgent(agentId, text);
    return result.ok
      ? { agentId, sent: true }
      : { agentId, sent: false, reason: result.reason };
  });

  const sent = deliveries.filter((delivery) => delivery.sent).length;
  return {
    targeted: deliveries.length,
    sent,
    failed: deliveries.length - sent,
    deliveries,
  };
}

function describeSteerFailure(reason: SteerDelivery["reason"]): string {
  if (reason === "already_finished") return "already finished";
  if (reason === "stdin_unavailable") return "cannot receive guidance";
  if (reason === "empty_message") return "guidance is empty";
  return "not found";
}

function formatSteerAllSummary(summary: SteerAllSummary): string {
  if (summary.targeted === 0) return "No running sub-agents to steer.";

  const header =
    `Sent guidance to ${summary.sent}/${summary.targeted} running sub-agent` +
    `${summary.targeted === 1 ? "" : "s"}.`;
  const deliveries = summary.deliveries.map((delivery) =>
    delivery.sent
      ? `✓ ${delivery.agentId}: sent`
      : `✗ ${delivery.agentId}: ${describeSteerFailure(delivery.reason)}`,
  );
  return [header, ...deliveries].join("\n");
}

function toFleetAgentSummary(agent: SubAgent): FleetAgentSummary {
  return {
    id: agent.id,
    agentType: agent.agentType,
    model: agent.model,
    status: agent.status,
    taskTitle: agent.taskTitle,
    startTime: agent.startTime,
    endTime: agent.endTime,
    currentTool: agent.currentTool,
    lastAction: agent.lastAction,
    progressPercent: agent.progressPercent,
  };
}

function toFleetAgentDetail(agent: SubAgent): FleetAgentDetail {
  return {
    ...toFleetAgentSummary(agent),
    task: agent.task,
    activity: agent.activity,
    currentResponsePreview: agent.currentResponsePreview,
    completionResult: agent.completionResult,
    timeoutSeconds: agent.timeoutSeconds,
    timeoutAt: agent.timeoutAt,
  };
}

function createFleetDataSource(): FleetDataSource {
  return {
    listAgents: () =>
      [
        ...Array.from(activeAgents.values()).map(toFleetAgentSummary),
        ...recentFleetAgents.values(),
      ].sort((left, right) => right.startTime - left.startTime),
    getAgent: (id) => {
      const agent = activeAgents.get(id);
      return agent ? toFleetAgentDetail(agent) : recentFleetAgents.get(id);
    },
    steer: (id, text) => {
      const result = steerSubAgent(id, text);
      if (result.ok) {
        return { ok: true, message: `Guidance sent to ${id}.` };
      }

      const message =
        result.reason === "already_finished"
          ? `${id} already finished.`
          : result.reason === "stdin_unavailable"
            ? `${id} cannot receive guidance right now.`
            : result.reason === "empty_message"
              ? "Guidance cannot be empty."
              : `${id} is no longer running.`;
      return { ok: false, message };
    },
    remove: (id) => {
      if (!recentFleetAgents.delete(id)) {
        return { ok: false, message: `${id} is not a finished sub-agent.` };
      }
      return { ok: true, message: `Removed finished sub-agent ${id}.` };
    },
    removeAllFinished: () => {
      const count = recentFleetAgents.size;
      recentFleetAgents.clear();
      return {
        ok: true,
        message: `Removed ${count} finished sub-agent${count === 1 ? "" : "s"}.`,
      };
    },
    stop: (id) => {
      const result = killSubAgent(id);
      if (!result.ok) {
        return { ok: false, message: `${id} is no longer running.` };
      }
      return { ok: true, message: `Stopped sub-agent ${id}.` };
    },
    stopAllRunning: () => {
      let count = 0;
      for (const id of Array.from(activeAgents.keys())) {
        if (killSubAgent(id).ok) count++;
      }
      return {
        ok: true,
        message: `Stopped ${count} running sub-agent${count === 1 ? "" : "s"}.`,
      };
    },
  };
}

type MessageContent = string | Array<{ type: string; text?: string }>;

/**
 * Render a sub-agent custom message as a Ctrl+O-collapsible block.
 * Collapsed shows a concise one-liner; expanded shows the full message content.
 * Styling mirrors Pi's built-in custom-message component (customMessageBg +
 * customMessageText) so collapsed/expanded blocks match other custom messages.
 */
function renderSubagentMessage(
  content: MessageContent,
  expanded: boolean,
  collapsedLine: string,
  theme: Theme,
): Component {
  const box = new Box(1, 1, (t: string) => theme.bg("customMessageBg", t));
  if (expanded) {
    const text =
      typeof content === "string"
        ? content
        : content
            .filter((c) => c.type === "text")
            .map((c) => c.text || "")
            .join("\n");
    box.addChild(
      new Markdown(text, 0, 0, getMarkdownTheme(), {
        color: (t: string) => theme.fg("customMessageText", t),
      }),
    );
  } else {
    box.addChild(new Text(theme.fg("customMessageText", collapsedLine), 0, 0));
  }
  return box;
}

type SubagentCompleteDetails = {
  agentId?: string;
  status?: "completed" | "error" | "interrupted" | string;
  taskTitle?: string;
  agentType?: string;
  durationSec?: number;
};

type SubagentSpawnedDetails = {
  agentId?: string;
  agentType?: string;
  taskTitle?: string;
};

export default function (pi: ExtensionAPI) {
  if (isTruthyEnv(process.env.PI_SUBAGENT_CHILD)) {
    pi.registerTool({
      name: "subagent_complete",
      label: "Complete Sub-Agent Task",
      description:
        "Submit the complete final deliverable to the parent and finish this child sub-agent. " +
        "Call this when the task is complete or blocked. If it returns an error, correct the result and retry.",
      parameters: {
        type: "object",
        properties: {
          result: {
            type: "string",
            description:
              "Complete answer or deliverable for the parent, using Markdown when useful",
          },
        },
        required: ["result"],
      } as any,
      async execute(
        toolCallId,
        params: { result: string },
        signal,
        onUpdate,
        ctx,
      ) {
        const result =
          typeof params.result === "string" ? params.result.trim() : "";
        if (!result) {
          throw new Error("A non-empty result is required before completing.");
        }

        ctx.shutdown();
        return {
          content: [
            {
              type: "text",
              text: "Result submitted. The child sub-agent will now exit.",
            },
          ],
          details: { completed: true },
          terminate: true,
        };
      },
    });
  }

  if (isTruthyEnv(process.env.PI_SUBAGENT_DISABLE_RECURSION)) {
    return;
  }

  let fleetOpen = false;
  const fleetDataSource = createFleetDataSource();

  sendCompletionMessage = (
    content: string,
    details?: Record<string, unknown>,
    options?: { triggerTurn?: boolean },
  ) => {
    const shouldTriggerTurn =
      options?.triggerTurn !== false &&
      !!currentCtx &&
      currentCtx.isIdle() &&
      !currentCtx.hasPendingMessages();

    pi.sendMessage(
      {
        customType: "subagent-complete",
        content,
        display: true,
        details,
      },
      shouldTriggerTurn
        ? {
            triggerTurn: true,
            deliverAs: "followUp",
          }
        : undefined,
    );
  };

  // Collapsible rendering for sub-agent messages. Collapsed shows a concise
  // one-liner; expanded shows the full content. Toggled by Pi's global
  // Ctrl+O (app.tools.expand), the same control used for tool output.
  pi.registerMessageRenderer(
    "subagent-complete",
    (message, { expanded }, theme) => {
      const details = (message.details ?? undefined) as
        | SubagentCompleteDetails
        | undefined;
      const isError = details?.status === "error";
      const isInterrupted = details?.status === "interrupted";
      const statusText = isInterrupted
        ? "was interrupted"
        : isError
          ? "errored"
          : "completed";
      const emoji = isInterrupted ? "⚠️" : isError ? "❌" : "✅";
      const duration =
        typeof details?.durationSec === "number"
          ? `${details.durationSec}s`
          : "?";
      const agentType = details?.agentType || "unknown";
      const taskTitle = details?.taskTitle || "(untitled task)";
      const collapsed = `${emoji} Sub-agent ${details?.agentId ?? "?"} ${statusText} in ${duration} | [${agentType}] ${taskTitle}`;
      return renderSubagentMessage(message.content, expanded, collapsed, theme);
    },
  );

  pi.registerMessageRenderer(
    "subagent-spawned",
    (message, { expanded }, theme) => {
      const details = (message.details ?? undefined) as
        | SubagentSpawnedDetails
        | undefined;
      const agentType = details?.agentType || "unknown";
      const taskTitle = details?.taskTitle || "(untitled task)";
      const collapsed = `🚀 Sub-agent ${details?.agentId ?? "?"} | [${agentType}] ${taskTitle}`;
      return renderSubagentMessage(message.content, expanded, collapsed, theme);
    },
  );

  // Register /subagent command
  pi.registerCommand("subagent", {
    description: "Spawn and manage sub-agents",
    getArgumentCompletions: (prefix: string) => {
      refreshConfiguredAgents(currentCtx?.cwd ?? process.cwd());

      const baseItems = [
        { value: "fleet", label: "fleet — Open the live sub-agent window" },
        { value: "kill", label: "kill <id> — Kill a specific sub-agent" },
        { value: "killall", label: "killall — Kill all sub-agents" },
        {
          value: "steer",
          label: "steer <id|all> <text> — Send guidance to running sub-agents",
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
      const trimmedArgs = args.trim() || "fleet";
      const [subcommand, ...rest] = trimmedArgs.split(/\s+/);
      const subArgs = rest.join(" ");

      if (subcommand.startsWith("spawn:")) {
        const agentType = subcommand.slice("spawn:".length).trim();

        if (!agentType || !subArgs) {
          ctx.ui.notify(
            "Usage: /subagent spawn:<agent> [timeout:<seconds>] <task>",
            "error",
          );
          return;
        }

        let taskText = subArgs;
        let manualTimeoutSeconds: number | undefined;
        const timeoutMatch = subArgs.match(/^timeout:(\S+)\s+([\s\S]+)$/i);
        if (timeoutMatch) {
          const parsedTimeout = normalizeManualTimeoutSeconds(
            Number(timeoutMatch[1]),
          );
          if (!parsedTimeout) {
            ctx.ui.notify(
              `Invalid timeout '${timeoutMatch[1]}'. Use a positive integer in seconds.`,
              "error",
            );
            return;
          }
          manualTimeoutSeconds = parsedTimeout;
          taskText = timeoutMatch[2];
        }

        try {
          const limitError = getSpawnLimitErrorMessage(1);
          if (limitError) {
            ctx.ui.notify(limitError, "error");
            return;
          }

          const profile = resolveSubagentProfile(agentType, ctx);
          const agent = spawnSubAgent(
            taskText,
            profile.model,
            agentType,
            profile.extra_context,
            manualTimeoutSeconds,
          );
          ctx.ui.notify(`Spawned sub-agent ${agent.id}`, "info");

          // Send a message to the conversation showing what was spawned
          pi.sendMessage({
            customType: "subagent-spawned",
            content:
              `🚀 Spawned sub-agent ${agent.id}\n\n` +
              `Agent type: ${agent.agentType || "(unknown)"}\n` +
              `Task: ${agent.task}\n` +
              `Model: ${agent.model || "(unknown)"}\n` +
              `Timeout: ${agent.timeoutSeconds ? `${agent.timeoutSeconds}s` : "(none)"}`,
            display: true,
            details: {
              agentId: agent.id,
              agentType: agent.agentType,
              taskTitle: agent.taskTitle,
            },
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
        case "fleet": {
          if (!ctx.hasUI) {
            return;
          }
          if (fleetOpen) {
            ctx.ui.notify("The sub-agent window is already open.", "info");
            return;
          }

          fleetOpen = true;
          try {
            await openSubagentFleet(ctx, fleetDataSource);
          } finally {
            fleetOpen = false;
          }
          return;
        }

        case "steer": {
          const targetId = rest[0];
          const text = rest.slice(1).join(" ");

          if (!targetId || !text.trim()) {
            ctx.ui.notify("Usage: /subagent steer <id|all> <text>", "error");
            return;
          }

          if (targetId === "all") {
            const summary = steerAllSubAgents(text);
            ctx.ui.notify(
              formatSteerAllSummary(summary),
              summary.failed > 0 || summary.targeted === 0 ? "warning" : "info",
            );
            return;
          }

          const result = steerSubAgent(targetId, text);
          if (result.ok) {
            ctx.ui.notify(`Sent guidance to sub-agent ${targetId}`, "info");
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
              `Sub-agent ${subArgs} already finished and has already been removed from active status.`,
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

        default:
          ctx.ui.notify(
            "Usage: /subagent spawn:<agent> [timeout:<seconds>] <task> | fleet|steer|kill|killall",
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
      "Returns immediately; a completion message is delivered automatically as a new turn when the sub-agent finishes. " +
      "Do NOT call subagent_status (or any tool) to poll; that only wastes turns. Continue other work or end your turn. Only check status if the user asks or you suspect a stall.",
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
            "Configured sub-agent type key from `pi-subagent.agents` (for example: example1, example2). Use a key that is actually configured; these are only placeholders.",
        },
        timeout_seconds: {
          type: "number",
          description:
            "Optional per-run timeout in seconds. Overrides default timeout for this sub-agent only.",
        },
      },
      required: ["task", "agent"],
    } as any,
    async execute(
      toolCallId,
      params: { task: string; agent: string; timeout_seconds?: number },
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

      const manualTimeoutSeconds = normalizeManualTimeoutSeconds(
        params.timeout_seconds,
      );
      if (params.timeout_seconds !== undefined && !manualTimeoutSeconds) {
        return {
          content: [
            {
              type: "text",
              text: "Invalid timeout_seconds. Use a positive integer in seconds.",
            },
          ],
          isError: true,
          details: {
            rejected: true,
            reason: "invalid_timeout_seconds",
            timeoutSeconds: params.timeout_seconds,
          },
        };
      }

      const profile = resolveSubagentProfile(params.agent, ctx);
      const agent = spawnSubAgent(
        params.task,
        profile.model,
        params.agent,
        profile.extra_context,
        manualTimeoutSeconds,
      );

      return {
        content: [
          {
            type: "text",
            text:
              `🚀 Spawned sub-agent **${agent.id}**\n` +
              `Task: ${agent.task}\n` +
              `Agent type: ${agent.agentType || "(unknown)"}\n` +
              `Model: ${agent.model || "(unknown)"}\n` +
              `Timeout: ${agent.timeoutSeconds ? `${agent.timeoutSeconds}s` : "(none)"}\n\n` +
              `The sub-agent is now running in parallel. Its completion message will be delivered to you automatically as a new turn — you do not need to check on it. ` +
              `Do NOT call subagent_status (or any tool) to poll for progress; that only wastes turns. ` +
              `Continue with other work for the user, or end your turn. ` +
              `Only call subagent_status if the user explicitly asks or you have reason to believe it is stuck.`,
          },
        ],
        details: {
          agentId: agent.id,
          task: agent.task,
          taskTitle: agent.taskTitle,
          agentType: agent.agentType,
          model: agent.model,
          timeoutSeconds: agent.timeoutSeconds,
        },
      };
    },
  });

  // Tool: Get live structured status for one or all sub-agents
  pi.registerTool({
    name: "subagent_status",
    label: "Sub-Agent Status",
    description:
      "Get current sub-agent status for one agent (`agent_id`) or all when omitted. " +
      "Only call when the user explicitly asks for an update or you suspect a sub-agent is stuck — it returns nothing the automatic completion message won't already deliver. " +
      'Do NOT call it to "check in" while waiting; repeated idle calls waste turns. Wait for automatic completion messages instead.',
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

  // Tool: Steer a running sub-agent
  pi.registerTool({
    name: "subagent_steer",
    label: "Steer Sub-Agent",
    description:
      "Send guidance to a running sub-agent by ID, or use `all` to steer every running sub-agent with a per-agent delivery summary. " +
      "Use to redirect sub-agents that are drifting from scope, answer a question they asked, or steer them toward finishing. " +
      "Prefer this over killing and re-spawning when sub-agents are still making progress but on the wrong track.",
    parameters: {
      type: "object",
      properties: {
        agent_id: {
          type: "string",
          description:
            "The sub-agent ID to steer, or `all` for every running sub-agent",
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
      if (params.agent_id === "all") {
        const summary = steerAllSubAgents(params.text);
        return {
          content: [
            {
              type: "text",
              text: formatSteerAllSummary(summary),
            },
          ],
          isError: summary.targeted === 0 || summary.sent === 0,
          details: {
            all: true,
            ...summary,
          },
        };
      }

      const result = steerSubAgent(params.agent_id, params.text);

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
              `Sent guidance to sub-agent ${params.agent_id}\n` +
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

  // Clean up on shutdown. Reloads stay in the same conversation, so surface
  // that interruption without triggering a new turn. Other shutdown reasons
  // discard or replace the current session and should not emit completions.
  pi.on("session_shutdown", async (event) => {
    for (const agent of Array.from(activeAgents.values())) {
      if (event.reason === "reload") {
        interruptSubAgentForReload(agent);
        clearSubAgentShutdown(agent);
        agent.process.kill();
      } else {
        terminateSubAgentWithoutNotification(
          agent,
          `interrupted by session ${event.reason}`,
        );
      }
    }
    activeAgents.clear();
  });

  // Set up status on session start
  pi.on("session_start", async (_event, ctx) => {
    currentCtx = ctx;
    refreshConfiguredAgents(ctx.cwd);
    updateSubAgentStatus();
  });

  // Clear subagents when a new session is created (/new command)
  // Use session_before_switch to clean up in the OLD session before switching
  pi.on("session_before_switch", async (event) => {
    if (event.reason === "new") {
      // Kill any remaining processes and clear the list
      for (const agent of Array.from(activeAgents.values())) {
        terminateSubAgentWithoutNotification(agent, "interrupted by /new");
      }
      activeAgents.clear();
      recentFleetAgents.clear();
      updateSubAgentStatus();
    }
  });
}

export const __test = {
  resetState() {
    for (const [, agent] of activeAgents) {
      clearSubAgentTimeout(agent);
      clearSubAgentShutdown(agent);
    }
    activeAgents.clear();
    recentFleetAgents.clear();
    nextAgentId = 1;
    defaultTimeoutSeconds = 180;
    sendCompletionMessage = null;
  },

  extractAssistantMessageText,
  handleSubAgentEvent,
  settleSubAgent,
  recordActivity,
  interruptSubAgentForReload,
  terminateSubAgentWithoutNotification,

  setDefaultTimeoutSeconds(seconds: number | undefined) {
    defaultTimeoutSeconds = seconds;
  },

  setTimeoutEscalationDelayMs(delayMs: number) {
    timeoutEscalationDelayMs = delayMs;
  },

  setCompletionSender(
    sender:
      | ((
          content: string,
          details?: Record<string, unknown>,
          options?: { triggerTurn?: boolean },
        ) => void)
      | null,
  ) {
    sendCompletionMessage = sender;
  },

  addMockAgent(id: string, overrides: Partial<SubAgent> = {}) {
    const noop = () => {};
    const mockProcess = {
      kill: noop,
      stdin: {
        destroyed: false,
        write: noop,
        end: noop,
      },
    } as unknown as ChildProcess;

    const agent: SubAgent = {
      id,
      process: mockProcess,
      task: "test task",
      taskTitle: "test task",
      status: "running",
      activity: [],
      currentResponsePreview: "",
      startTime: Date.now(),
      lastActivity: Date.now(),
      receivedEvent: true,
      ...overrides,
    };

    activeAgents.set(id, agent);
    return agent;
  },

  scheduleSubAgentTimeout,
  notifyAgentCompletion,
  createFleetDataSource,
};
