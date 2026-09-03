import test from "node:test";
import assert from "node:assert/strict";
import type { ChildProcess } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { visibleWidth } from "@earendil-works/pi-tui";
import { initTheme } from "@earendil-works/pi-coding-agent";
import extension, { __test } from "./index";
import {
  SubagentFleetComponent,
  type FleetAgentDetail,
  type FleetDataSource,
} from "./fleet";

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function assistantMessage(
  text: string,
  stopReason: "stop" | "length" | "toolUse" | "error" | "aborted" = "stop",
  errorMessage?: string,
) {
  return {
    role: "assistant",
    content: text ? [{ type: "text", text }] : [],
    stopReason,
    errorMessage,
  };
}

function captureCompletions() {
  const sent: Array<{
    content: string;
    details?: Record<string, unknown>;
    options?: { triggerTurn?: boolean };
  }> = [];
  __test.setCompletionSender((content, details, options) =>
    sent.push({ content, details, options }),
  );
  return sent;
}

function createProjectSettings(agents: Record<string, unknown>): string {
  const cwd = mkdtempSync(join(tmpdir(), "pi-subagent-test-"));
  mkdirSync(join(cwd, ".pi"));
  writeFileSync(
    join(cwd, ".pi", "settings.json"),
    JSON.stringify({ "pi-subagent": { agents } }),
  );
  return cwd;
}

function createAgentSettingsDir(settings: Record<string, unknown>): string {
  const agentDir = mkdtempSync(join(tmpdir(), "pi-subagent-agent-"));
  writeFileSync(join(agentDir, "settings.json"), JSON.stringify(settings));
  return agentDir;
}

