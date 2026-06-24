import test from "node:test";
import assert from "node:assert/strict";
import { __test } from "./index";

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function textDelta(delta: string): string {
  return JSON.stringify({
    type: "message_update",
    assistantMessageEvent: {
      type: "text_delta",
      delta,
    },
  });
}

function finalReportJson(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    result: "done result",
    summary: "done",
    evidence: [{ source: "src/index.ts", note: "checked implementation" }],
    changed_files: [],
    commands: [],
    open_questions: [],
    confidence: 0.8,
    ...overrides,
  });
}

function finalReportBlock(overrides: Record<string, unknown> = {}): string {
  return `\`\`\`subagent_final_report\n${finalReportJson(overrides)}\n\`\`\``;
}

test("parses fenced final report and normalizes confidence", () => {
  __test.resetState();

  const parsed = __test.parseFinalReportFromTexts([
    `text\n${finalReportBlock({ confidence: 1.4 })}`,
  ]);

  assert.ok(parsed);
  assert.equal(parsed.result, "done result");
  assert.equal(parsed.summary, "done");
  assert.equal(parsed.evidence[0]?.source, "src/index.ts");
  assert.equal(parsed.confidence, 1);
});

test("parses fallback marker report when fence is missing", () => {
  __test.resetState();

  const parsed = __test.parseFinalReportFromTexts([
    `... subagent_final_report ${finalReportJson({ result: "ok", confidence: 0.5 })}`,
  ]);

  assert.ok(parsed);
  assert.equal(parsed.result, "ok");
  assert.equal(parsed.confidence, 0.5);
});

test("parses latest final report block for retries", () => {
  __test.resetState();

  const parsed = __test.parseFinalReportFromTexts([
    `${finalReportBlock({ result: "old" })}\n${finalReportBlock({ result: "new" })}`,
  ]);

  assert.ok(parsed);
  assert.equal(parsed.result, "new");
});

test("confidence rating flags missing required final report fields", () => {
  __test.resetState();

  const rating = __test.buildConfidenceRating(
    {
      result: "",
      summary: "",
      evidence: [],
      changed_files: [],
      commands: [],
      open_questions: [],
      confidence: null,
    },
    [],
  );

  assert.equal(rating.maxScore, 5);
  assert.equal(rating.score, 1);
  assert.deepEqual(rating.missing.sort(), ["confidence", "result", "summary"]);
  assert.ok(rating.warnings.includes("no_supporting_evidence"));
  assert.ok(rating.warnings.includes("no_tool_activity_logged"));
});

test("confident report without supporting evidence requests rewrite", () => {
  __test.resetState();

  const agent = __test.addMockAgent("T-no-evidence", {
    output: [textDelta(finalReportBlock({ evidence: [], confidence: 0.8 }))],
  });

  __test.handleAgentCompletionCandidate(agent, "finished", true);

  assert.equal(agent.status, "running");
  assert.ok(
    agent.finalReportValidation?.issues.includes("missing_supporting_evidence"),
  );
});

test("invalid final report requests rewrite instead of completing", () => {
  __test.resetState();

  const agent = __test.addMockAgent("T-retry", {
    output: [
      textDelta(
        "Let me research this. Let me check docs. Now I have comprehensive data.",
      ),
    ],
  });

  __test.handleAgentCompletionCandidate(agent, "finished", true);

  assert.equal(agent.status, "running");
  assert.equal(agent.finalReportAttempts, 1);
  assert.equal(agent.finalReportValidation?.valid, false);
  assert.ok(
    agent.output.some((entry) => entry.includes('"mode":"final_report_retry"')),
  );
});

test("invalid final report fails after max retry attempts", () => {
  __test.resetState();

  const sent: Array<{ content: string; details?: Record<string, unknown> }> =
    [];
  __test.setCompletionSender((content, details) =>
    sent.push({ content, details }),
  );

  const agent = __test.addMockAgent("T-fail", {
    finalReportAttempts: 2,
    output: [textDelta("No structured report here")],
  });

  __test.handleAgentCompletionCandidate(agent, "finished", true);

  assert.equal(agent.status, "error");
  assert.equal(sent.length, 1);
  assert.ok(sent[0]?.content.includes("report validation: failed"));
  const validation = sent[0]?.details?.finalReportValidation as
    | { valid?: boolean }
    | undefined;
  assert.equal(validation?.valid, false);
});

