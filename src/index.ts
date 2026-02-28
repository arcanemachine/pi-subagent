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
  endTime?: number;
  result?: string;
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
          agent.endTime = Date.now();
          // Extract final messages from agent_end
          if (event.messages && event.messages.length > 0) {
            const lastAssistant = event.messages
              .reverse()
              .find((m: any) => m.role === "assistant" && m.content);
            if (lastAssistant) {
              agent.result = JSON.stringify(lastAssistant.content);
            }
          }
        }
      } catch (e) {
        // Ignore parse errors, store raw
        agent.output.push(line);
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
      agent.endTime = Date.now();
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

async function waitForSubAgent(id: string, timeoutMs: number = 60000): Promise<SubAgent | null> {
  const agent = activeAgents.get(id);
  if (!agent) return null;

  const startWait = Date.now();
  while (agent.status !== "completed" && agent.status !== "error") {
    if (Date.now() - startWait > timeoutMs) {
      return null; // Timeout
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
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
  
  const duration = agent.endTime 
    ? Math.floor((agent.endTime - agent.startTime) / 1000)
    : Math.floor((Date.now() - agent.startTime) / 1000);
  
  // Extract text content from recent message_update events
  const textOutputs: string[] = [];
  for (const line of agent.output.slice(-20)) {
    try {
      const event = JSON.parse(line);
      if (event.type === "message_update" && event.assistantMessageEvent?.type === "text_delta") {
        textOutputs.push(event.assistantMessageEvent.delta);
      }
    } catch {}
  }
  
  const recentText = textOutputs.slice(-10).join("") || "(no text output yet)";
  
  return `
SubAgent ${id}:
  Status: ${agent.status}
  Task: ${agent.task}
  Duration: ${duration}s
  Output events: ${agent.output.length}
  
Recent text output:
${recentText.slice(0, 500)}${recentText.length > 500 ? "..." : ""}
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

        case "wait":
          if (!subArgs) {
            ctx.ui.notify("Usage: /subagent wait <id> [timeout_ms]", "error");
            return;
          }
          const [waitId, timeoutStr] = subArgs.split(/\s+/);
          const timeout = parseInt(timeoutStr) || 60000;
          ctx.ui.notify(`Waiting for ${waitId} (timeout: ${timeout}ms)...`, "info");
          const result = await waitForSubAgent(waitId, timeout);
          if (result) {
            ctx.ui.notify(`Sub-agent ${waitId} finished with status: ${result.status}`, "info");
          } else {
            ctx.ui.notify(`Timeout or agent not found`, "error");
          }
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
            "Usage: /subagent {spawn|list|status|wait|kill|killall} [args]",
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

  // Register a tool that waits for a sub-agent and returns results
  pi.registerTool({
    name: "wait_for_subagent",
    label: "Wait for Sub-Agent",
    description: "Wait for a sub-agent to complete and return its results. " +
      "Optionally specify a timeout in milliseconds (default: 60s).",
    parameters: {
      type: "object",
      properties: {
        agent_id: {
          type: "string",
          description: "The ID of the sub-agent to wait for",
        },
        timeout_ms: {
          type: "number",
          description: "Maximum time to wait in milliseconds",
          default: 60000,
        },
      },
      required: ["agent_id"],
    } as const,
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const timeout = params.timeout_ms || 60000;
      const agent = await waitForSubAgent(params.agent_id, timeout);
      
      if (!agent) {
        return {
          content: [{
            type: "text",
            text: `Sub-agent ${params.agent_id} not found or timed out after ${timeout}ms`,
          }],
          isError: true,
          details: { agentId: params.agent_id, timeout },
        };
      }
      
      // Extract final result from agent_end event
      let finalOutput = "";
      for (const line of agent.output) {
        try {
          const event = JSON.parse(line);
          if (event.type === "agent_end" && event.messages) {
            const assistantMsgs = event.messages
              .filter((m: any) => m.role === "assistant")
              .map((m: any) => {
                if (typeof m.content === "string") return m.content;
                if (Array.isArray(m.content)) {
                  return m.content
                    .filter((c: any) => c.type === "text")
                    .map((c: any) => c.text)
                    .join("\n");
                }
                return "";
              });
            finalOutput = assistantMsgs.join("\n\n");
          }
        } catch {}
      }
      
      return {
        content: [{
          type: "text",
          text: `Sub-agent ${agent.id} completed with status: ${agent.status}\n\n` +
            `Task: ${agent.task}\n` +
            `Duration: ${agent.endTime ? Math.floor((agent.endTime - agent.startTime) / 1000) : "unknown"}s\n\n` +
            `Result:\n${finalOutput || "(no output captured)"}`,
        }],
        details: { 
          agentId: agent.id, 
          status: agent.status,
          result: agent.result,
        },
      };
    },
  });

  // Register a combined tool that spawns and waits
  pi.registerTool({
    name: "run_subagent_task",
    label: "Run Sub-Agent Task",
    description: "Spawn a sub-agent, wait for it to complete, and return the results. " +
      "This is a convenience tool that combines spawn_subagent and wait_for_subagent. " +
      "Use for tasks that should run in isolation and you need the result from.",
    parameters: {
      type: "object",
      properties: {
        task: {
          type: "string",
          description: "The task to assign to the sub-agent",
        },
        timeout_ms: {
          type: "number",
          description: "Maximum time to wait in milliseconds",
          default: 120000,
        },
      },
      required: ["task"],
    } as const,
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      // Spawn the sub-agent
      const agent = spawnSubAgent(params.task, ctx);
      
      // Stream progress updates
      onUpdate?.({
        content: [{
          type: "text",
          text: `Spawned sub-agent ${agent.id}, waiting for completion...`,
        }],
      });
      
      // Wait for completion
      const timeout = params.timeout_ms || 120000;
      const result = await waitForSubAgent(agent.id, timeout);
      
      if (!result) {
        killSubAgent(agent.id);
        return {
          content: [{
            type: "text",
            text: `Sub-agent ${agent.id} timed out after ${timeout}ms`,
          }],
          isError: true,
          details: { agentId: agent.id, timeout },
        };
      }
      
      // Extract final output
      let finalOutput = "";
      for (const line of result.output) {
        try {
          const event = JSON.parse(line);
          if (event.type === "agent_end" && event.messages) {
            const assistantMsgs = event.messages
              .filter((m: any) => m.role === "assistant")
              .map((m: any) => {
                if (typeof m.content === "string") return m.content;
                if (Array.isArray(m.content)) {
                  return m.content
                    .filter((c: any) => c.type === "text")
                    .map((c: any) => c.text)
                    .join("\n");
                }
                return "";
              });
            finalOutput = assistantMsgs.join("\n\n");
          }
        } catch {}
      }
      
      // Clean up
      activeAgents.delete(agent.id);
      
      return {
        content: [{
          type: "text",
          text: `Sub-agent completed with status: ${result.status}\n\n` +
            `Task: ${result.task}\n` +
            `Duration: ${result.endTime ? Math.floor((result.endTime - result.startTime) / 1000) : "unknown"}s\n\n` +
            `Result:\n${finalOutput || "(no output captured)"}`,
        }],
        details: { 
          agentId: result.id, 
          status: result.status,
        },
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