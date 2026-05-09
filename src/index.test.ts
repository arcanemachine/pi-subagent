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

test("timeout sends initial and escalation parent notifications", async () => {
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

  const initial = sent.find((msg) => msg.content.includes("hit time budget"));
  const escalation = sent.find((msg) =>
    msg.content.includes("still running after timeout"),
  );

  assert.ok(initial, "expected initial timeout notification");
  assert.ok(escalation, "expected escalation timeout notification");
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