test("deep merges global and trusted project sub-agent settings", () => {
  const agentDir = createAgentSettingsDir({
    "pi-subagent": {
      max_active_subagents: 5,
      agents: {
        global: {
          model: "provider/global",
          thinking_level: "high",
          when_to_use: "global guidance",
          extra_context: "global context",
          fork: "global-session",
        },
        retained: { model: "provider/retained" },
      },
    },
  });
  const cwd = createProjectSettings({
    global: {
      extra_context: "project context",
      fork: "project-session",
    },
    project: { model: "provider/project" },
  });
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;

  try {
    assert.deepEqual(__test.getPiSubagentSettings(cwd, true), {
      max_active_subagents: 5,
      default_timeout_seconds: undefined,
      allow_nested_subagents: false,
      agents: {
        global: {
          model: "provider/global",
          thinking_level: "high",
          when_to_use: "global guidance",
          extra_context: "project context",
          fork: "project-session",
        },
        retained: { model: "provider/retained" },
        project: { model: "provider/project" },
      },
    });

    assert.deepEqual(__test.getPiSubagentSettings(cwd, false).agents, {
      global: {
        model: "provider/global",
        thinking_level: "high",
        when_to_use: "global guidance",
        extra_context: "global context",
        fork: "global-session",
      },
      retained: { model: "provider/retained" },
    });
  } finally {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    rmSync(agentDir, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("deepMergeRecords replaces non-record values and merges nested records", () => {
  assert.deepEqual(
    __test.deepMergeRecords(
      { nested: { inherited: true }, list: ["global"], value: "global" },
      { nested: { override: true }, list: ["project"], value: "project" },
    ),
    {
      nested: { inherited: true, override: true },
      list: ["project"],
      value: "project",
    },
  );
});

test("builds persistent fork arguments without no-session", () => {
  assert.deepEqual(__test.buildSubAgentArgs("provider/model", "high"), [
    "--mode",
    "rpc",
    "--no-session",
    "--model",
    "provider/model",
    "--thinking",
    "high",
  ]);
  assert.deepEqual(
    __test.buildSubAgentArgs("provider/model", "high", "~/.pi/snapshot.jsonl"),
    [
      "--mode",
      "rpc",
      "--fork",
      "~/.pi/snapshot.jsonl",
      "--model",
      "provider/model",
      "--thinking",
      "high",
    ],
  );
});

test("normalizes supported thinking levels and preserves explicit off", () => {
  const levels = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
  for (const level of levels) {
    assert.equal(__test.normalizeThinkingLevel(level), level);
  }
  assert.equal(__test.normalizeThinkingLevel(" HIGH "), "high");
  assert.equal(__test.normalizeThinkingLevel("unsupported"), undefined);
  assert.equal(__test.normalizeThinkingLevel(42), undefined);
  assert.equal(
    __test.resolveThinkingLevel({ model: "provider/model" }, "medium"),
    "medium",
  );
  assert.equal(
    __test.resolveThinkingLevel(
      { model: "provider/model", thinking_level: "off" },
      "high",
    ),
    "off",
  );
});

test("spawns configured thinking levels and inherits the parent per spawn", async () => {
  __test.resetState();
  let parentThinkingLevel = "low";
  const cwd = createProjectSettings({
    configured: {
      model: "provider/configured",
      thinking_level: "high",
    },
    inherited: { model: "provider/inherited" },
    disabled: { model: "provider/disabled", thinking_level: "off" },
  });
  const spawnCalls: Array<{
    command: string;
    args: string[];
    options?: { cwd?: string };
  }> = [];
  const fakeProcess = {
    kill() {},
    on() {
      return this;
    },
    stdin: {
      destroyed: false,
      write() {},
      end() {},
    },
  } as unknown as ChildProcess;
  const tools: any[] = [];
  const extensionApi = {
    registerTool: (tool: any) => tools.push(tool),
    registerCommand() {},
    registerMessageRenderer() {},
    on() {},
    sendMessage() {},
    getThinkingLevel: () => parentThinkingLevel,
  };

  __test.setSpawnProcess(((
    command: string,
    args: string[],
    options?: { cwd?: string },
  ) => {
    spawnCalls.push({ command, args, options });
    return fakeProcess;
  }) as never);

  try {
    extension(extensionApi as any);
    const spawnTool = tools.find((tool) => tool.name === "subagent_spawn");
    assert.ok(spawnTool);

    const spawn = async (agent: string) =>
      spawnTool.execute(
        `call-${agent}`,
        { task: "test task", agent },
        undefined,
        undefined,
        { cwd },
      );

    const configuredResult = await spawn("configured");
    parentThinkingLevel = "medium";
    const inheritedResult = await spawn("inherited");
    parentThinkingLevel = "high";
    const disabledResult = await spawn("disabled");

    assert.deepEqual(
      spawnCalls.map(({ command, args }) => ({
        command,
        args: args.slice(-2),
      })),
      [
        { command: "pi", args: ["--thinking", "high"] },
        { command: "pi", args: ["--thinking", "medium"] },
        { command: "pi", args: ["--thinking", "off"] },
      ],
    );
    assert.equal(configuredResult.details.thinkingLevel, "high");
    assert.equal(inheritedResult.details.thinkingLevel, "medium");
    assert.equal(disabledResult.details.thinkingLevel, "off");
    assert.ok(spawnCalls.every(({ options }) => options?.cwd === cwd));
  } finally {
    __test.resetState();
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("spawns configured fork sessions from the project cwd", async () => {
  __test.resetState();
  const cwd = createProjectSettings({
    worker: {
      model: "provider/worker",
      fork: "~/.pi/agent/pi-session-snapshot/baseline.jsonl",
    },
  });
  const spawnCalls: Array<{
    command: string;
    args: string[];
    options?: { cwd?: string };
  }> = [];
  const fakeProcess = {
    kill() {},
    on() {
      return this;
    },
    stdin: {
      destroyed: false,
      write() {},
      end() {},
    },
  } as unknown as ChildProcess;
  const tools: any[] = [];

  __test.setSpawnProcess(((
    command: string,
    args: string[],
    options?: { cwd?: string },
  ) => {
    spawnCalls.push({ command, args, options });
    return fakeProcess;
  }) as never);

  try {
    extension({
      registerTool: (tool: any) => tools.push(tool),
      registerCommand() {},
      registerMessageRenderer() {},
      on() {},
      sendMessage() {},
      getThinkingLevel: () => "medium",
    } as any);

    const spawnTool = tools.find((tool) => tool.name === "subagent_spawn");
    assert.ok(spawnTool);
    assert.equal(
      Object.prototype.hasOwnProperty.call(
        spawnTool.parameters.properties,
        "fork",
      ),
      false,
    );

    await spawnTool.execute(
      "call-fork",
      { task: "use the snapshot context", agent: "worker" },
      undefined,
      undefined,
      { cwd, isProjectTrusted: () => true },
    );

    assert.equal(spawnCalls.length, 1);
    assert.deepEqual(
      {
        command: spawnCalls[0]?.command,
        args: spawnCalls[0]?.args,
      },
      {
        command: "pi",
        args: [
          "--mode",
          "rpc",
          "--fork",
          "~/.pi/agent/pi-session-snapshot/baseline.jsonl",
          "--model",
          "provider/worker",
          "--thinking",
          "medium",
        ],
      },
    );
    assert.equal(spawnCalls[0]?.options?.cwd, cwd);
  } finally {
    __test.resetState();
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("active status includes the robot suffix and trailing space", () => {
  __test.resetState();
  __test.setMaxActiveSubagents(5);
  __test.addMockAgent("T-status");

  assert.equal(__test.getStatusText(), "active subagents: 1/5 🤖 ");

  __test.resetState();
  __test.addMockAgent("T-status-unlimited");
  assert.equal(__test.getStatusText(), "active subagents: 1 🤖 ");
});

test("formats spawn output for agents and users", async () => {
  __test.resetState();
  const cwd = createProjectSettings({
    worker: { model: "provider/worker" },
  });
  const tools: any[] = [];
  const commands: any[] = [];
  const renderers = new Map<string, any>();
  const sentMessages: any[] = [];
  const fakeProcess = {
    kill() {},
    on() {
      return this;
    },
    stdin: {
      destroyed: false,
      write() {},
      end() {},
    },
  } as unknown as ChildProcess;
  const theme = {
    fg: (_color: string, text: string) => text,
    bg: (_color: string, text: string) => text,
    bold: (text: string) => text,
  } as never;

  __test.setSpawnProcess(((command: string, args: string[]) => {
    assert.equal(command, "pi");
    assert.deepEqual(args.slice(0, 3), ["--mode", "rpc", "--no-session"]);
    return fakeProcess;
  }) as never);

  try {
    extension({
      registerTool: (tool: any) => tools.push(tool),
      registerCommand: (name: string, command: any) =>
        commands.push({ name, command }),
      registerMessageRenderer: (type: string, renderer: any) =>
        renderers.set(type, renderer),
      on() {},
      sendMessage: (message: any) => sentMessages.push(message),
      getThinkingLevel: () => "medium",
    } as any);

    const spawnTool = tools.find((tool) => tool.name === "subagent_spawn");
    assert.ok(spawnTool);
    assert.match(
      spawnTool.parameters.properties.task.description,
      /self-contained.*expected deliverable/i,
    );
    assert.match(
      spawnTool.promptGuidelines?.join("\n") ?? "",
      /complete asynchronously.*notify automatically.*do not poll/i,
    );

    const result = await spawnTool.execute(
      "call-render",
      {
        agent: "worker",
        task: "Implement the adapter\n\n- Read the contract\n- Run the tests\n\nDeliverable: results.json",
        timeout_seconds: 600,
      },
      undefined,
      undefined,
      { cwd },
    );
    const parentText = result.content[0].text;
    assert.ok(
      parentText.startsWith("The sub-agent is now running in parallel."),
    );
    assert.ok(parentText.includes("Do NOT call subagent_status"));
    assert.ok(
      parentText.indexOf("Do NOT call") < parentText.indexOf("Agent ID:"),
    );
    assert.ok(!parentText.includes("Model:"));
    assert.ok(!parentText.includes("Thinking level:"));

    const compact = spawnTool.renderResult(
      result,
      { expanded: false, isPartial: false },
      theme,
      { isError: false },
    );
    const compactLines = compact.render(120);
    assert.equal(compactLines.length, 1);
    assert.equal(
      compactLines[0],
      "🤖🚀 Sub-agent 1 spawned | [worker] Implement the adapter",
    );
    const narrowCompact = compact.render(45);
    assert.equal(narrowCompact.length, 1);
    assert.ok(visibleWidth(narrowCompact[0] ?? "") <= 45);
    const narrowText = (narrowCompact[0] ?? "").replace(/\x1b\[[0-9;]*m/g, "");
    assert.ok(narrowText.endsWith("..."));

    initTheme(undefined, false);
    const expanded = spawnTool.renderResult(
      result,
      { expanded: true, isPartial: false },
      theme,
      { isError: false },
    );
    const expandedText = expanded.render(120).join("\n");
    const expandedPlain = expandedText.replace(/\x1b\[[0-9;]*m/g, "");
    assert.ok(expandedPlain.includes("🤖🚀 Sub-agent spawned"));
    assert.ok(expandedPlain.includes("Agent ID: 1"));
    assert.ok(expandedPlain.includes("Agent type: worker"));
    assert.ok(expandedPlain.includes("Timeout: 600s"));
    assert.ok(expandedPlain.includes("- Read the contract"));
    assert.ok(expandedPlain.includes("- Run the tests"));
    assert.ok(expandedPlain.indexOf("Task:") < expandedPlain.indexOf("- Read"));
    assert.ok(!expandedPlain.includes("The sub-agent is now running"));
    assert.ok(!expandedPlain.includes("Model:"));
    assert.ok(!expandedPlain.includes("Thinking level:"));

    const subagentCommand = commands.find((entry) => entry.name === "subagent");
    assert.ok(subagentCommand);
    await subagentCommand.command.handler(
      "spawn:worker timeout:600 Review the adapter",
      {
        cwd,
        ui: { notify() {} },
      },
    );
    assert.equal(sentMessages.length, 1);
    assert.ok(
      sentMessages[0].content.startsWith(
        "The sub-agent is now running in parallel.",
      ),
    );
    assert.equal(sentMessages[0].details.task, "Review the adapter");

    const spawnRenderer = renderers.get("subagent-spawned");
    assert.ok(spawnRenderer);
    const messageCompact = spawnRenderer(
      { content: parentText, details: result.details },
      { expanded: false },
      theme,
    );
    assert.ok(messageCompact.render(120).join("\n").includes(compactLines[0]));
    const messageExpanded = spawnRenderer(
      { content: parentText, details: result.details },
      { expanded: true },
      theme,
    );
    assert.ok(messageExpanded.render(120).join("\n").includes("Agent ID: 1"));
    assert.ok(!messageExpanded.render(120).join("\n").includes("Do NOT call"));

    const callComponent = spawnTool.renderCall(
      { agent: "worker", task: "task" },
      theme,
      {} as never,
    );
    assert.deepEqual(callComponent.render(120), []);

    const completionRenderer = renderers.get("subagent-complete");
    assert.ok(completionRenderer);
    for (const [status, icon] of [
      ["completed", "🤖✅"],
      ["error", "🤖❌"],
      ["interrupted", "🤖⚠️"],
    ]) {
      const rendered = completionRenderer(
        {
          content: "completion",
          details: {
            agentId: "1",
            agentType: "worker",
            taskTitle: "task",
            status,
            durationSec: 1,
          },
        },
        { expanded: false },
        theme,
      );
      assert.ok(rendered.render(120).join("\n").includes(icon));
    }
  } finally {
    __test.resetState();
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("extracts text from a finalized assistant message", () => {
  assert.equal(
    __test.extractAssistantMessageText({
      role: "assistant",
      content: [
        { type: "thinking", thinking: "hidden" },
        { type: "text", text: "first" },
        { type: "text", text: " second" },
      ],
    }),
    "first second",
  );
});

test("uses the completion tool result as the authoritative deliverable", () => {
  __test.resetState();
  const sent = captureCompletions();
  const agent = __test.addMockAgent("T-tool", { processExited: true });

  __test.handleSubAgentEvent(agent, {
    type: "message_end",
    message: assistantMessage("I am about to finish.", "toolUse"),
  });
  __test.handleSubAgentEvent(agent, {
    type: "tool_execution_start",
    toolCallId: "completion-1",
    toolName: "subagent_complete",
    args: { result: "authoritative result" },
  });
  __test.handleSubAgentEvent(agent, {
    type: "tool_execution_end",
    toolCallId: "completion-1",
    toolName: "subagent_complete",
    isError: false,
  });
  __test.handleSubAgentEvent(agent, { type: "agent_settled" });

  assert.equal(agent.status, "completed");
  assert.equal(sent.length, 1);
  assert.ok(sent[0]?.content.startsWith("🤖✅"));
  assert.ok(!sent[0]?.content.includes("thinking="));
  assert.ok(!sent[0]?.content.includes("result:"));
  assert.ok(sent[0]?.content.includes("\n\nauthoritative result"));
  assert.equal(sent[0]?.details?.result, "authoritative result");
  assert.ok(sent[0]?.content.includes("authoritative result"));
  assert.ok(!sent[0]?.content.includes("report validation"));
});

test("rejected completion calls can be corrected and retried", () => {
  __test.resetState();
  const sent = captureCompletions();
  const agent = __test.addMockAgent("T-tool-retry", { processExited: true });

  __test.handleSubAgentEvent(agent, {
    type: "tool_execution_start",
    toolCallId: "completion-1",
    toolName: "subagent_complete",
    args: { result: "rejected result" },
  });
  __test.handleSubAgentEvent(agent, {
    type: "tool_execution_end",
    toolCallId: "completion-1",
    toolName: "subagent_complete",
    isError: true,
  });

  assert.equal(agent.completionResult, undefined);
  assert.ok(agent.activity.some((entry) => entry.includes("retry required")));

  __test.handleSubAgentEvent(agent, {
    type: "tool_execution_start",
    toolCallId: "completion-2",
    toolName: "subagent_complete",
    args: { result: "corrected result" },
  });
  __test.handleSubAgentEvent(agent, {
    type: "tool_execution_end",
    toolCallId: "completion-2",
    toolName: "subagent_complete",
    isError: false,
  });
  __test.handleSubAgentEvent(agent, { type: "agent_settled" });

  assert.equal(agent.status, "completed");
  assert.equal(sent[0]?.details?.result, "corrected result");
});

test("accepts ordinary final assistant text when the completion tool is omitted", () => {
  __test.resetState();
  const sent = captureCompletions();
  const agent = __test.addMockAgent("T-fallback", { processExited: true });

  __test.handleSubAgentEvent(agent, {
    type: "message_end",
    message: assistantMessage("plain final response"),
  });
  __test.handleSubAgentEvent(agent, { type: "agent_end", willRetry: false });

  assert.equal(
    agent.status,
    "running",
    "agent_end must not complete the child",
  );

  __test.handleSubAgentEvent(agent, { type: "agent_settled" });

  assert.equal(agent.status, "completed");
  assert.equal(sent[0]?.details?.result, "plain final response");
});

test("missing results fail with narrower-task guidance", () => {
  __test.resetState();
  const sent = captureCompletions();
  const agent = __test.addMockAgent("T-missing", { processExited: true });

  __test.handleSubAgentEvent(agent, { type: "agent_settled" });

  assert.equal(agent.status, "error");
  assert.equal(agent.failureReason, "missing_result");
  assert.ok(sent[0]?.content.startsWith("🤖❌"));
  assert.ok(sent[0]?.content.includes("simpler or more narrowly scoped task"));
});

test("truncated responses preserve partial text and fail", () => {
  __test.resetState();
  const sent = captureCompletions();
  const agent = __test.addMockAgent("T-length", { processExited: true });

  __test.handleSubAgentEvent(agent, {
    type: "message_end",
    message: assistantMessage("partial answer", "length"),
  });
  __test.handleSubAgentEvent(agent, { type: "agent_settled" });

  assert.equal(agent.status, "error");
  assert.equal(agent.failureReason, "incomplete_result");
  assert.equal(sent[0]?.details?.partialResult, "partial answer");
  assert.ok(sent[0]?.content.includes("partial answer"));
});

test("assistant usage updates context tokens", () => {
  __test.resetState();
  const agent = __test.addMockAgent("T-usage");

  __test.handleSubAgentEvent(agent, {
    type: "message_end",
    message: {
      role: "assistant",
      content: [{ type: "text", text: "working" }],
      stopReason: "stop",
      usage: {
        input: 50000,
        output: 1200,
        cacheRead: 100000,
        cacheWrite: 0,
        totalTokens: 151200,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
    },
  });

  assert.equal(agent.contextTokens, 151200);
});

test("formatContextTokens formats zero-padded millions", () => {
  assert.equal(__test.formatContextTokens(72000), "0.072Mt");
  assert.equal(__test.formatContextTokens(151200), "0.151Mt");
  assert.equal(__test.formatContextTokens(1000), "0.001Mt");
  assert.equal(__test.formatContextTokens(1_500_000), "1.500Mt");
  assert.equal(__test.formatContextTokens(undefined), undefined);
  assert.equal(__test.formatContextTokens(0), undefined);
});

test("process failures do not suggest changing task scope", () => {
  __test.resetState();
  const sent = captureCompletions();
  const agent = __test.addMockAgent("T-process", {
    status: "error",
    endTime: Date.now(),
    failureReason: "process_error",
    exitCode: 1,
    processExited: true,
  });

  __test.notifyAgentCompletion(agent);

  assert.ok(sent[0]?.content.includes("process exited unexpectedly"));
  assert.ok(!sent[0]?.content.includes("narrowly scoped"));
});

test("reload interruptions are reported once without triggering a turn", () => {
  __test.resetState();
  const sent = captureCompletions();
  const agent = __test.addMockAgent("T-reload", { processExited: true });

  __test.interruptSubAgentForReload(agent);
  __test.notifyAgentCompletion(agent);

  assert.equal(agent.status, "interrupted");
  assert.equal(agent.interruptionReason, "reload");
  assert.equal(sent.length, 1);
  assert.equal(sent[0]?.details?.status, "interrupted");
  assert.equal(sent[0]?.details?.interruptionReason, "reload");
  assert.equal(sent[0]?.options?.triggerTurn, false);
  assert.ok(sent[0]?.content.startsWith("🤖⚠️"));
  assert.ok(sent[0]?.content.toLowerCase().includes("extension reload"));
  assert.ok(sent[0]?.content.includes("exit 143"));
  assert.ok(!sent[0]?.content.includes("narrowly scoped"));
});

test("intentional termination suppresses completion messages", () => {
  __test.resetState();
  const sent = captureCompletions();
  let killCalls = 0;
  const process = {
    kill() {
      killCalls++;
    },
    stdin: {
      destroyed: false,
      write() {},
      end() {},
    },
  } as unknown as ChildProcess;
  const agent = __test.addMockAgent("T-intentional", { process });

  __test.terminateSubAgentWithoutNotification(agent, "killed by parent");
  __test.notifyAgentCompletion(agent);

  assert.equal(agent.status, "interrupted");
  assert.equal(agent.completionNotified, true);
  assert.equal(killCalls, 1);
  assert.equal(sent.length, 0);
});

test("activity history and streaming previews are bounded", () => {
  __test.resetState();
  const agent = __test.addMockAgent("T-bounded");

  for (let index = 0; index < 75; index++) {
    __test.recordActivity(agent, `${index}:${"x".repeat(1500)}`);
  }
  __test.handleSubAgentEvent(agent, {
    type: "message_update",
    assistantMessageEvent: {
      type: "text_delta",
      delta: "y".repeat(6000),
    },
  });

  assert.equal(agent.activity.length, 50);
  assert.ok(agent.activity.every((entry) => entry.length <= 1000));
  assert.equal(agent.currentResponsePreview.length, 4000);
});

test("completion closes child stdin and removes it from tracking", () => {
  __test.resetState();
  let endCalls = 0;
  const process = {
    kill() {},
    stdin: {
      destroyed: false,
      write() {},
      end() {
        endCalls++;
      },
    },
  } as unknown as ChildProcess;
  const agent = __test.addMockAgent("T-cleanup", {
    process,
    completionResult: "done",
  });

  __test.settleSubAgent(agent, "finished");

  assert.equal(endCalls, 1);
});

test("completed fleet sessions are retained with a bounded history", () => {
  __test.resetState();
  const source = __test.createFleetDataSource();

  for (let index = 0; index < 21; index++) {
    const agent = __test.addMockAgent(`T-recent-${index}`, {
      processExited: true,
      completionResult: `result ${index}`,
      startTime: Date.now() + index,
    });
    __test.settleSubAgent(agent, "finished");
  }

  const retained = source.listAgents();
  assert.equal(retained.length, 20);
  assert.ok(!retained.some((agent) => agent.id === "T-recent-0"));
  assert.equal(retained[0]?.id, "T-recent-20");
  assert.equal(retained[0]?.status, "completed");
  assert.equal(source.getAgent("T-recent-20")?.task, "test task");

  assert.equal(source.remove("T-recent-20").ok, true);
  assert.equal(source.getAgent("T-recent-20"), undefined);
  assert.equal(
    source.removeAllFinished().message,
    "Removed 19 finished sub-agents.",
  );
  assert.equal(source.listAgents().length, 0);
});

test("fleet stop actions terminate active agents but retain their sessions", () => {
  __test.resetState();
  const source = __test.createFleetDataSource();
  __test.addMockAgent("T-stop-one");
  __test.addMockAgent("T-stop-two");

  assert.equal(source.stop("T-stop-one").ok, true);
  assert.equal(source.getAgent("T-stop-one")?.status, "interrupted");
  assert.ok(source.listAgents().some((agent) => agent.id === "T-stop-one"));

  assert.equal(source.stopAllRunning().message, "Stopped 1 running sub-agent.");
  assert.equal(source.getAgent("T-stop-two")?.status, "interrupted");
  assert.equal(source.listAgents().length, 2);
});

test("registers the supported command surface and steers all agents", async () => {
  __test.resetState();
  const tools: any[] = [];
  const commands: any[] = [];
  const renderTheme = {
    fg: (_color: string, text: string) => text,
    bg: (_color: string, text: string) => text,
    bold: (text: string) => text,
  } as never;
  extension({
    registerTool: (tool: any) => tools.push(tool),
    registerCommand: (name: string, command: any) =>
      commands.push({ name, command }),
    registerMessageRenderer() {},
    on() {},
    sendMessage() {},
  } as any);

  assert.ok(tools.some((tool) => tool.name === "subagent_steer"));
  assert.ok(tools.some((tool) => tool.name === "subagent_status"));
  assert.ok(!tools.some((tool) => tool.name === "subagent_notify"));

  const subagentCommand = commands.find((entry) => entry.name === "subagent");
  const completions = subagentCommand.command.getArgumentCompletions("");
  assert.ok(completions.some((entry: any) => entry.value === "steer"));
  assert.ok(!completions.some((entry: any) => entry.value === "notify"));
  for (const removedCommand of ["show", "hide", "status"]) {
    assert.ok(
      !completions.some((entry: any) => entry.value === removedCommand),
    );
  }

  const rejectedCommands: Array<{ message: string; level: string }> = [];
  for (const removedCommand of ["show", "hide", "status"]) {
    await subagentCommand.command.handler(removedCommand, {
      cwd: process.cwd(),
      ui: {
        notify: (message: string, level: string) =>
          rejectedCommands.push({ message, level }),
      },
    });
  }
  assert.equal(rejectedCommands.length, 3);
  assert.ok(
    rejectedCommands.every(
      ({ message, level }) => message.startsWith("Usage:") && level === "error",
    ),
  );

  const plainCommandNotifications: string[] = [];
  await subagentCommand.command.handler("", {
    cwd: process.cwd(),
    hasUI: false,
    ui: {
      notify: (message: string) => plainCommandNotifications.push(message),
    },
  });
  assert.deepEqual(plainCommandNotifications, []);

  const agent = __test.addMockAgent("T-steer");
  const steerTool = tools.find((tool) => tool.name === "subagent_steer");
  const result = await steerTool.execute(
    "call-steer",
    { agent_id: agent.id, text: "Focus on the requested scope" },
    undefined,
    undefined,
    undefined,
  );
  assert.equal(result.details.sent, true);
  assert.equal(
    result.content[0].text,
    "Sent guidance to sub-agent T-steer: Focus on the requested scope",
  );
  assert.ok(
    agent.activity.some((entry) =>
      entry.includes("Parent guidance: Focus on the requested scope"),
    ),
  );

  const secondAgent = __test.addMockAgent("T-steer-all");
  const unavailableAgent = __test.addMockAgent("T-steer-unavailable");
  (unavailableAgent.process.stdin as any).destroyed = true;
  const allResult = await steerTool.execute(
    "call-steer-all",
    { agent_id: "all", text: "Stop expanding scope" },
    undefined,
    undefined,
    undefined,
  );
  assert.equal(allResult.details.targeted, 3);
  assert.equal(allResult.details.sent, 2);
  assert.equal(allResult.details.failed, 1);
  assert.ok(allResult.content[0].text.includes("✓ T-steer: sent"));
  assert.ok(allResult.content[0].text.includes("✓ T-steer-all: sent"));
  assert.ok(
    allResult.content[0].text.includes(
      "✗ T-steer-unavailable: cannot receive guidance",
    ),
  );
  assert.ok(
    secondAgent.activity.some((entry) =>
      entry.includes("Parent guidance: Stop expanding scope"),
    ),
  );

  const compactSteer = steerTool.renderResult(
    allResult,
    { expanded: false, isPartial: false },
    renderTheme,
    { isError: false },
  );
  const compactSteerLines = compactSteer.render(120);
  assert.equal(compactSteerLines.length, 1);
  assert.equal(
    compactSteerLines[0],
    "subagent_steer 🤖 Sent guidance (2/3): Stop expanding scope",
  );
  const narrowSteer = compactSteer.render(45)[0] ?? "";
  assert.ok(visibleWidth(narrowSteer) <= 45);
  assert.ok(narrowSteer.replace(/\x1b\[[0-9;]*m/g, "").endsWith("..."));

  const expandedSteer = steerTool.renderResult(
    allResult,
    { expanded: true, isPartial: false },
    renderTheme,
    { isError: false },
  );
  assert.deepEqual(
    expandedSteer.render(120).map((line: string) => line.trimEnd()),
    [
      "",
      "Sent guidance to 2/3 running sub-agents: Stop expanding scope",
      "",
      "✓ T-steer: sent",
      "✓ T-steer-all: sent",
      "✗ T-steer-unavailable: cannot receive guidance",
    ],
  );
  const compactCall = steerTool.renderCall(
    { agent_id: "all", text: "Stop expanding scope" },
    renderTheme,
    { expanded: false } as never,
  );
  assert.deepEqual(compactCall.render(120), []);
  const partialSteer = steerTool.renderResult(
    allResult,
    { expanded: false, isPartial: true },
    renderTheme,
    { isError: false },
  );
  assert.deepEqual(
    partialSteer.render(120).map((line: string) => line.trimEnd()),
    ["🤖 Steering..."],
  );

  const notifications: Array<{ message: string; level: string }> = [];
  await subagentCommand.command.handler("steer all Finish now", {
    cwd: process.cwd(),
    ui: {
      notify: (message: string, level: string) =>
        notifications.push({ message, level }),
    },
  });
  assert.ok(notifications[0]?.message.includes("Sent guidance to 2/3"));
  assert.equal(notifications[0]?.level, "warning");
});

test("child-only completion tool submits one result and requests shutdown", async () => {
  __test.resetState();
  const previousChild = process.env.PI_SUBAGENT_CHILD;
  const previousDisable = process.env.PI_SUBAGENT_DISABLE_RECURSION;
  process.env.PI_SUBAGENT_CHILD = "1";
  process.env.PI_SUBAGENT_DISABLE_RECURSION = "1";

  try {
    const tools: any[] = [];
    extension({ registerTool: (tool: any) => tools.push(tool) } as any);
    assert.deepEqual(
      tools.map((tool) => tool.name),
      ["subagent_complete"],
    );

    let shutdownCalls = 0;
    const result = await tools[0].execute(
      "call-1",
      { result: "done" },
      undefined,
      undefined,
      { shutdown: () => shutdownCalls++ },
    );

    assert.equal(result.details.completed, true);
    assert.equal(result.terminate, true);
    assert.equal(shutdownCalls, 1);
  } finally {
    if (previousChild === undefined) delete process.env.PI_SUBAGENT_CHILD;
    else process.env.PI_SUBAGENT_CHILD = previousChild;
    if (previousDisable === undefined)
      delete process.env.PI_SUBAGENT_DISABLE_RECURSION;
    else process.env.PI_SUBAGENT_DISABLE_RECURSION = previousDisable;
  }
});

test("timeout only escalates to parent", async () => {
  __test.resetState();
  __test.setDefaultTimeoutSeconds(1);
  __test.setTimeoutEscalationDelayMs(25);
  const sent = captureCompletions();
  const agent = __test.addMockAgent("T-timeout");

  __test.scheduleSubAgentTimeout(agent);
  await wait(1140);

  assert.equal(sent.length, 1);
  assert.ok(sent[0]?.content.includes("still running after timeout"));
  assert.equal(sent[0]?.details?.timeoutStage, "escalation");
});

test("manual timeout override is applied", () => {
  __test.resetState();
  __test.setDefaultTimeoutSeconds(180);
  const agent = __test.addMockAgent("T-manual");

  __test.scheduleSubAgentTimeout(agent, 70);

  assert.equal(agent.timeoutSeconds, 70);
  assert.ok(agent.timeoutAt);
  assert.ok(
    Math.abs((agent.timeoutAt || 0) - (agent.startTime + 70000)) < 1000,
  );
});

test("sends wrap-up warning 60 seconds before timeout", async () => {
  __test.resetState();
  __test.setDefaultTimeoutSeconds(61);
  const agent = __test.addMockAgent("T-warning");

  __test.scheduleSubAgentTimeout(agent);
  await wait(1100);

  assert.ok(
    agent.activity.some(
      (entry) => entry.includes("You have") && entry.includes("60 seconds"),
    ),
  );
});

test("completion details retain timeout metadata", async () => {
  __test.resetState();
  __test.setDefaultTimeoutSeconds(1);
  __test.setTimeoutEscalationDelayMs(1000);
  const sent = captureCompletions();
  const agent = __test.addMockAgent("T-timeout-result", {
    processExited: true,
  });

  __test.scheduleSubAgentTimeout(agent);
  await wait(1100);
  agent.completionResult = "done after timeout";
  __test.settleSubAgent(agent, "finished");

  const completion = sent.find((message) => message.details?.result);
  assert.equal(completion?.details?.timedOut, true);
  assert.equal(completion?.details?.timeoutSeconds, 1);
});

test("fleet window renders bounded live details and steers the selected agent", () => {
  const now = Date.now();
  const agents: FleetAgentDetail[] = [
    {
      id: "agent-one",
      agentType: "researcher",
      model: "provider/researcher",
      status: "completed",
      taskTitle: "research task",
      task: "Research the implementation",
      startTime: now - 5000,
      endTime: now - 1000,
      activity: ["🔧 read({path: src/index.ts})"],
      currentResponsePreview: "Reviewing the current implementation",
      completionResult: "The implementation review is complete.",
    },
    {
      id: "agent-two",
      agentType: "reviewer",
      model: "provider/reviewer",
      status: "running",
      taskTitle: "review task",
      task: "Review the changes",
      startTime: now - 3000,
      activity: ["🔧 grep({pattern: fleet})"],
      currentResponsePreview: "Checking edge cases",
    },
  ];
  const steers: Array<{ id: string; text: string }> = [];
  const source: FleetDataSource = {
    listAgents: () =>
      agents.map(
        ({
          activity,
          currentResponsePreview,
          completionResult,
          task,
          ...agent
        }) => agent,
      ),
    getAgent: (id) => agents.find((agent) => agent.id === id),
    steer: (id, text) => {
      steers.push({ id, text });
      return { ok: true, message: `Guidance sent to ${id}.` };
    },
    remove: (id) => ({ ok: true, message: `Removed ${id}.` }),
    removeAllFinished: () => ({ ok: true, message: "Removed all." }),
    stop: (id) => ({ ok: true, message: `Stopped ${id}.` }),
    stopAllRunning: () => ({ ok: true, message: "Stopped all." }),
  };
  let closed = false;
  let renderRequests = 0;
  const tui = {
    terminal: { rows: 24, columns: 90 },
    requestRender: () => renderRequests++,
  };
  const theme = {
    fg: (_color: string, text: string) => text,
    bg: (_color: string, text: string) => text,
    bold: (text: string) => text,
  };
  const component = new SubagentFleetComponent(
    tui as never,
    theme as never,
    source,
    () => {
      closed = true;
    },
    60_000,
  );

  try {
    component.focused = true;
    let lines = component.render(90);
    assert.ok(
      lines.some((line) => line.includes("Research the implementation")),
    );
    assert.ok(lines.some((line) => line.includes("Reviewing the current")));
    assert.ok(lines.some((line) => line.includes("Final result")));
    assert.ok(
      lines.some((line) =>
        line.includes("The implementation review is complete."),
      ),
    );
    assert.ok(lines.every((line) => !line.includes("(done)")));
    assert.ok(lines.every((line) => visibleWidth(line) <= 90));

    component.handleInput("s");
    assert.ok(
      component
        .render(90)
        .some((line) => line.includes("Finished sub-agents cannot be steered")),
    );

    component.handleInput("\x1b[B");
    lines = component.render(90);
    assert.ok(lines.some((line) => line.includes("Review the changes")));

    component.handleInput("s");
    for (const char of "Focus on lifecycle cleanup")
      component.handleInput(char);
    component.handleInput("\r");

    assert.deepEqual(steers, [
      { id: "agent-two", text: "Focus on lifecycle cleanup" },
    ]);
    assert.ok(
      component.render(90).some((line) => line.includes("Guidance sent")),
    );
    assert.ok(renderRequests > 0);

    tui.terminal.rows = 60;
    assert.equal(component.render(90).length, 49);

    tui.terminal.rows = 12;
    assert.ok(component.render(90).length <= 9);
    component.handleInput("\x1b");
    assert.equal(closed, true);
  } finally {
    component.dispose();
  }
});

test("fleet window shows timer and token count in roster and detail header", () => {
  const now = Date.now();
  const agents: FleetAgentDetail[] = [
    {
      id: "ctx-one",
      agentType: "researcher",
      model: "provider/researcher",
      status: "running",
      taskTitle: "running task",
      task: "Running task",
      startTime: now - 90_000,
      activity: [],
      currentResponsePreview: "",
      contextTokens: 72000,
    },
    {
      id: "ctx-two",
      agentType: "worker",
      model: "provider/worker",
      status: "running",
      taskTitle: "second task",
      task: "Second task",
      startTime: now - 45_000,
      activity: [],
      currentResponsePreview: "",
      contextTokens: 151200,
    },
  ];
  const source: FleetDataSource = {
    listAgents: () =>
      agents.map(
        ({ task, activity, currentResponsePreview, ...agent }) => agent,
      ),
    getAgent: (id) => agents.find((agent) => agent.id === id),
    steer: () => ({ ok: true, message: "Guidance sent." }),
    remove: () => ({ ok: true, message: "Removed." }),
    removeAllFinished: () => ({ ok: true, message: "Removed all." }),
    stop: () => ({ ok: true, message: "Stopped." }),
    stopAllRunning: () => ({ ok: true, message: "Stopped all." }),
  };
  const component = new SubagentFleetComponent(
    { terminal: { rows: 24, columns: 90 }, requestRender() {} } as never,
    {
      fg: (_color: string, text: string) => text,
      bg: (_color: string, text: string) => text,
      bold: (text: string) => text,
    } as never,
    source,
    () => {},
    60_000,
  );

  try {
    const lines = component.render(90);
    // Each roster row is `duration·tokens` (timer restored, no percentage).
    assert.ok(
      lines.some((line) => line.includes("01m30s·0.072Mt")),
      "roster shows duration plus token count for ctx-one",
    );
    assert.ok(
      lines.some((line) => line.includes("45s·0.151Mt")),
      "roster shows duration plus token count for ctx-two",
    );
    // The selected agent (ctx-one) detail header appends the token count.
    assert.ok(
      lines.some((line) => line.includes("running · 01m30s · 0.072Mt")),
      "detail header shows status, timer, and token count",
    );
    assert.ok(lines.every((line) => visibleWidth(line) <= 90));
  } finally {
    component.dispose();
  }
});

test("fleet window confirms removal of selected and all finished sessions", () => {
  const now = Date.now();
  const agents: FleetAgentDetail[] = [
    {
      id: "finished-one",
      status: "completed",
      taskTitle: "first finished task",
      task: "First finished task",
      startTime: now - 4000,
      endTime: now - 3000,
      activity: [],
      currentResponsePreview: "",
    },
    {
      id: "finished-two",
      status: "error",
      taskTitle: "second finished task",
      task: "Second finished task",
      startTime: now - 3000,
      endTime: now - 2000,
      activity: [],
      currentResponsePreview: "",
    },
    {
      id: "running-one",
      status: "running",
      taskTitle: "running task",
      task: "Running task",
      startTime: now - 1000,
      activity: [],
      currentResponsePreview: "",
    },
  ];
  const source: FleetDataSource = {
    listAgents: () =>
      agents.map(
        ({ task, activity, currentResponsePreview, ...agent }) => agent,
      ),
    getAgent: (id) => agents.find((agent) => agent.id === id),
    steer: () => ({ ok: true, message: "Guidance sent." }),
    remove: (id) => {
      const index = agents.findIndex((agent) => agent.id === id);
      if (index < 0) return { ok: false, message: "Not found." };
      agents.splice(index, 1);
      return { ok: true, message: `Removed finished sub-agent ${id}.` };
    },
    removeAllFinished: () => {
      const retained = agents.filter(
        (agent) => agent.status === "starting" || agent.status === "running",
      );
      const count = agents.length - retained.length;
      agents.splice(0, agents.length, ...retained);
      return {
        ok: true,
        message: `Removed ${count} finished sub-agents.`,
      };
    },
    stop: (id) => ({ ok: true, message: `Stopped ${id}.` }),
    stopAllRunning: () => ({ ok: true, message: "Stopped all." }),
  };
  const component = new SubagentFleetComponent(
    { terminal: { rows: 24, columns: 90 }, requestRender() {} } as never,
    {
      fg: (_color: string, text: string) => text,
      bg: (_color: string, text: string) => text,
      bold: (text: string) => text,
    } as never,
    source,
    () => {},
    60_000,
  );

  try {
    component.handleInput("r");
    const removalConfirmation = component.render(90);
    assert.ok(
      removalConfirmation.some((line) =>
        line.includes("Remove the selected subagent?"),
      ),
    );
    const confirmationBorder = removalConfirmation.find((line) =>
      line.includes("╭"),
    );
    assert.equal(visibleWidth(confirmationBorder?.trim() ?? ""), 60);
    assert.equal(confirmationBorder?.indexOf("╭"), 15);
    assert.ok(removalConfirmation.every((line) => visibleWidth(line) <= 90));
    component.handleInput("\x1b");
    assert.equal(agents.length, 3);

    component.handleInput("r");
    component.handleInput("\r");
    assert.deepEqual(
      agents.map((agent) => agent.id),
      ["finished-two", "running-one"],
    );

    component.handleInput("R");
    assert.ok(
      component
        .render(90)
        .some((line) => line.includes("Remove ALL finished subagents?")),
    );
    component.handleInput("Y");
    assert.deepEqual(
      agents.map((agent) => agent.id),
      ["running-one"],
    );
  } finally {
    component.dispose();
  }
});

test("fleet action rows wrap and include same-color spacing", () => {
  const action =
    "🔧 search_web: query=alpha " +
    "overflow-marker ".repeat(8) +
    "tail-marker";
  const agent: FleetAgentDetail = {
    id: "running-action",
    status: "running",
    taskTitle: "render action",
    task: "Render the action",
    startTime: Date.now() - 1000,
    activity: [
      action,
      "💬 First response",
      "↻ Second response",
      "💬 Third response",
    ],
    currentResponsePreview: "",
  };
  const toolBackgrounds: string[] = [];
  const userBackgrounds: string[] = [];
  const component = new SubagentFleetComponent(
    { terminal: { rows: 40, columns: 90 }, requestRender() {} } as never,
    {
      fg: (_color: string, text: string) => text,
      bg: (color: string, text: string) => {
        if (color === "toolSuccessBg") {
          toolBackgrounds.push(text);
          return `\x1b[44m${text}\x1b[0m`;
        }
        if (color === "userMessageBg") {
          userBackgrounds.push(text);
          return `\x1b[100m${text}\x1b[0m`;
        }
        return text;
      },
      bold: (text: string) => text,
    } as never,
    {
      listAgents: () => [agent],
      getAgent: () => agent,
      steer: () => ({ ok: true, message: "Guidance sent." }),
      remove: () => ({ ok: true, message: "Removed." }),
      removeAllFinished: () => ({ ok: true, message: "Removed all." }),
      stop: () => ({ ok: true, message: "Stopped." }),
      stopAllRunning: () => ({ ok: true, message: "Stopped all." }),
    },
    () => {},
    60_000,
  );

  try {
    const renderedLines = component.render(90);
    const rendered = renderedLines.join("\n");
    assert.ok(
      rendered.includes("tail-marker"),
      "tool text must wrap, not truncate",
    );
    const taskRow = renderedLines.findIndex((line) =>
      line.includes("Render the action"),
    );
    const toolStartRow = renderedLines.findIndex((line) =>
      line.includes("search_web"),
    );
    const toolEndRow = renderedLines.findIndex((line) =>
      line.includes("tail-marker"),
    );
    const firstResponseRow = renderedLines.findIndex((line) =>
      line.includes("First response"),
    );
    const secondResponseRow = renderedLines.findIndex((line) =>
      line.includes("Retry: Second response"),
    );
    const thirdResponseRow = renderedLines.findIndex((line) =>
      line.includes("Third response"),
    );
    const hasBlankDetailRow = (start: number, end: number) =>
      renderedLines
        .slice(start + 1, end)
        .some((line) => line.split("│")[2]?.trim() === "");
    assert.ok(hasBlankDetailRow(taskRow, toolStartRow));
    assert.ok(hasBlankDetailRow(toolEndRow, firstResponseRow));
    assert.ok(hasBlankDetailRow(firstResponseRow, secondResponseRow));
    assert.ok(hasBlankDetailRow(secondResponseRow, thirdResponseRow));
    assert.ok(userBackgrounds.length >= 3);
    assert.equal(userBackgrounds[0]?.trim(), "");
    assert.equal(userBackgrounds[userBackgrounds.length - 1]?.trim(), "");
    assert.ok(
      userBackgrounds.every(
        (line) => visibleWidth(line) === visibleWidth(userBackgrounds[0] ?? ""),
      ),
      "every message line should fill the same background width",
    );
    assert.ok(
      toolBackgrounds.length >= 4,
      "tool row should span multiple lines",
    );
    assert.equal(toolBackgrounds[0]?.trim(), "");
    assert.equal(toolBackgrounds[toolBackgrounds.length - 1]?.trim(), "");
    assert.ok(
      toolBackgrounds.every(
        (line) => visibleWidth(line) === visibleWidth(toolBackgrounds[0] ?? ""),
      ),
      "every action line should fill the same background width",
    );
    assert.ok(
      toolBackgrounds
        .filter((line) => line.trim())
        .every((line) => line.startsWith("  ") && line.endsWith("  ")),
      "wrapped action text should have two columns of side padding",
    );
  } finally {
    component.dispose();
  }
});

test("fleet page keys scroll detail by three lines", () => {
  const agent: FleetAgentDetail = {
    id: "scrolling-agent",
    status: "running",
    taskTitle: "scroll task",
    task: "Scroll through activity",
    startTime: Date.now() - 1000,
    activity: Array.from(
      { length: 20 },
      (_, index) => `activity-${String(index).padStart(2, "0")}`,
    ),
    currentResponsePreview: "",
  };
  const component = new SubagentFleetComponent(
    { terminal: { rows: 24, columns: 90 }, requestRender() {} } as never,
    {
      fg: (_color: string, text: string) => text,
      bg: (_color: string, text: string) => text,
      bold: (text: string) => text,
    } as never,
    {
      listAgents: () => [agent],
      getAgent: () => agent,
      steer: () => ({ ok: true, message: "Guidance sent." }),
      remove: () => ({ ok: true, message: "Removed." }),
      removeAllFinished: () => ({ ok: true, message: "Removed all." }),
      stop: () => ({ ok: true, message: "Stopped." }),
      stopAllRunning: () => ({ ok: true, message: "Stopped all." }),
    },
    () => {},
    60_000,
  );
  const visibleDetails = () =>
    component
      .render(90)
      .slice(3, 16)
      .map((line) => line.split("│")[2] ?? "");

  try {
    const initial = visibleDetails();
    component.handleInput("\x1b[5~");
    const scrolledUp = visibleDetails();
    assert.deepEqual(scrolledUp.slice(3), initial.slice(0, -3));

    component.handleInput("\x1b[6~");
    assert.deepEqual(visibleDetails(), initial);
  } finally {
    component.dispose();
  }
});

test("fleet stop actions preserve stopped sessions and require confirmation", () => {
  const now = Date.now();
  const agents: FleetAgentDetail[] = [
    {
      id: "running-one",
      status: "running",
      taskTitle: "first running task",
      task: "First running task",
      startTime: now - 3000,
      activity: [],
      currentResponsePreview: "",
    },
    {
      id: "running-two",
      status: "starting",
      taskTitle: "second running task",
      task: "Second running task",
      startTime: now - 2000,
      activity: [],
      currentResponsePreview: "",
    },
    {
      id: "finished-one",
      status: "completed",
      taskTitle: "finished task",
      task: "Finished task",
      startTime: now - 1000,
      endTime: now,
      activity: [],
      currentResponsePreview: "",
    },
  ];
  const stopped: string[] = [];
  const stopAgent = (id: string) => {
    const agent = agents.find((candidate) => candidate.id === id);
    if (!agent || (agent.status !== "starting" && agent.status !== "running")) {
      return { ok: false, message: `${id} is no longer running.` };
    }
    agent.status = "interrupted";
    agent.endTime = Date.now();
    stopped.push(id);
    return { ok: true, message: `Stopped sub-agent ${id}.` };
  };
  const source: FleetDataSource = {
    listAgents: () =>
      agents.map(
        ({ task, activity, currentResponsePreview, ...agent }) => agent,
      ),
    getAgent: (id) => agents.find((agent) => agent.id === id),
    steer: () => ({ ok: true, message: "Guidance sent." }),
    remove: () => ({ ok: true, message: "Removed." }),
    removeAllFinished: () => ({ ok: true, message: "Removed all." }),
    stop: stopAgent,
    stopAllRunning: () => {
      const runningIds = agents
        .filter(
          (agent) => agent.status === "starting" || agent.status === "running",
        )
        .map((agent) => agent.id);
      for (const id of runningIds) stopAgent(id);
      return {
        ok: true,
        message: `Stopped ${runningIds.length} running sub-agents.`,
      };
    },
  };
  const component = new SubagentFleetComponent(
    { terminal: { rows: 24, columns: 90 }, requestRender() {} } as never,
    {
      fg: (_color: string, text: string) => text,
      bg: (_color: string, text: string) => text,
      bold: (text: string) => text,
    } as never,
    source,
    () => {},
    60_000,
  );

  try {
    component.handleInput("x");
    assert.ok(
      component
        .render(90)
        .some((line) => line.includes("Stop this running subagent?")),
    );
    component.handleInput("\x1b");
    assert.deepEqual(stopped, []);

    component.handleInput("x");
    component.handleInput("\r");
    assert.deepEqual(stopped, ["running-one"]);
    assert.equal(agents[0]?.status, "interrupted");
    assert.equal(agents.length, 3, "stopping must retain the session");

    component.handleInput("X");
    assert.ok(
      component
        .render(90)
        .some((line) => line.includes("Stop ALL running subagents?")),
    );
    component.handleInput("y");
    assert.deepEqual(stopped, ["running-one", "running-two"]);
    assert.equal(agents[1]?.status, "interrupted");
    assert.equal(agents.length, 3, "stop all must retain finished sessions");

    component.handleInput("x");
    assert.ok(
      !component
        .render(90)
        .some((line) => line.includes("Stop this running subagent?")),
      "x must be ignored for a finished selection",
    );
  } finally {
    component.dispose();
  }
});
