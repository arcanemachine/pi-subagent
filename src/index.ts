import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
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
  timeoutWarningHandle?: NodeJS.Timeout;
  timeoutHandle?: NodeJS.Timeout;
  timeoutEscalationHandle?: NodeJS.Timeout;
  completionNotified?: boolean;
  lastStateChangeAt?: number;
}

const activeAgents = new Map<string, SubAgent>();
let currentCtx: ExtensionContext | null = null;
let watchedAgentIds: Set<string> = new Set();
let nextAgentId = 1;
let watchAllMode = false; // True when watching all agents (auto-add new ones)
let configuredAgents: Record<string, SubagentProfile> = {};
let maxActiveSubagents: number | undefined = undefined;
let defaultTimeoutSeconds: number | undefined = 180;
let allowNestedSubagents = false;
let sendCompletionMessage:
  | ((content: string, details?: Record<string, unknown>) => void)
  | null = null;

const DEFAULT_REPORT_COUNT = 3;
const MAX_REPORT_COUNT = 50;
const MAX_ACTIVE_SUBAGENTS_CAP = 100;
const MAX_DEFAULT_TIMEOUT_SECONDS = 86400;
const TIMEOUT_WRAP_UP_WARNING_SECONDS = 60;
const WATCH_WIDGET_UPDATE_INTERVAL_MS = 250;
let timeoutEscalationDelayMs = 30000;
let watchWidgetUpdateHandle: NodeJS.Timeout | undefined;
let lastWatchWidgetUpdateAt = 0;

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

type CommandValidation = {
  command: string;
  status: "pass" | "fail" | "unknown";
};

type FinalReport = {
  summary: string;
  changed_files: string[];
  commands: CommandValidation[];
  open_questions: string[];
  confidence: number | null;
};

type ConfidenceRating = {
  score: number;
  maxScore: number;
  missing: string[];
  warnings: string[];
};

