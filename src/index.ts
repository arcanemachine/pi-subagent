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
  model?: string;
  status: "starting" | "running" | "completed" | "error";
  output: string[];
  startTime: number;
  endTime?: number;
  exitCode?: number;
  currentTool?: string;
  lastActivity: number;
  receivedEvent: boolean;
}

const activeAgents = new Map<string, SubAgent>();
let currentCtx: ExtensionContext | null = null;
let watchedAgentIds: Set<string> = new Set();
let nextAgentId = 1;
let watchAllMode = false; // True when watching all agents (auto-add new ones)

type PiSubagentSettings = {
  model?: string;
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

function getPiSubagentSettings(cwd: string): PiSubagentSettings {
  const globalSettingsPath = join(getAgentDir(), "settings.json");
  const projectSettingsPath = join(cwd, ".pi", "settings.json");

  const globalSettings = readJsonFile(globalSettingsPath);
  const projectSettings = readJsonFile(projectSettingsPath);

  const globalSubagent = globalSettings["pi-subagent"];
  const projectSubagent = projectSettings["pi-subagent"];

  const globalModelValue =
    globalSubagent && typeof globalSubagent === "object"
      ? (globalSubagent as Record<string, unknown>).model
      : undefined;
  const globalModel =
    typeof globalModelValue === "string" ? globalModelValue : undefined;

  const projectModelValue =
    projectSubagent && typeof projectSubagent === "object"
      ? (projectSubagent as Record<string, unknown>).model
      : undefined;
  const projectModel =
    typeof projectModelValue === "string" ? projectModelValue : undefined;

  return {
    model: projectModel ?? globalModel,
  };
}

function getCurrentModelId(
  ctx: ExtensionContext | null | undefined,
): string | undefined {
  if (!ctx?.model) return undefined;
  return `${ctx.model.provider}/${ctx.model.id}`;
}

function resolveSubAgentModel(
  requestedModel: string | undefined,
  ctx: ExtensionContext | null | undefined,
): string | undefined {
  const explicitModel = requestedModel?.trim();
  if (explicitModel) return explicitModel;

  const configModel = getPiSubagentSettings(
    ctx?.cwd ?? process.cwd(),
  ).model?.trim();
  if (configModel) return configModel;

  return getCurrentModelId(ctx);
}

function spawnSubAgent(task: string, model?: string): SubAgent {
  const id = String(nextAgentId++);

  const args = ["--mode", "rpc", "--no-session"];
  if (model) {
    args.push("--model", model);
  }

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
    model,
    status: "starting",
    output: [],
    startTime: Date.now(),
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
        } else if (
          event.type === "tool_execution_end" ||
          event.type === "agent_end"
        ) {
          agent.currentTool = undefined;
        }

        // Update status
        if (event.type === "agent_start") {
          agent.status = "running";
        } else if (event.type === "agent_end") {
          agent.status = "completed";
          agent.endTime = Date.now();
          agent.currentTool = undefined;
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
    agent.output.push(`[stderr]: ${data.toString().trim()}`);
    agent.lastActivity = Date.now();
  });

  // Handle process exit
  proc.on("exit", (code) => {
    agent.exitCode = code ?? undefined;
    if (code !== 0 && agent.status !== "completed") {
      agent.status = "error";
      agent.endTime = Date.now();
    }
    updateSubAgentStatus();
    // Update watch widget if being watched
    if (watchedAgentIds.has(id)) {
      updateWatchWidget();
    }
  });

  // Send the initial prompt
  const prompt = JSON.stringify({ type: "prompt", message: task });
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
  return `active subagents: ${getActiveAgentCount()}`;
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

  for (const id of watchedAgentIds) {
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

    const noResponseYet =
      (agent.status === "starting" || agent.status === "running") &&
      !agent.receivedEvent &&
      Date.now() - agent.startTime > 5000;

    if (compactMode) {
      // Compact: one line per agent
      const toolInfo = agent.currentTool
        ? ` | ${agent.currentTool.slice(0, 40)}`
        : noResponseYet
          ? " | no response yet"
          : "";
      widgetLines.push(
        `${statusIcon} ${id} ${agent.status} ${duration}s${toolInfo}`,
      );
    } else {
      // Verbose: full info with transcript
      widgetLines.push(`${statusIcon} ${id} (${agent.status}) | ${duration}s`);
      widgetLines.push(
        `Task: ${agent.task.slice(0, 50)}${agent.task.length > 50 ? "..." : ""}`,
      );

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
  timeoutMs = 120000,
): Promise<boolean> {
  const agent = activeAgents.get(id);
  if (!agent) return false;

  const startTime = Date.now();
  while (agent.status !== "completed" && agent.status !== "error") {
    if (Date.now() - startTime > timeoutMs) {
      return false;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  return agent.status === "completed";
}

function getAgentReport(id: string): string {
  const agent = activeAgents.get(id);
  if (!agent) return `Agent ${id} not found`;

  // Build a readable transcript of what the sub-agent did
  const transcript: string[] = [];
  let currentMessage = "";

  for (const line of agent.output) {
    try {
      const event = JSON.parse(line);

      if (event.type === "tool_execution_start") {
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

  if (currentMessage.trim()) {
    transcript.push(`💬 ${currentMessage.trim()}`);
  }

  const duration = agent.endTime
    ? Math.floor((agent.endTime - agent.startTime) / 1000)
    : Math.floor((Date.now() - agent.startTime) / 1000);

  if (transcript.length === 0 && agent.output.length > 0) {
    const fallbackLines = agent.output
      .slice(-8)
      .map(
        (line) => `📄 ${line.slice(0, 200)}${line.length > 200 ? "..." : ""}`,
      );
    transcript.push(...fallbackLines);
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

  return `
## Sub-Agent ${id}

**Task:** ${agent.task}
**Model:** ${agent.model || "(plugin default)"}
**Status:** ${agent.status}
**Duration:** ${duration}s
**Exit code:** ${agent.exitCode ?? "(running)"}

### Diagnostics
${diagnostics.join("\n\n") || "(none)"}

### Transcript
${transcript.join("\n\n") || "(no activity yet)"}
`;
}

function killSubAgent(id: string): boolean {
  const agent = activeAgents.get(id);
  if (!agent) return false;

  agent.process.kill();
  activeAgents.delete(id);
  updateSubAgentStatus();
  return true;
}

export default function (pi: ExtensionAPI) {
  // Register /subagent command
  pi.registerCommand("subagent", {
    description: "Spawn and manage sub-agents",
    getArgumentCompletions: (prefix: string) => {
      const items = [
        { value: "spawn", label: "spawn <task> — Spawn a new sub-agent" },
        {
          value: "report",
          label: "report <id> — Get transcript of agent activity",
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
        { value: "append", label: "append <id> — Add report to context" },
      ];
      return items.filter((i) => i.value.startsWith(prefix));
    },
    handler: async (args: string, ctx) => {
      const [subcommand, ...rest] = args.trim().split(/\s+/);
      const subArgs = rest.join(" ");

      switch (subcommand) {
        case "spawn":
          if (!subArgs) {
            ctx.ui.notify("Usage: /subagent spawn <task>", "error");
            return;
          }
          const model = resolveSubAgentModel(undefined, ctx);
          const agent = spawnSubAgent(subArgs, model);
          ctx.ui.notify(`Spawned sub-agent ${agent.id}`, "info");

          // Send a message to the conversation showing what was spawned
          pi.sendMessage({
            customType: "subagent-spawned",
            content:
              `🚀 Spawned sub-agent **${agent.id}**\n` +
              `Task: ${agent.task}\n` +
              `Model: ${agent.model || "(plugin default)"}`,
            display: true,
          });
          break;

        case "report":
          if (!subArgs) {
            ctx.ui.notify("Usage: /subagent report <id>", "error");
            return;
          }
          const report = getAgentReport(subArgs);
          // Just display to user, don't add to context
          const separator = "─".repeat(40);
          ctx.ui.notify(`${separator}\n${report}\n${separator}`, "info");
          break;

        case "append":
          if (!subArgs) {
            ctx.ui.notify("Usage: /subagent append <id>", "error");
            return;
          }
          const reportToAppend = getAgentReport(subArgs);
          // Send to conversation so LLM can see it
          pi.sendMessage({
            customType: "subagent-report",
            content: reportToAppend,
            display: true,
          });
          ctx.ui.notify(`Report for ${subArgs} added to conversation`, "info");
          break;

        case "list":
          if (activeAgents.size === 0) {
            ctx.ui.notify("No active sub-agents", "info");
          } else {
            const list = Array.from(activeAgents.entries())
              .map(([id, a]) => `${id}: ${a.status}`)
              .join("\n");
            ctx.ui.notify(`Active sub-agents:\n${list}`, "info");
          }
          break;

        case "kill":
          if (!subArgs) {
            ctx.ui.notify("Usage: /subagent kill <id>", "error");
            return;
          }
          if (killSubAgent(subArgs)) {
            ctx.ui.notify(`Killed sub-agent ${subArgs}`, "info");
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
            "Usage: /subagent {spawn|report|append|list|kill|killall|prune|show|hide} [args]",
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
      "Set `model` to choose the model for this sub-agent (pattern or provider/model). " +
      "If `model` is omitted, settings key `pi-subagent.model` is used when present; otherwise current session model is used. " +
      "The sub-agent will appear in the active agents widget. " +
      "Use subagent_report to get full details when done.",
    parameters: {
      type: "object",
      properties: {
        task: {
          type: "string",
          description: "Clear, specific task for the sub-agent to complete",
        },
        model: {
          type: "string",
          description:
            "Model pattern or provider/model for this sub-agent. Overrides pi-subagent.model and current session model.",
        },
      },
      required: ["task"],
    } as any,
    async execute(
      toolCallId,
      params: { task: string; model?: string },
      signal,
      onUpdate,
      ctx,
    ) {
      const model = resolveSubAgentModel(params.model, ctx);
      const agent = spawnSubAgent(params.task, model);

      return {
        content: [
          {
            type: "text",
            text:
              `🚀 Spawned sub-agent **${agent.id}**\n` +
              `Task: ${agent.task}\n` +
              `Model: ${agent.model || "(plugin default)"}\n\n` +
              `The sub-agent is now running in parallel. You can:\n` +
              `- Watch its progress in the widget above\n` +
              `- Run \`/subagent report ${agent.id}\` to see full details\n` +
              `- Spawn more sub-agents for parallel work`,
          },
        ],
        details: { agentId: agent.id, task: agent.task, model: agent.model },
      };
    },
  });

  // Tool: Get a detailed report of what a sub-agent did
  pi.registerTool({
    name: "subagent_report",
    label: "Sub-Agent Report",
    description:
      "Get a full transcript of a sub-agent's activity. " +
      "Shows all tool calls, messages, and final results. " +
      "Use this to understand what a sub-agent accomplished.",
    parameters: {
      type: "object",
      properties: {
        agent_id: {
          type: "string",
          description: "The sub-agent ID to get the report for",
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
      const report = getAgentReport(params.agent_id);

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

  // Tool: Spawn multiple sub-agents in parallel and wait for all
  pi.registerTool({
    name: "spawn_parallel",
    label: "Spawn Parallel Sub-Agents",
    description:
      "Spawn multiple sub-agents to work on different tasks in parallel. " +
      "Set `model` to choose the model for all spawned sub-agents (pattern or provider/model). " +
      "If `model` is omitted, settings key `pi-subagent.model` is used when present; otherwise current session model is used. " +
      "Returns when all complete. Great for analyzing multiple files or components.",
    parameters: {
      type: "object",
      properties: {
        tasks: {
          type: "array",
          items: { type: "string" },
          description: "Array of tasks, one per sub-agent",
        },
        model: {
          type: "string",
          description:
            "Model pattern or provider/model for all spawned sub-agents. Overrides pi-subagent.model and current session model.",
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
      params: { tasks: string[]; timeout_ms?: number; model?: string },
      signal,
      onUpdate,
      ctx,
    ) {
      const agents: SubAgent[] = [];
      const model = resolveSubAgentModel(params.model, ctx);

      // Spawn all agents
      for (const task of params.tasks) {
        agents.push(spawnSubAgent(task, model));
      }

      onUpdate?.({
        content: [
          {
            type: "text",
            text:
              `Spawned ${agents.length} sub-agents:\n` +
              `Model: ${model || "(plugin default)"}\n` +
              agents
                .map((a) => `- ${a.id}: ${a.task.slice(0, 50)}...`)
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
          model,
          agents: agents.map((a) => ({ id: a.id, status: a.status })),
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
  });

  // Set up status on session start
  pi.on("session_start", async (_event, ctx) => {
    currentCtx = ctx;
    updateSubAgentStatus();
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
    }
  });
}