test("valid retry report completes using latest final block", () => {
  __test.resetState();

  const sent: Array<{ content: string; details?: Record<string, unknown> }> =
    [];
  __test.setCompletionSender((content, details) =>
    sent.push({ content, details }),
  );

  const agent = __test.addMockAgent("T-valid-retry", {
    finalReportAttempts: 1,
    output: [
      textDelta(finalReportBlock({ result: "old", confidence: null })),
      textDelta(finalReportBlock({ result: "corrected result" })),
    ],
  });

  __test.handleAgentCompletionCandidate(agent, "finished", true);

  assert.equal(agent.status, "completed");
  assert.equal(sent.length, 1);
  assert.ok(sent[0]?.content.includes("report validation: passed"));
  assert.ok(sent[0]?.content.includes("corrected result"));
  assert.equal(sent[0]?.details?.finalReportText, "corrected result");
});

test("timeout only escalates to parent", async () => {
  __test.resetState();
  __test.setDefaultTimeoutSeconds(1);
  __test.setTimeoutEscalationDelayMs(25);

  const sent: Array<{ content: string; details?: Record<string, unknown> }> =
    [];
  __test.setCompletionSender((content, details) =>
    sent.push({ content, details }),
  );

  const agent = __test.addMockAgent("T1");
  __test.scheduleSubAgentTimeout(agent);

  await wait(1100);
  await wait(40);

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

test("sends wrap-up warning to subagent 60 seconds before timeout", async () => {
  __test.resetState();
  __test.setDefaultTimeoutSeconds(61);

  const agent = __test.addMockAgent("T-warn");
  __test.scheduleSubAgentTimeout(agent);

  await wait(1100);

  const warning = agent.output
    .map((entry) => {
      try {
        return JSON.parse(entry);
      } catch {
        return null;
      }
    })
    .find(
      (event) =>
        event?.type === "parent_notify" &&
        typeof event?.text === "string" &&
        event.text.includes("You have") &&
        event.text.includes("60 seconds to finish"),
    );

  assert.ok(warning, "expected wrap-up warning notification to subagent");
});

test("completed agents are automatically pruned from tracking", () => {
  __test.resetState();

  const agent = __test.addMockAgent("T-prune", {
    status: "completed",
    endTime: Date.now(),
    output: [textDelta(finalReportBlock())],
  });

  __test.notifyAgentCompletion(agent);

  const report = __test.getAgentReportData("T-prune");
  assert.equal(report.found, false);
});

test("completion details include timedOut true after timeout", async () => {
  __test.resetState();
  __test.setDefaultTimeoutSeconds(1);
  __test.setTimeoutEscalationDelayMs(1000);

  const sent: Array<{ content: string; details?: Record<string, unknown> }> =
    [];
  __test.setCompletionSender((content, details) =>
    sent.push({ content, details }),
  );

  const agent = __test.addMockAgent("T2", {
    output: [textDelta(finalReportBlock())],
  });

  __test.scheduleSubAgentTimeout(agent);
  await wait(1100);

  agent.status = "completed";
  agent.endTime = Date.now();
  __test.notifyAgentCompletion(agent);

  const completion = sent.find((msg) =>
    msg.content.includes("report validation"),
  );
  assert.ok(completion, "expected completion message");
  assert.equal(completion?.details?.timedOut, true);
  assert.equal(completion?.details?.timeoutSeconds, 1);
});

test("completion message uses structured result, not freeform assistant text", () => {
  __test.resetState();

  const sent: Array<{ content: string; details?: Record<string, unknown> }> =
    [];
  __test.setCompletionSender((content, details) =>
    sent.push({ content, details }),
  );

  const noisyText = `Let me check this first.\n${finalReportBlock({ result: "authoritative result" })}`;
  const agent = __test.addMockAgent("T-structured-result", {
    status: "completed",
    endTime: Date.now(),
    output: [textDelta(noisyText)],
  });

  __test.notifyAgentCompletion(agent);

  const completion = sent[0];
  assert.ok(completion, "expected completion message");
  assert.ok(completion.content.includes("result:"));
  assert.ok(completion.content.includes("authoritative result"));
  assert.ok(!completion.content.includes("Let me check this first"));
  assert.equal(completion.details?.finalReportText, "authoritative result");
});