const FINAL_REPORT_FENCE = "subagent_final_report";
const STALE_RUNNING_MS = 60_000;
const SUBAGENT_FINAL_REPORT_INSTRUCTIONS =
  'Do the requested task only; do not expand scope. If the task is too large, partially complete the highest-value slice, then report what remains and stop. When finished (or when blocked by scope), include a final machine-parseable block exactly once using this fenced JSON format:\n```subagent_final_report\n{"summary":"...","changed_files":["path/file"],"commands":[{"command":"npm test","status":"pass"}],"open_questions":["..."],"confidence":0.0}\n```\nKeep it terse. Use empty arrays when none. Stop immediately after this final block.';
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
  const taskWithContext = !extraContext?.trim()
    ? task
    : `Additional context:\n${extraContext.trim()}\n\nTask:\n${task}`;

  return `${taskWithContext}\n\n${SUBAGENT_FINAL_REPORT_INSTRUCTIONS}`;
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
  };

  if (rank[nextStatus] < rank[agent.status]) {
    return;
  }

  if (agent.status === "completed" || agent.status === "error") {
    return;
  }

  agent.status = nextStatus;
  agent.lastAction = nextAction;
  agent.lastStateChangeAt = Date.now();

  if (nextStatus === "completed" || nextStatus === "error") {
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
      notifySubAgent(
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
      "Do not continue expanding scope. Report what you completed, what remains, then finish now with the required final report block.";
    const result = notifySubAgent(agent.id, timeoutText);
    if (result.ok) {
      agent.timeoutNotified = true;
      agent.lastAction = `⏰ timeout reached (${timeoutSeconds}s)`;

      agent.timeoutEscalationHandle = setTimeout(() => {
        agent.timeoutEscalationHandle = undefined;

        if (agent.status === "completed" || agent.status === "error") {
          return;
        }

        notifySubAgent(
          agent.id,
          "You are still running past the time budget. Stop now and send the required final report block immediately.",
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

function removeAgentFromTracking(id: string): void {
  activeAgents.delete(id);
  watchedAgentIds.delete(id);
  updateSubAgentStatus();
  updateWatchWidget();
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
  const reportData = getAgentReportData(agent.id, DEFAULT_REPORT_COUNT);
  const assistantText = extractAssistantText(agent).trim();
  const sanitizedReportText = sanitizeAssistantReportText(assistantText);
  const fullReportText =
    sanitizedReportText ||
    assistantText ||
    "(no assistant final text captured)";

  sendCompletionMessage?.(
    `${statusEmoji} Sub-agent ${agent.id} ${statusText} in ${durationSec}s` +
      ` | [${agent.agentType || "unknown"}] ${agent.taskTitle}${exitText}` +
      `\nconfidence rating: ${reportData.confidenceRating.score}/${reportData.confidenceRating.maxScore}` +
      `\nsummary: ${reportData.finalReport?.summary || "(missing structured final report block)"}` +
      `\nfull_report:\n\`\`\`text\n${fullReportText}\n\`\`\``,
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
      finalReportText: fullReportText,
      finalReport: reportData.finalReport,
      confidenceRating: reportData.confidenceRating,
      reviewChecklist: reportData.reviewChecklist,
    },
  );
  agent.completionNotified = true;
  removeAgentFromTracking(agent.id);
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
          transitionAgentStatus(agent, "running", "started");
        } else if (event.type === "agent_end") {
          transitionAgentStatus(agent, "completed", "finished");
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
      scheduleWatchWidgetUpdate();
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
      transitionAgentStatus(
        agent,
        "error",
        `exited with code ${code ?? "unknown"}`,
      );
    } else if (agent.status !== "completed" && agent.status !== "error") {
      transitionAgentStatus(agent, "completed", "process exited");
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
  scheduleSubAgentTimeout(agent, timeoutSecondsOverride);

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

function extractAssistantText(agent: SubAgent): string {
  let text = "";

  for (const line of agent.output) {
    try {
      const event = JSON.parse(line);
      if (
        event.type === "message_update" &&
        event.assistantMessageEvent?.type === "text_delta"
      ) {
        text += event.assistantMessageEvent.delta || "";
      }
    } catch {}
  }

  return text;
}

function sanitizeAssistantReportText(text: string): string {
  let cleaned = text.trim();

  const finalReportFenceRegex = new RegExp(
    "\\n?```" + FINAL_REPORT_FENCE + "[\\s\\S]*?```\\s*$",
    "i",
  );
  cleaned = cleaned.replace(finalReportFenceRegex, "").trim();

  const recipeStartIndex = cleaned.search(/^Recipe name:/im);
  if (recipeStartIndex > 0) {
    cleaned = cleaned.slice(recipeStartIndex).trim();
  }

  cleaned = cleaned.replace(/^here(?:'s| is) the report:\s*/i, "").trim();

  return cleaned;
}

function normalizeParsedFinalReport(parsed: Partial<FinalReport>): FinalReport {
  return {
    summary: typeof parsed.summary === "string" ? parsed.summary.trim() : "",
    changed_files: Array.isArray(parsed.changed_files)
      ? parsed.changed_files
          .filter((value): value is string => typeof value === "string")
          .map((value) => value.trim())
          .filter(Boolean)
      : [],
    commands: Array.isArray(parsed.commands)
      ? parsed.commands
          .map((value) => {
            if (!value || typeof value !== "object") return null;
            const candidate = value as Record<string, unknown>;
            const command =
              typeof candidate.command === "string"
                ? candidate.command.trim()
                : "";
            const rawStatus =
              typeof candidate.status === "string"
                ? candidate.status.toLowerCase()
                : "unknown";
            const status: CommandValidation["status"] =
              rawStatus === "pass" || rawStatus === "fail"
                ? rawStatus
                : "unknown";
            if (!command) return null;
            return { command, status };
          })
          .filter((value): value is CommandValidation => !!value)
      : [],
    open_questions: Array.isArray(parsed.open_questions)
      ? parsed.open_questions
          .filter((value): value is string => typeof value === "string")
          .map((value) => value.trim())
          .filter(Boolean)
      : [],
    confidence:
      typeof parsed.confidence === "number" &&
      Number.isFinite(parsed.confidence)
        ? Math.max(0, Math.min(1, parsed.confidence))
        : null,
  };
}

function extractFinalReportJsonBlock(text: string): string | null {
  const fenced = text.match(
    new RegExp("```" + FINAL_REPORT_FENCE + "\\s*([\\s\\S]*?)```", "i"),
  );
  if (fenced?.[1]?.trim()) return fenced[1].trim();

  const marker = FINAL_REPORT_FENCE;
  const markerIndex = text.toLowerCase().lastIndexOf(marker.toLowerCase());
  if (markerIndex === -1) return null;

  const afterMarker = text.slice(markerIndex);
  const openBraceIndex = afterMarker.indexOf("{");
  const closeBraceIndex = afterMarker.lastIndexOf("}");
  if (
    openBraceIndex === -1 ||
    closeBraceIndex === -1 ||
    closeBraceIndex <= openBraceIndex
  ) {
    return null;
  }

  return afterMarker.slice(openBraceIndex, closeBraceIndex + 1).trim();
}

function parseFinalReportFromTexts(texts: string[]): FinalReport | null {
  const candidateTexts = texts.filter((value) => value.trim().length > 0);

  for (const text of candidateTexts) {
    const rawJson = extractFinalReportJsonBlock(text);
    if (!rawJson) continue;

    try {
      const parsed = JSON.parse(rawJson) as Partial<FinalReport>;
      return normalizeParsedFinalReport(parsed);
    } catch {
      continue;
    }
  }

  return null;
}

function parseFinalReport(agent: SubAgent): FinalReport | null {
  const assistantText = extractAssistantText(agent);
  return parseFinalReportFromTexts([
    assistantText,
    buildReportEntries(agent).join("\n"),
  ]);
}

function buildConfidenceRating(
  finalReport: FinalReport | null,
  entries: string[],
): ConfidenceRating {
  const missing: string[] = [];
  const warnings: string[] = [];

  if (!finalReport) {
    missing.push("final_report_block");
    return { score: 0, maxScore: 5, missing, warnings };
  }

  let score = 1;
  if (!finalReport.summary) missing.push("summary");
  else score++;

  if (finalReport.changed_files.length === 0) missing.push("changed_files");
  else score++;

  if (finalReport.commands.length === 0) missing.push("commands");
  else score++;

  if (finalReport.confidence === null) missing.push("confidence");
  else score++;

  if (!entries.some((entry) => entry.startsWith("🔧"))) {
    warnings.push("no_tool_activity_logged");
  }

  return { score, maxScore: 5, missing, warnings };
}

function buildReviewChecklist(finalReport: FinalReport | null): string[] {
  if (!finalReport) {
    return ["[ ] Missing structured final report"];
  }

  return [
    `[ ] Review files touched (${finalReport.changed_files.length})`,
    `[ ] Validate commands (${finalReport.commands.length})`,
    `[ ] Check risks/open questions (${finalReport.open_questions.length})`,
    "[ ] Confirm tests/doc updates if expected",
  ];
}

function scheduleWatchWidgetUpdate(force = false) {
  if (force) {
    if (watchWidgetUpdateHandle) {
      clearTimeout(watchWidgetUpdateHandle);
      watchWidgetUpdateHandle = undefined;
    }
    lastWatchWidgetUpdateAt = Date.now();
    updateWatchWidget();
    return;
  }

  if (watchWidgetUpdateHandle) return;

  const elapsed = Date.now() - lastWatchWidgetUpdateAt;
  const delay = Math.max(0, WATCH_WIDGET_UPDATE_INTERVAL_MS - elapsed);

  watchWidgetUpdateHandle = setTimeout(() => {
    watchWidgetUpdateHandle = undefined;
    lastWatchWidgetUpdateAt = Date.now();
    updateWatchWidget();
  }, delay);
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
  finalReport: FinalReport | null;
  confidenceRating: ConfidenceRating;
  reviewChecklist: string[];
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
      finalReport: null,
      confidenceRating: { score: 0, maxScore: 5, missing: [], warnings: [] },
      reviewChecklist: [],
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
  const finalReport = parseFinalReport(agent);
  const confidenceRating = buildConfidenceRating(finalReport, entries);
  const reviewChecklist = buildReviewChecklist(finalReport);

  return {
    found: true,
    agentId: id,
    status: agent.status,
    done: agent.status === "completed" || agent.status === "error",
    diagnostics,
    recentEntries,
    count,
    finalReport,
    confidenceRating,
    reviewChecklist,
  };
}

function getAgentReport(id: string, requestedCount?: number): string {
  const report = getAgentReportData(id, requestedCount);
  if (!report.found) return `Agent ${id} not found`;

  const diagnosticsBlock =
    report.diagnostics.length > 0
      ? `${report.diagnostics.join("\n\n")}\n\n`
      : "";

  const finalBlock = report.finalReport
    ? [
        "## Final deliverable",
        `summary: ${report.finalReport.summary || "(empty)"}`,
        `changed_files: ${report.finalReport.changed_files.join(", ") || "(none)"}`,
        `commands: ${report.finalReport.commands.map((c) => `${c.command}=${c.status}`).join(", ") || "(none)"}`,
        `open_questions: ${report.finalReport.open_questions.join(" | ") || "(none)"}`,
        `confidence: ${report.finalReport.confidence ?? "(missing)"}`,
      ].join("\n")
    : "## Final deliverable\n(missing structured final report block)";

  const confidenceBlock = `confidence rating: ${report.confidenceRating.score}/${report.confidenceRating.maxScore}`;
  const checklistBlock = `checklist:\n${report.reviewChecklist.map((item) => `- ${item}`).join("\n")}`;

  return `${finalBlock}\n\n${confidenceBlock}\n${checklistBlock}\n\n## Recent activity (last ${report.count})\n\n${diagnosticsBlock}${report.recentEntries.join("\n\n") || "(no activity yet)"}`;
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
  removeAgentFromTracking(id);
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
  sendCompletionMessage = (
    content: string,
    details?: Record<string, unknown>,
  ) => {
    const shouldTriggerTurn =
      !!currentCtx && currentCtx.isIdle() && !currentCtx.hasPendingMessages();

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
          value: "status",
          label:
            "status [id] — Show current structured status (do NOT use for routine polling)",
        },
        { value: "kill", label: "kill <id> — Kill a specific sub-agent" },
        { value: "killall", label: "killall — Kill all sub-agents" },
        { value: "show", label: "show [id] — Watch sub-agent (no ID = all)" },
        { value: "hide", label: "hide [id] — Stop watching (no ID = all)" },
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
          "Usage: /subagent spawn:<agent>|status|notify|kill|killall|show|hide",
          "error",
        );
        return;
      }

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
              `🚀 Spawned sub-agent **${agent.id}**\n` +
              `Task: ${agent.task}\n` +
              `Agent type: ${agent.agentType || "(unknown)"}\n` +
              `Model: ${agent.model || "(unknown)"}\n` +
              `Timeout: ${agent.timeoutSeconds ? `${agent.timeoutSeconds}s` : "(none)"}`,
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
            "Usage: /subagent spawn:<agent> [timeout:<seconds>] <task> | status|notify|kill|killall|show|hide",
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
      "Returns immediately. An automatic completion message will be sent when the sub-agent finishes. " +
      "Do NOT call subagent_status for routine polling. Wait for the completion message; only check status if the user asks or you suspect a stall.",
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
              `The sub-agent is now running in parallel. Do NOT poll subagent_status. ` +
              `Wait for the automatic completion message. Only check status or intervene if the user asks or you suspect a stall.`,
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
      "Get current sub-agent status. " +
      "Returns structured state for one agent (`agent_id`) or all known agents when omitted. " +
      "Do NOT use for routine polling. Only call if the user explicitly asks for an update or you suspect a sub-agent is stuck. Wait for automatic completion messages instead.",
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
      "Returns immediately after spawning; automatic completion messages will be sent as each sub-agent finishes. " +
      "Do NOT call subagent_status for routine polling. Wait for the completion messages; only check status if the user asks or you suspect a stall.",
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
              timeout_seconds: {
                type: "number",
                description:
                  "Optional per-run timeout in seconds for this task only.",
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
        tasks: Array<{
          task: string;
          agent: string;
          timeout_seconds?: number;
        }>;
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
        const manualTimeoutSeconds = normalizeManualTimeoutSeconds(
          taskSpec.timeout_seconds,
        );
        if (taskSpec.timeout_seconds !== undefined && !manualTimeoutSeconds) {
          return {
            content: [
              {
                type: "text",
                text: `Invalid timeout_seconds for task '${taskSpec.task.slice(0, 40)}'. Use a positive integer in seconds.`,
              },
            ],
            isError: true,
            details: {
              rejected: true,
              reason: "invalid_timeout_seconds",
              task: taskSpec.task,
              timeoutSeconds: taskSpec.timeout_seconds,
            },
          };
        }

        const profile = resolveSubagentProfile(taskSpec.agent, ctx);
        agents.push(
          spawnSubAgent(
            taskSpec.task,
            profile.model,
            taskSpec.agent,
            profile.extra_context,
            manualTimeoutSeconds,
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
              "Automatic completion messages will arrive as each sub-agent finishes. Do NOT poll subagent_status. Wait for those messages; only check status if the user asks or you suspect a stall.",
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
    }
  });
}

export const __test = {
  resetState() {
    for (const [, agent] of activeAgents) {
      clearSubAgentTimeout(agent);
    }
    activeAgents.clear();
    watchedAgentIds.clear();
    watchAllMode = false;
    nextAgentId = 1;
    defaultTimeoutSeconds = 180;
    sendCompletionMessage = null;
    if (watchWidgetUpdateHandle) {
      clearTimeout(watchWidgetUpdateHandle);
      watchWidgetUpdateHandle = undefined;
    }
    lastWatchWidgetUpdateAt = 0;
  },

  parseFinalReportFromTexts,
  buildConfidenceRating,
  getAgentReportData,

  setDefaultTimeoutSeconds(seconds: number | undefined) {
    defaultTimeoutSeconds = seconds;
  },

  setTimeoutEscalationDelayMs(delayMs: number) {
    timeoutEscalationDelayMs = delayMs;
  },

  setCompletionSender(
    sender:
      | ((content: string, details?: Record<string, unknown>) => void)
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
      },
    } as unknown as ChildProcess;

    const agent: SubAgent = {
      id,
      process: mockProcess,
      task: "test task",
      taskTitle: "test task",
      status: "running",
      output: [],
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
};
