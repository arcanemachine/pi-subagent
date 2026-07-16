import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  Input,
  matchesKey,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
  type Component,
  type Focusable,
  type TUI,
} from "@earendil-works/pi-tui";

const DEFAULT_REFRESH_MS = 500;

type Theme = ExtensionContext["ui"]["theme"];

export interface FleetAgentSummary {
  id: string;
  agentType?: string;
  model?: string;
  status: "starting" | "running" | "completed" | "error" | "interrupted";
  taskTitle: string;
  startTime: number;
  endTime?: number;
  currentTool?: string;
  lastAction?: string;
  progressPercent?: number;
}

export interface FleetAgentDetail extends FleetAgentSummary {
  task: string;
  activity: readonly string[];
  currentResponsePreview: string;
  timeoutSeconds?: number;
  timeoutAt?: number;
}

export interface FleetActionResult {
  ok: boolean;
  message: string;
}

export interface FleetDataSource {
  listAgents(): FleetAgentSummary[];
  getAgent(id: string): FleetAgentDetail | undefined;
  steer(id: string, text: string): FleetActionResult;
  remove(id: string): FleetActionResult;
  removeAllFinished(): FleetActionResult;
  stop(id: string): FleetActionResult;
  stopAllRunning(): FleetActionResult;
}

function fit(text: string, width: number): string {
  const clipped = truncateToWidth(text, Math.max(0, width), "");
  return clipped + " ".repeat(Math.max(0, width - visibleWidth(clipped)));
}

function rightAligned(left: string, right: string, width: number): string {
  const rightWidth = visibleWidth(right);
  const leftWidth = Math.max(0, width - rightWidth - 1);
  return (
    fit(left, leftWidth) +
    " ".repeat(Math.max(1, width - leftWidth - rightWidth)) +
    fit(right, rightWidth)
  );
}

