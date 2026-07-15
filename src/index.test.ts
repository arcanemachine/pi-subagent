import test from "node:test";
import assert from "node:assert/strict";
import type { ChildProcess } from "node:child_process";
import extension, { __test } from "./index";

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
    toolName: "subagent_complete",
    args: { result: "authoritative result" },
  });
  __test.handleSubAgentEvent(agent, {
    type: "message_end",
    message: assistantMessage("Result submitted."),
  });
  __test.handleSubAgentEvent(agent, { type: "agent_settled" });

  assert.equal(agent.status, "completed");
  assert.equal(sent.length, 1);
  assert.equal(sent[0]?.details?.result, "authoritative result");
  assert.ok(sent[0]?.content.includes("authoritative result"));
  assert.ok(!sent[0]?.content.includes("report validation"));
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
