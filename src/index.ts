import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { spawn, ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";

interface SubAgent {
  id: string;
  process: ChildProcess;
  task: string;
  status: "starting" | "running" | "completed" | "error";
  output: string[];
  startTime: number;
}

const activeAgents = new Map<string, SubAgent>();

function spawnSubAgent(task: string, ctx: ExtensionContext): SubAgent {
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
  };

  // Handle stdout (JSON events)
  let buffer = "";
  proc.stdout?.on("data", (data: Buffer) => {
    buffer += data.toString();
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";
    
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const event = JSON.parse(line);
        agent.output.push(line);
        
        // Update status based on events
        if (event.type === "agent_start") {
          agent.status = "running";
        } else if (event.type === "agent_end") {
          agent.status = "completed";
        }
      } catch (e) {
        // Ignore parse errors
      }
    }
  });

  // Handle stderr
  proc.stderr?.on("data", (data: Buffer) => {
    agent.output.push(`[stderr]: ${data.toString().trim()}`);
  });

  // Handle process exit
  proc.on("exit", (code) => {
    if (code !== 0 && agent.status !== "completed") {
      agent.status = "error";
    }
  });

  // Send the initial prompt
  const prompt = JSON.stringify({
    type: "prompt",
    message: task,
  });
  
  proc.stdin?.write(prompt + "\n", (err) => {
    if (err) {
      agent.status = "error";
      agent.output.push(`[error]: Failed to send prompt: ${err.message}`);
    }
  });

  activeAgents.set(id, agent);
  return agent;
}

function killSubAgent(id: string): boolean {
  const agent = activeAgents.get(id);
  if (!agent) return false;
  
  agent.process.kill();
  activeAgents.delete(id);
  return true;
}

function getAgentStatus(id: string): string {
  const agent = activeAgents.get(id);
  if (!agent) return `Agent ${id} not found`;
  
  const duration = Math.floor((Date.now() - agent.startTime) / 1000);
  const recentOutput = agent.output.slice(-5).join("\n");
  
  return `
SubAgent ${id}:
  Status: ${agent.status}
  Task: ${agent.task}
  Duration: ${duration}s
  Output lines: ${agent.output.length}
  
Recent output:
${recentOutput || "(no output yet)"}
`;
}

export default function (pi: ExtensionAPI) {
  // Register /subagent command with subcommands
  pi.registerCommand("subagent", {
    description: "Spawn and manage sub-agents via RPC",
    handler: async (args: string, ctx) => {
      const [subcommand, ...rest] = args.trim().split(/\s+/);
      const subArgs = rest.join(" ");

      switch (subcommand) {
        case "spawn":
          if (!subArgs) {
            ctx.ui.notify("Usage: /subagent spawn <task>", "error");
            return;
          }
          const agent = spawnSubAgent(subArgs, ctx);
          ctx.ui.notify(`Spawned sub-agent ${agent.id}`, "info");
          ctx.ui.setStatus("subagent", `${activeAgents.size} active`);
          break;

        case "list":
          if (activeAgents.size === 0) {
            ctx.ui.notify("No active sub-agents", "info");
          } else {
            const list = Array.from(activeAgents.entries())
              .map(([id, a]) => `${id}: ${a.status} - "${a.task.slice(0, 50)}..."`)
              .join("\n");
            ctx.ui.notify(`Active sub-agents:\n${list}`, "info");
          }
          break;

        case "status":
          if (!subArgs) {
            ctx.ui.notify("Usage: /subagent status <id>", "error");
            return;
          }
          const status = getAgentStatus(subArgs);
          ctx.ui.notify(status, "info");
          break;

        case "kill":
          if (!subArgs) {
            ctx.ui.notify("Usage: /subagent kill <id>", "error");
            return;
          }
          if (killSubAgent(subArgs)) {
            ctx.ui.notify(`Killed sub-agent ${subArgs}`, "info");
            ctx.ui.setStatus("subagent", `${activeAgents.size} active`);
          } else {
            ctx.ui.notify(`Sub-agent ${subArgs} not found`, "error");
          }
          break;

        case "killall":
          for (const [id] of activeAgents) {
            killSubAgent(id);
          }
          ctx.ui.notify("Killed all sub-agents", "info");
          ctx.ui.setStatus("subagent", "0 active");
          break;

        default:
          ctx.ui.notify(
            "Usage: /subagent {spawn|list|status|kill|killall} [args]",
            "error"
          );
      }
    },
  });

  // Register a tool that LLM can use to spawn sub-agents
  pi.registerTool({
    name: "spawn_subagent",
    label: "Spawn Sub-Agent",
    description: "Spawn a pi sub-agent via RPC to handle a task in parallel. " +
      "The sub-agent runs independently and can use all standard pi tools. " +
      "Use this to parallelize work or isolate risky operations.",
    parameters: {
      type: "object",
      properties: {
        task: {
          type: "string",
          description: "The task to assign to the sub-agent",
        },
      },
      required: ["task"],
    } as const,
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const agent = spawnSubAgent(params.task, ctx);
      
      // Wait a bit for the agent to start
      await new Promise(resolve => setTimeout(resolve, 100));
      
      return {
        content: [{
          type: "text",
          text: `Spawned sub-agent ${agent.id}\n` +
            `Task: ${agent.task}\n` +
            `Status: ${agent.status}\n` +
            `\nUse /subagent status ${agent.id} to check progress`,
        }],
        details: { agentId: agent.id, task: agent.task },
      };
    },
  });

  // Clean up on shutdown
  pi.on("session_shutdown", async () => {
    for (const [id] of activeAgents) {
      killSubAgent(id);
    }
  });

  // Set initial status
  pi.on("session_start", async (_event, ctx) => {
    ctx.ui.setStatus("subagent", "ready");
  });
}