function formatDuration(agent: FleetAgentSummary): string {
  const end = agent.endTime ?? Date.now();
  const seconds = Math.max(0, Math.floor((end - agent.startTime) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${seconds % 60}s`;
}

function isSteerable(agent: FleetAgentSummary | undefined): boolean {
  return agent?.status === "starting" || agent?.status === "running";
}

function isFinished(agent: FleetAgentSummary | undefined): boolean {
  return Boolean(agent) && !isSteerable(agent);
}

function statusGlyph(agent: FleetAgentSummary, theme: Theme): string {
  if (agent.status === "running") return theme.fg("accent", "●");
  if (agent.status === "starting") return theme.fg("muted", "◦");
  if (agent.status === "completed") return theme.fg("success", "✓");
  if (agent.status === "interrupted") return theme.fg("warning", "■");
  return theme.fg("error", "✗");
}

export class SubagentFleetComponent implements Component, Focusable {
  private agents: FleetAgentSummary[] = [];
  private selected = 0;
  private selectedId: string | undefined;
  private detailScroll = 0;
  private detailAutoFollow = true;
  private detailLineCount = 0;
  private bodyHeight = 8;
  private mode: "browse" | "steer" | "confirm" = "browse";
  private steerTargetId: string | undefined;
  private confirmAction:
    | { kind: "remove-selected"; targetId: string }
    | { kind: "remove-all" }
    | { kind: "stop-selected"; targetId: string }
    | { kind: "stop-all" }
    | undefined;
  private feedback = "";
  private disposed = false;
  private readonly input = new Input();
  private readonly timer: ReturnType<typeof setInterval>;
  private _focused = false;

  constructor(
    private readonly tui: TUI,
    private readonly theme: Theme,
    private readonly source: FleetDataSource,
    private readonly done: (result: undefined) => void,
    refreshMs = DEFAULT_REFRESH_MS,
  ) {
    this.input.onSubmit = (value) => this.submitSteer(value);
    this.input.onEscape = () => this.cancelSteer();
    this.refresh();
    this.timer = setInterval(() => {
      if (this.disposed) return;
      this.refresh();
      this.tui.requestRender();
    }, refreshMs);
    this.timer.unref?.();
  }

  get focused(): boolean {
    return this._focused;
  }

  set focused(value: boolean) {
    this._focused = value;
    this.input.focused = value && this.mode === "steer";
  }

  private refresh(): void {
    const previousId = this.agents[this.selected]?.id ?? this.selectedId;
    this.agents = this.source.listAgents();
    const preserved = previousId
      ? this.agents.findIndex((agent) => agent.id === previousId)
      : -1;
    this.selected =
      preserved >= 0
        ? preserved
        : Math.min(this.selected, Math.max(0, this.agents.length - 1));
    this.selectedId = this.agents[this.selected]?.id;

    if (
      this.mode === "steer" &&
      !isSteerable(
        this.steerTargetId
          ? this.source.getAgent(this.steerTargetId)
          : undefined,
      )
    ) {
      this.cancelSteer();
      this.feedback = "The selected sub-agent is no longer running.";
    }
  }

  private moveSelection(delta: number): void {
    if (this.agents.length === 0) return;
    this.selected = Math.max(
      0,
      Math.min(this.agents.length - 1, this.selected + delta),
    );
    this.selectedId = this.agents[this.selected]?.id;
    this.detailAutoFollow = true;
    this.detailScroll = 0;
    this.feedback = "";
    this.tui.requestRender();
  }

  private beginSteer(): void {
    const selected = this.agents[this.selected];
    if (!selected) {
      this.feedback = "No sub-agent is selected.";
      this.tui.requestRender();
      return;
    }
    if (!isSteerable(selected)) {
      this.feedback = "Finished sub-agents cannot be steered yet.";
      this.tui.requestRender();
      return;
    }
    this.mode = "steer";
    this.steerTargetId = this.selectedId;
    this.feedback = "";
    this.input.setValue("");
    this.input.focused = this.focused;
    this.tui.requestRender();
  }

  private cancelSteer(): void {
    this.mode = "browse";
    this.steerTargetId = undefined;
    this.input.setValue("");
    this.input.focused = false;
    this.tui.requestRender();
  }

  private submitSteer(value: string): void {
    const id = this.steerTargetId;
    const text = value.trim();
    if (!id) {
      this.cancelSteer();
      this.feedback = "The selected sub-agent is no longer running.";
      return;
    }
    if (!text) {
      this.feedback = "Guidance cannot be empty.";
      this.tui.requestRender();
      return;
    }

    const result = this.source.steer(id, text);
    this.mode = "browse";
    this.steerTargetId = undefined;
    this.input.setValue("");
    this.input.focused = false;
    this.feedback = result.message;
    this.refresh();
    this.tui.requestRender();
  }

  private beginRemoveSelected(): void {
    const selected = this.agents[this.selected];
    if (!isFinished(selected)) return;

    this.mode = "confirm";
    this.confirmAction = {
      kind: "remove-selected",
      targetId: selected!.id,
    };
    this.feedback = "";
    this.tui.requestRender();
  }

  private beginRemoveAll(): void {
    if (!this.agents.some(isFinished)) return;

    this.mode = "confirm";
    this.confirmAction = { kind: "remove-all" };
    this.feedback = "";
    this.tui.requestRender();
  }

  private beginStopSelected(): void {
    const selected = this.agents[this.selected];
    if (!isSteerable(selected)) return;

    this.mode = "confirm";
    this.confirmAction = {
      kind: "stop-selected",
      targetId: selected!.id,
    };
    this.feedback = "";
    this.tui.requestRender();
  }

  private beginStopAll(): void {
    if (!this.agents.some(isSteerable)) return;

    this.mode = "confirm";
    this.confirmAction = { kind: "stop-all" };
    this.feedback = "";
    this.tui.requestRender();
  }

  private cancelConfirmation(): void {
    this.mode = "browse";
    this.confirmAction = undefined;
    this.tui.requestRender();
  }

  private confirm(): void {
    const action = this.confirmAction;
    if (!action) {
      this.cancelConfirmation();
      return;
    }

    const result =
      action.kind === "remove-selected"
        ? this.source.remove(action.targetId)
        : action.kind === "remove-all"
          ? this.source.removeAllFinished()
          : action.kind === "stop-selected"
            ? this.source.stop(action.targetId)
            : this.source.stopAllRunning();
    this.mode = "browse";
    this.confirmAction = undefined;
    this.feedback = result.message;
    this.refresh();
    this.tui.requestRender();
  }

  handleInput(data: string): void {
    if (this.mode === "steer") {
      this.input.handleInput(data);
      this.tui.requestRender();
      return;
    }
    if (this.mode === "confirm") {
      if (matchesKey(data, "enter") || matchesKey(data, "y") || data === "Y") {
        this.confirm();
      } else if (matchesKey(data, "escape")) {
        this.cancelConfirmation();
      }
      return;
    }

    if (
      matchesKey(data, "escape") ||
      matchesKey(data, "ctrl+c") ||
      matchesKey(data, "q")
    ) {
      this.done(undefined);
      return;
    }
    if (matchesKey(data, "up") || matchesKey(data, "k")) {
      this.moveSelection(-1);
      return;
    }
    if (matchesKey(data, "down") || matchesKey(data, "j")) {
      this.moveSelection(1);
      return;
    }
    if (matchesKey(data, "home")) {
      this.moveSelection(-this.agents.length);
      return;
    }
    if (matchesKey(data, "end")) {
      this.moveSelection(this.agents.length);
      return;
    }
    if (matchesKey(data, "pageUp")) {
      this.detailAutoFollow = false;
      this.detailScroll = Math.max(0, this.detailScroll - this.bodyHeight);
      this.tui.requestRender();
      return;
    }
    if (matchesKey(data, "pageDown")) {
      const maxScroll = Math.max(0, this.detailLineCount - this.bodyHeight);
      this.detailScroll = Math.min(
        maxScroll,
        this.detailScroll + this.bodyHeight,
      );
      this.detailAutoFollow = this.detailScroll >= maxScroll;
      this.tui.requestRender();
      return;
    }
    if (matchesKey(data, "s")) {
      this.beginSteer();
      return;
    }
    if (matchesKey(data, "r")) {
      this.beginRemoveSelected();
      return;
    }
    if (data === "R") {
      this.beginRemoveAll();
      return;
    }
    if (matchesKey(data, "x")) {
      this.beginStopSelected();
      return;
    }
    if (data === "X") {
      this.beginStopAll();
    }
  }

  private rosterLines(width: number): string[] {
    if (this.agents.length === 0) {
      return [this.theme.fg("dim", " No sub-agent sessions")];
    }

    const start = Math.max(
      0,
      Math.min(
        this.selected - this.bodyHeight + 1,
        Math.max(0, this.agents.length - this.bodyHeight),
      ),
    );
    return this.agents
      .slice(start, start + this.bodyHeight)
      .map((agent, offset) => {
        const index = start + offset;
        const marker =
          index === this.selected ? this.theme.fg("accent", "›") : " ";
        const name = agent.agentType ?? "agent";
        const state =
          agent.status === "error"
            ? "(error)"
            : agent.status === "interrupted"
              ? "(stopped)"
              : formatDuration(agent);
        const left = `${marker} ${statusGlyph(agent, this.theme)} ${agent.id} ${name}`;
        return rightAligned(left, this.theme.fg("dim", state), width);
      });
  }

  private wrapLines(text: string, width: number): string[] {
    const lines: string[] = [];
    for (const sourceLine of text.split(/\r?\n/)) {
      const wrapped = wrapTextWithAnsi(sourceLine, Math.max(1, width));
      lines.push(...(wrapped.length ? wrapped : [""]));
    }
    return lines;
  }

  private userMessageLines(text: string, width: number): string[] {
    return this.wrapLines(text, Math.max(1, width - 2)).map((line) =>
      this.theme.bg(
        "userMessageBg",
        this.theme.fg("userMessageText", fit(` ${line}`, width)),
      ),
    );
  }

  private toolActivityLines(
    activity: string,
    width: number,
    pending: boolean,
  ): string[] {
    const match = activity.match(/^🔧\s+([^:]+)(?::\s*(.*))?$/s);
    const toolName = match?.[1]?.trim() ?? "tool";
    const args = match?.[2]?.trim() ?? "";
    const content =
      this.theme.fg("toolTitle", this.theme.bold(toolName)) +
      (args ? ` ${this.theme.fg("toolOutput", args)}` : "");
    const background = pending ? "toolPendingBg" : "toolSuccessBg";
    const horizontalPadding = 2;
    const contentWidth = Math.max(1, width - horizontalPadding * 2);
    const topBlank = this.theme.bg(background, fit("", width));
    const contentLines = this.wrapLines(content, contentWidth).map((line) =>
      this.theme.bg(
        background,
        fit(`${" ".repeat(horizontalPadding)}${line}`, width),
      ),
    );
    const bottomBlank = this.theme.bg(background, fit("", width));
    return [topBlank, ...contentLines, bottomBlank];
  }

  private conversationLines(agent: FleetAgentDetail, width: number): string[] {
    const lines: string[] = [];
    const identity = `${agent.agentType ?? "agent"} · ${agent.model ?? "model unknown"}`;
    const state = `${statusGlyph(agent, this.theme)} ${agent.status} · ${formatDuration(agent)}`;
    lines.push(
      rightAligned(
        this.theme.fg("muted", ` ${identity}`),
        this.theme.fg("dim", `${state} `),
        width,
      ),
      "",
      ...this.userMessageLines(agent.task, width),
    );

    const appendActivityBlock = (block: string[]) => {
      lines.push("", ...block);
    };

    let lastToolIndex = -1;
    for (let index = agent.activity.length - 1; index >= 0; index--) {
      if (agent.activity[index]?.startsWith("🔧 ")) {
        lastToolIndex = index;
        break;
      }
    }
    for (const [index, activity] of agent.activity.entries()) {
      if (activity.startsWith("✅ RPC response")) continue;
      if (activity.startsWith("📨 Parent guidance: ")) {
        appendActivityBlock(
          this.userMessageLines(
            activity.slice("📨 Parent guidance: ".length),
            width,
          ),
        );
        continue;
      }
      if (activity.startsWith("💬 ")) {
        appendActivityBlock(
          this.wrapLines(
            this.theme.fg("text", activity.slice("💬 ".length)),
            Math.max(1, width - 1),
          ).map((line) => ` ${line}`),
        );
        continue;
      }
      if (activity.startsWith("🔧 ")) {
        appendActivityBlock(
          this.toolActivityLines(
            activity,
            width,
            index === lastToolIndex && Boolean(agent.currentTool),
          ),
        );
        continue;
      }

      const statusText = activity
        .replace(/^🏁\s*/, "")
        .replace(/^↻\s*/, "Retry: ")
        .replace(/^❌\s*/, "Error: ");
      const color = activity.startsWith("❌") ? "error" : "dim";
      appendActivityBlock(
        this.wrapLines(
          this.theme.fg(color, ` ${statusText}`),
          Math.max(1, width),
        ),
      );
    }

    const preview = agent.currentResponsePreview.trim();
    if (preview) {
      appendActivityBlock([
        ...this.wrapLines(
          this.theme.fg("text", preview),
          Math.max(1, width - 2),
        ).map((line) => ` ${line}`),
        this.theme.fg("accent", " ▍"),
      ]);
    }
    if (agent.activity.length === 0 && !preview) {
      appendActivityBlock([this.theme.fg("dim", " Waiting for a response…")]);
    }
    return lines;
  }

  private detailLines(width: number): string[] {
    const summary = this.agents[this.selected];
    const agent = summary ? this.source.getAgent(summary.id) : undefined;
    if (!agent) {
      return [
        this.theme.fg("dim", " No running sub-agent selected."),
        "",
        this.theme.fg("dim", " New sub-agents appear here automatically."),
      ];
    }
    return this.conversationLines(agent, width);
  }

  private confirmationLines(width: number): string[] {
    const action = this.confirmAction;
    const message =
      action?.kind === "remove-all"
        ? "Remove ALL finished subagents?"
        : action?.kind === "stop-selected"
          ? "Stop this running subagent?"
          : action?.kind === "stop-all"
            ? "Stop ALL running subagents?"
            : "Remove the selected subagent?";
    const innerWidth = Math.max(1, width - 2);
    const border = (text: string) => this.theme.fg("border", text);
    return [
      border(`╭${"─".repeat(innerWidth)}╮`),
      border("│") + fit(` ${message}`, innerWidth) + border("│"),
      border("│") +
        fit(
          this.theme.fg("dim", " Enter/Y/y confirm · Esc cancel"),
          innerWidth,
        ) +
        border("│"),
      border(`╰${"─".repeat(innerWidth)}╯`),
    ];
  }

  render(width: number): string[] {
    if (width < 36) {
      return [
        truncateToWidth(
          "Subagent window needs at least 36 columns. Esc closes.",
          width,
        ),
      ];
    }

    if (this.mode === "confirm") {
      return this.confirmationLines(width).map((line) =>
        truncateToWidth(line, width, ""),
      );
    }

    const innerWidth = width - 2;
    const rows = this.tui.terminal?.rows ?? 32;
    this.bodyHeight = Math.max(1, Math.min(42, Math.floor(rows * 0.9) - 8));
    const rosterWidth = Math.max(
      20,
      Math.min(28, Math.floor((innerWidth - 1) * 0.28)),
    );
    const detailWidth = Math.max(1, innerWidth - rosterWidth - 1);
    const roster = this.rosterLines(rosterWidth);
    const details = this.detailLines(detailWidth);
    this.detailLineCount = details.length;

    const maxDetailScroll = Math.max(0, details.length - this.bodyHeight);
    if (this.detailAutoFollow) this.detailScroll = maxDetailScroll;
    else this.detailScroll = Math.min(this.detailScroll, maxDetailScroll);
    const visibleDetails = details.slice(
      this.detailScroll,
      this.detailScroll + this.bodyHeight,
    );

    const border = (text: string) => this.theme.fg("border", text);
    const lines = [border(`╭${"─".repeat(innerWidth)}╮`)];
    lines.push(
      border("│") +
        fit(
          ` ${this.theme.bold("Subagents")} ${this.theme.fg("dim", "· mini sessions")}`,
          innerWidth,
        ) +
        border("│"),
    );
    lines.push(
      border(`├${"─".repeat(rosterWidth)}┬${"─".repeat(detailWidth)}┤`),
    );
    for (let index = 0; index < this.bodyHeight; index++) {
      lines.push(
        border("│") +
          fit(roster[index] ?? "", rosterWidth) +
          border("│") +
          fit(visibleDetails[index] ?? "", detailWidth) +
          border("│"),
      );
    }
    lines.push(
      border(`├${"─".repeat(rosterWidth)}┴${"─".repeat(detailWidth)}┤`),
    );

    if (this.mode === "steer") {
      const target = this.steerTargetId ?? "?";
      const label = ` Steer ${target}: `;
      const inputWidth = Math.max(1, innerWidth - visibleWidth(label));
      const inputLine = this.input.render(inputWidth)[0] ?? "";
      lines.push(
        border("│") + fit(label + inputLine, innerWidth) + border("│"),
      );
    } else {
      const selected = this.agents[this.selected];
      const target = isSteerable(selected)
        ? ` Press s to steer ${selected?.id}`
        : selected
          ? " Session finished"
          : " No sub-agent session selected";
      lines.push(
        border("│") +
          fit(this.theme.fg("dim", ` ›${target}`), innerWidth) +
          border("│"),
      );
    }

    const position = this.agents.length
      ? `${this.selected + 1}/${this.agents.length}`
      : "0/0";
    const footer =
      this.mode === "steer"
        ? " Enter send · Esc cancel"
        : this.feedback
          ? ` ${this.feedback} · ↑↓ agents · s steer · r remove · x stop · Esc close`
          : ` ↑↓/jk agent · PgUp/PgDn session · s steer · r/R remove · x/X stop · Esc close · ${position}`;
    lines.push(
      border("│") + fit(this.theme.fg("dim", footer), innerWidth) + border("│"),
    );
    lines.push(border(`╰${"─".repeat(innerWidth)}╯`));

    return lines.map((line) => truncateToWidth(line, width, ""));
  }

  invalidate(): void {
    this.input.invalidate();
  }

  dispose(): void {
    this.disposed = true;
    clearInterval(this.timer);
  }
}

export async function openSubagentFleet(
  ctx: ExtensionContext,
  source: FleetDataSource,
): Promise<void> {
  await ctx.ui.custom<undefined>(
    (tui, theme, _keybindings, done) =>
      new SubagentFleetComponent(tui, theme, source, done),
    {
      overlay: true,
      overlayOptions: {
        anchor: "center",
        width: "85%",
        minWidth: 60,
        maxHeight: "95%",
        margin: 1,
      },
    },
  );
}
