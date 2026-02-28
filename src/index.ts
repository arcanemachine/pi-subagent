import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { spawn, ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { Container, SelectList, Text, type SelectItem, DynamicBorder } from "@mariozechner/pi-tui";

interface SubAgent {
  id: string;
  process: ChildProcess;
  task: string;
  status: "starting" | "running" | "completed" | "error";
  output: string[];
  startTime: number;
  endTime?: number;
  currentTool?: string;
  lastActivity: number;
}

const activeAgents = new Map<string, SubAgent>();
let currentCtx: ExtensionContext | null = null;

function spawnSubAgent(task: string): SubAgent {
  const id = randomUUID().slice(0, 8);
  
  const proc = spawn("pi", ["--mode", "rpc", "--no-session"], {
    stdio: ["pipe", "pipe", "pipe"],
  });

  const agent: SubAgent = {
    id,
    process: proc,
    task,
    status: "starting",
    output: [],
    startTime: Date.now(),
    lastActivity: Date.now(),
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
        
        // Track what the sub-agent is currently doing
        if (event.type === "tool_execution_start") {
          agent.currentTool = `${event.toolName}(${JSON.stringify(event.args).slice(0, 50)}...)`;
        } else if (event.type === "tool_execution_end" || event.type === "agent_end") {
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
        }
      } catch (e) {
        // Ignore parse errors
      }
    }
    
    // Update widget to show current activity
    updateSubAgentStatus();
  });

  // Handle stderr
  proc.stderr?.on("data", (data: Buffer) => {
    agent.output.push(`[stderr]: ${data.toString().trim()}`);
  });

  // Handle process exit
  proc.on("exit", (code) => {
    if (code !== 0 && agent.status !== "completed") {
      agent.status = "error";
      agent.endTime = Date.now();
    }
    updateSubAgentStatus();
  });

  // Send the initial prompt
  const prompt = JSON.stringify({ type: "prompt", message: task });
  proc.stdin?.write(prompt + "\n");

  activeAgents.set(id, agent);
  updateSubAgentStatus();
  return agent;
}

