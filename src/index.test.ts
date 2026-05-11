import test from "node:test";
import assert from "node:assert/strict";
import { __test } from "./index";

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test("parses fenced final report and normalizes confidence", () => {
  __test.resetState();

  const parsed = __test.parseFinalReportFromTexts([
    'text\n```subagent_final_report\n{"summary":"done","changed_files":[],"commands":[],"open_questions":[],"confidence":1.4}\n```',
  ]);

  assert.ok(parsed);
  assert.equal(parsed.summary, "done");
  assert.equal(parsed.confidence, 1);
});

test("parses fallback marker report when fence is missing", () => {
  __test.resetState();

  const parsed = __test.parseFinalReportFromTexts([
    '... subagent_final_report {"summary":"ok","changed_files":[],"commands":[],"open_questions":[],"confidence":0.5}',
  ]);

  assert.ok(parsed);
  assert.equal(parsed.summary, "ok");
  assert.equal(parsed.confidence, 0.5);
});

test("confidence rating flags missing fields", () => {
  __test.resetState();

  const rating = __test.buildConfidenceRating(
    {
      summary: "",
      changed_files: [],
      commands: [],
      open_questions: [],
      confidence: null,
    },
    [],
  );

  assert.equal(rating.maxScore, 5);
  assert.equal(rating.score, 1);
  assert.deepEqual(rating.missing.sort(), [
    "changed_files",
    "commands",
    "confidence",
    "summary",
  ]);
  assert.ok(rating.warnings.includes("no_tool_activity_logged"));
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
    output: [
      JSON.stringify({
        type: "message_update",
        assistantMessageEvent: {
          type: "text_delta",
          delta:
            '```subagent_final_report\n{"summary":"done","changed_files":[],"commands":[],"open_questions":[],"confidence":0.8}\n```',
        },
      }),
    ],
  });

  __test.scheduleSubAgentTimeout(agent);
  await wait(1100);

  agent.status = "completed";
  agent.endTime = Date.now();
  __test.notifyAgentCompletion(agent);

  const completion = sent.find((msg) =>
    msg.content.includes("confidence rating"),
  );
  assert.ok(completion, "expected completion message");
  assert.equal(completion?.details?.timedOut, true);
  assert.equal(completion?.details?.timeoutSeconds, 1);
});

test("completion message includes full assistant report text", () => {
  __test.resetState();

  const sent: Array<{ content: string; details?: Record<string, unknown> }> =
    [];
  __test.setCompletionSender((content, details) =>
    sent.push({ content, details }),
  );

  const fullText =
    "Recipe name: Test Cookies\nSource URL: https://example.com/cookies";
  const agent = __test.addMockAgent("T-full-text", {
    status: "completed",
    endTime: Date.now(),
    output: [
      JSON.stringify({
        type: "message_update",
        assistantMessageEvent: {
          type: "text_delta",
          delta: fullText,
        },
      }),
    ],
  });

  __test.notifyAgentCompletion(agent);

  const completion = sent[0];
  assert.ok(completion, "expected completion message");
  assert.ok(completion.content.includes("full_report:"));
  assert.ok(completion.content.includes("```text"));
  assert.ok(completion.content.includes(fullText));
  assert.equal(completion.details?.finalReportText, fullText);
});

test("completion strips wrapper text and trailing structured final report", () => {
  __test.resetState();

  const sent: Array<{ content: string; details?: Record<string, unknown> }> =
    [];
  __test.setCompletionSender((content, details) =>
    sent.push({ content, details }),
  );

  const expected =
    "Recipe name: Test Cookies\nSource URL: https://example.com/cookies";
  const noisyText = `Here's the report:\n\n${expected}\n\n\`\`\`subagent_final_report\n{"summary":"ok","changed_files":[],"commands":[],"open_questions":[],"confidence":1}\n\`\`\``;

  const agent = __test.addMockAgent("T-sanitize", {
    status: "completed",
    endTime: Date.now(),
    output: [
      JSON.stringify({
        type: "message_update",
        assistantMessageEvent: {
          type: "text_delta",
          delta: noisyText,
        },
      }),
    ],
  });

  __test.notifyAgentCompletion(agent);

  const completion = sent[0];
  assert.ok(completion, "expected completion message");
  assert.ok(completion.content.includes(expected));
  assert.ok(!completion.content.includes("Here's the report:"));
  assert.ok(!completion.content.includes("```subagent_final_report"));
  assert.equal(completion.details?.finalReportText, expected);
});