function getActiveAgentCount(): number {
  return Array.from(activeAgents.values()).filter(
    a => a.status !== "completed" && a.status !== "error"
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

async function waitForSubAgent(id: string, timeoutMs = 120000): Promise<boolean> {
  const agent = activeAgents.get(id);
  if (!agent) return false;
  
  const startTime = Date.now();
  while (agent.status !== "completed" && agent.status !== "error") {
    if (Date.now() - startTime > timeoutMs) {
      return false;
    }
    await new Promise(r => setTimeout(r, 100));
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
        transcript.push(`🔧 ${event.toolName}: ${JSON.stringify(event.args).slice(0, 100)}`);
      } else if (event.type === "message_update" && event.assistantMessageEvent) {
        const delta = event.assistantMessageEvent;
        if (delta.type === "text_delta") {
          currentMessage += delta.delta;
        } else if (delta.type === "toolcall_start") {
          if (currentMessage.trim()) {
            transcript.push(`💬 ${currentMessage.trim()}`);
            currentMessage = "";
          }
        }
      } else if (event.type === "agent_end" && event.messages) {
        // Final assistant messages
        for (const msg of event.messages) {
          if (msg.role === "assistant" && Array.isArray(msg.content)) {
            const text = msg.content
              .filter((c: any) => c.type === "text")
              .map((c: any) => c.text)
              .join("");
            if (text.trim()) transcript.push(`💬 ${text.trim()}`);
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

  return `
## Sub-Agent ${id}

**Task:** ${agent.task}
**Status:** ${agent.status}
**Duration:** ${duration}s
**Events:** ${agent.output.length}

### Transcript
${transcript.join("\n\n") || "(no activity yet)"}
`;
}

async function handleInteract(pi: ExtensionAPI, ctx: ExtensionContext): Promise<void> {
  // Get active agents only
  const active = Array.from(activeAgents.values()).filter(
    a => a.status === "running" || a.status === "starting"
  );
  
  if (active.length === 0) {
    ctx.ui.notify("No active sub-agents", "info");
    return;
  }
  
  // Create agent selection items
  const agentItems: SelectItem[] = active.map((agent, index) => ({
    value: agent.id,
    label: `${index + 1}) ${agent.id} — ${agent.status} (${Math.floor((Date.now() - agent.startTime) / 1000)}s)`,
  }));
  
  // Show agent selection dialog
  const selectedAgentId = await ctx.ui.custom<string | null>(
    (_tui, theme, _keybindings, done) => {
      const container = new Container();
      container.addChild(new Text("Select sub-agent:", 0, 1));
      
      const selectList = new SelectList(agentItems, Math.min(agentItems.length, 10), {
        selectedPrefix: (t) => theme.fg("accent", t),
        selectedText: (t) => theme.fg("accent", t),
      });
      
      selectList.onSelect = (item) => done(item.value as string);
      selectList.onCancel = () => done(null);
      
      container.addChild(selectList);
      container.addChild(new Text(theme.fg("dim", "↑↓ navigate • enter select • esc cancel"), 1, 0));
      
      return new DynamicBorder(container, { title: "Sub-Agents" });
    },
    { overlay: true }
  );
  
  if (!selectedAgentId) return;
  
  // Show action selection dialog
  const actionItems: SelectItem[] = [
    { value: "report", label: "report — Get transcript" },
    { value: "kill", label: "kill — Stop the agent" },
    { value: "wait", label: "wait — Wait for completion" },
  ];
  
  const selectedAction = await ctx.ui.custom<string | null>(
    (_tui, theme, _keybindings, done) => {
      const container = new Container();
      container.addChild(new Text(`Agent: ${selectedAgentId}`, 0, 1));
      container.addChild(new Text("Select action:", 0, 1));
      
      const selectList = new SelectList(actionItems, actionItems.length, {
        selectedPrefix: (t) => theme.fg("accent", t),
        selectedText: (t) => theme.fg("accent", t),
      });
      
      selectList.onSelect = (item) => done(item.value as string);
      selectList.onCancel = () => done(null);
      
      container.addChild(selectList);
      container.addChild(new Text(theme.fg("dim", "↑↓ navigate • enter select • esc cancel"), 1, 0));
      
      return new DynamicBorder(container, { title: "Action" });
    },
    { overlay: true }
  );
  
  if (!selectedAction) return;
  
  // Execute selected action
  switch (selectedAction) {
    case "report":
      const report = getAgentReport(selectedAgentId);
      pi.sendMessage({
        customType: "subagent-report",
        content: report,
        display: true,
      });
      ctx.ui.notify(`Report for ${selectedAgentId} added to conversation`, "info");
      break;
    case "kill":
      if (killSubAgent(selectedAgentId)) {
        ctx.ui.notify(`Killed sub-agent ${selectedAgentId}`, "info");
      }
      break;
    case "wait":
      ctx.ui.notify(`Waiting for ${selectedAgentId}...`, "info");
      await waitForSubAgent(selectedAgentId);
      ctx.ui.notify(`${selectedAgentId} completed`, "info");
      break;
  }
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
        { value: "interact", label: "interact — Interactively manage sub-agents" },
        { value: "report", label: "report <id> — Get transcript of agent activity" },
        { value: "list", label: "list — List all sub-agents" },
        { value: "kill", label: "kill <id> — Kill a specific sub-agent" },
        { value: "killall", label: "killall — Kill all sub-agents" },
        { value: "prune", label: "prune — Remove completed sub-agents from list" },
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
          const agent = spawnSubAgent(subArgs);
          ctx.ui.notify(`Spawned sub-agent ${agent.id}`, "info");
          
          // Send a message to the conversation showing what was spawned
          pi.sendMessage({
            customType: "subagent-spawned",
            content: `🚀 Spawned sub-agent **${agent.id}**\nTask: ${agent.task}`,
            display: true,
          });
          break;

        case "report":
          if (!subArgs) {
            ctx.ui.notify("Usage: /subagent report <id>", "error");
            return;
          }
          const report = getAgentReport(subArgs);
          // Send to conversation so LLM can see it
          pi.sendMessage({
            customType: "subagent-report",
            content: report,
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

        case "interact":
          await handleInteract(pi, ctx);
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
          ctx.ui.notify(`Pruned ${pruned} completed sub-agents`, "info");
          break;
        }

        default:
          ctx.ui.notify("Usage: /subagent {spawn|interact|report|list|kill|killall|prune} [args]", "error");
      }
    },
  });

  // Tool: Spawn a sub-agent and immediately show it in conversation
  pi.registerTool({
    name: "spawn_subagent",
    label: "Spawn Sub-Agent",
    description: "Spawn a sub-agent to work on a task in parallel. " +
      "The sub-agent will appear in the active agents widget. " +
      "Use subagent_report to get full details when done.",
    parameters: {
      type: "object",
      properties: {
        task: {
          type: "string",
          description: "Clear, specific task for the sub-agent to complete",
        },
      },
      required: ["task"],
    } as const,
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const agent = spawnSubAgent(params.task);
      
      return {
        content: [{
          type: "text",
          text: `🚀 Spawned sub-agent **${agent.id}**\n` +
                `Task: ${agent.task}\n\n` +
                `The sub-agent is now running in parallel. You can:\n` +
                `- Watch its progress in the widget above\n` +
                `- Run \`/subagent report ${agent.id}\` to see full details\n` +
                `- Spawn more sub-agents for parallel work`,
        }],
        details: { agentId: agent.id, task: agent.task },
      };
    },
  });

  // Tool: Get a detailed report of what a sub-agent did
  pi.registerTool({
    name: "subagent_report",
    label: "Sub-Agent Report",
    description: "Get a full transcript of a sub-agent's activity. " +
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
    } as const,
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const report = getAgentReport(params.agent_id);
      
      return {
        content: [{
          type: "text",
          text: report,
        }],
        details: { agentId: params.agent_id },
      };
    },
  });

  // Tool: Spawn multiple sub-agents in parallel and wait for all
  pi.registerTool({
    name: "spawn_parallel",
    label: "Spawn Parallel Sub-Agents",
    description: "Spawn multiple sub-agents to work on different tasks in parallel. " +
      "Returns when all complete. Great for analyzing multiple files or components.",
    parameters: {
      type: "object",
      properties: {
        tasks: {
          type: "array",
          items: { type: "string" },
          description: "Array of tasks, one per sub-agent",
        },
        timeout_ms: {
          type: "number",
          description: "Max time to wait for all to complete",
          default: 120000,
        },
      },
      required: ["tasks"],
    } as const,
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const agents: SubAgent[] = [];
      
      // Spawn all agents
      for (const task of params.tasks) {
        agents.push(spawnSubAgent(task));
      }
      
      onUpdate?.({
        content: [{
          type: "text",
          text: `Spawned ${agents.length} sub-agents:\n` +
                agents.map(a => `- ${a.id}: ${a.task.slice(0, 50)}...`).join("\n"),
        }],
      });
      
      // Wait for all to complete
      const timeout = params.timeout_ms || 120000;
      const startTime = Date.now();
      
      while (true) {
        const allDone = agents.every(a => 
          a.status === "completed" || a.status === "error"
        );
        if (allDone) break;
        
        if (Date.now() - startTime > timeout) {
          return {
            content: [{
              type: "text",
              text: `Timeout after ${timeout}ms. Some sub-agents still running.`,
            }],
            isError: true,
            details: { 
              agents: agents.map(a => ({ id: a.id, status: a.status })),
            },
          };
        }
        
        await new Promise(r => setTimeout(r, 100));
      }
      
      // Generate reports for all
      const reports = agents.map(a => getAgentReport(a.id));
      
      return {
        content: [{
          type: "text",
          text: `## All ${agents.length} Sub-Agents Complete\n\n` +
                reports.join("\n---\n"),
        }],
        details: {
          agents: agents.map(a => ({ id: a.id, status: a.status })),
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
}
