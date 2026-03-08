import { html, nothing } from "lit";
import type { AuditEntry } from "../controllers/audit-logs.ts";

const ALL_KINDS = [
  "user.message",
  "tool.call",
  "tool.blocked",
  "tool.result",
  "skill.install",
  "llm.request",
  "llm.response",
  "session.start",
  "session.end",
  "access.denied",
] as const;

const KIND_COLOR: Record<string, string> = {
  "user.message": "#4caf50",
  "tool.call": "#2196f3",
  "tool.blocked": "#f44336",
  "tool.result": "#9c27b0",
  "skill.install": "#ff9800",
  "llm.request": "#607d8b",
  "llm.response": "#607d8b",
  "session.start": "#00bcd4",
  "session.end": "#00bcd4",
  "access.denied": "#f44336",
};

function formatTime(isoTime?: string): string {
  if (!isoTime) return "";
  const d = new Date(isoTime);
  if (Number.isNaN(d.getTime())) return isoTime;
  return d.toLocaleTimeString();
}

function matchesFilter(entry: AuditEntry, needle: string): boolean {
  if (!needle) return true;
  const haystack = [entry.kind, entry.summary, entry.toolName, entry.skillName, entry.userId, entry.agentId, entry.raw]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  return haystack.includes(needle);
}

export type AuditLogsProps = {
  loading: boolean;
  error: string | null;
  file: string | null;
  entries: AuditEntry[];
  filterText: string;
  kindFilters: Record<string, boolean>;
  truncated: boolean;
  date: string;
  availableDates: string[];
  onFilterTextChange: (next: string) => void;
  onKindToggle: (kind: string, enabled: boolean) => void;
  onDateChange: (date: string) => void;
  onRefresh: () => void;
  onExport: (lines: string[]) => void;
};

export function renderAuditLogs(props: AuditLogsProps) {
  const needle = props.filterText.trim().toLowerCase();
  const filtered = props.entries
    .filter((entry) => {
      if (entry.kind && !props.kindFilters[entry.kind]) return false;
      return matchesFilter(entry, needle);
    })
    .reverse();

  const hasKindFilters = ALL_KINDS.some((k) => !props.kindFilters[k]);
  const exportLabel = needle || hasKindFilters ? "filtered" : "all";

  return html`
    <section class="card">
      <div class="row" style="justify-content: space-between; align-items: flex-start;">
        <div>
          <div class="card-title">Audit Log</div>
          <div class="card-sub">Structured security audit events (JSONL).</div>
        </div>
        <div class="row" style="gap: 8px; flex-shrink: 0;">
          <button class="btn" ?disabled=${props.loading} @click=${props.onRefresh}>
            ${props.loading ? "Loading…" : "Refresh"}
          </button>
          <button
            class="btn"
            ?disabled=${filtered.length === 0}
            @click=${() => props.onExport(filtered.map((e) => e.raw))}
          >
            Export ${exportLabel}
          </button>
        </div>
      </div>

      <div class="filters" style="margin-top: 14px; gap: 12px; flex-wrap: wrap;">
        <label class="field" style="min-width: 140px;">
          <span>Date</span>
          <select
            .value=${props.date}
            @change=${(e: Event) => props.onDateChange((e.target as HTMLSelectElement).value)}
          >
            ${props.availableDates.length === 0
              ? html`<option value=${props.date}>${props.date}</option>`
              : props.availableDates.map(
                  (d) => html`<option value=${d} ?selected=${d === props.date}>${d}</option>`,
                )}
          </select>
        </label>
        <label class="field" style="min-width: 220px;">
          <span>Search</span>
          <input
            .value=${props.filterText}
            @input=${(e: Event) => props.onFilterTextChange((e.target as HTMLInputElement).value)}
            placeholder="Filter by kind, tool, user…"
          />
        </label>
      </div>

      <div class="chip-row" style="margin-top: 12px; flex-wrap: wrap; gap: 6px;">
        ${ALL_KINDS.map(
          (kind) => html`
            <label class="chip" style="--chip-color: ${KIND_COLOR[kind] ?? "#888"}; border-color: ${props.kindFilters[kind] ? (KIND_COLOR[kind] ?? "#888") : "transparent"}; opacity: ${props.kindFilters[kind] ? "1" : "0.45"};">
              <input
                type="checkbox"
                .checked=${props.kindFilters[kind] ?? true}
                @change=${(e: Event) =>
                  props.onKindToggle(kind, (e.target as HTMLInputElement).checked)}
              />
              <span>${kind}</span>
            </label>
          `,
        )}
      </div>

      ${props.file
        ? html`<div class="muted" style="margin-top: 10px; font-size: 12px;">File: ${props.file}</div>`
        : nothing}
      ${props.truncated
        ? html`<div class="callout" style="margin-top: 10px;">Showing latest chunk — older events in the file are not shown.</div>`
        : nothing}
      ${props.error
        ? html`<div class="callout danger" style="margin-top: 10px;">${props.error}</div>`
        : nothing}

      <div class="log-stream" style="margin-top: 12px;">
        ${filtered.length === 0
          ? html`<div class="muted" style="padding: 12px;">No audit events.</div>`
          : filtered.map(
              (entry) => {
                // Skip unparseable blank lines
                if (!entry.kind && !entry.isoTime && !entry.summary) return nothing;
                const sub = entry.agentId ?? entry.userId ?? "";
                const subDisplay = sub.length > 16 ? `${sub.slice(0, 14)}…` : sub;
                const color = KIND_COLOR[entry.kind ?? ""] ?? "#888";
                const isMessage = entry.kind === "user.message";
                const isTool = entry.kind === "tool.call" || entry.kind === "tool.blocked";
                const hasFullContent = isMessage && typeof entry.content === "string" && entry.content.length > 0;
                const hasParams = isTool && typeof entry.paramsJson === "string";
                return html`
                <details class="audit-row-wrap" style="border-bottom: 1px solid var(--border, #2a2a2a);">
                  <summary class="log-row audit-row" style="list-style: none; cursor: pointer; padding: 5px 0; display: flex; align-items: center; gap: 8px; min-height: 28px;">
                    <div class="log-time mono" style="min-width: 64px; flex-shrink: 0; font-size: 11px; opacity: 0.7;">${formatTime(entry.isoTime)}</div>
                    <div style="display: flex; align-items: center; gap: 4px; min-width: 180px; max-width: 180px; flex-shrink: 0; overflow: hidden;">
                      <span
                        class="mono"
                        style="color: ${color}; font-size: 11px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; flex-shrink: 1;"
                        title=${entry.kind ?? "?"}
                      >${entry.kind ?? "?"}</span>
                      ${subDisplay ? html`<span class="mono" style="font-size: 10px; opacity: 0.5; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; flex-shrink: 1;" title=${sub}>${subDisplay}</span>` : nothing}
                    </div>
                    <div class="log-message mono" style="font-size: 12px; opacity: 0.9; flex: 1; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;" title=${entry.summary ?? ""}>
                      ${entry.summary ?? entry.raw}
                    </div>
                  </summary>
                  <div style="padding: 6px 8px 10px 8px; background: var(--bg2, #1a1a1a); font-size: 12px;">
                    ${hasFullContent
                      ? html`<div style="margin-bottom: 6px;"><span style="opacity:0.5; font-size: 11px;">message</span><pre class="mono" style="margin: 4px 0 0; white-space: pre-wrap; word-break: break-word; color: #c8e6c9;">${entry.content}</pre></div>`
                      : nothing}
                    ${hasParams
                      ? html`<div style="margin-bottom: 6px;"><span style="opacity:0.5; font-size: 11px;">params</span><pre class="mono" style="margin: 4px 0 0; white-space: pre-wrap; word-break: break-word; color: #bbdefb;">${entry.paramsJson}</pre></div>`
                      : nothing}
                    <div><span style="opacity:0.5; font-size: 11px;">raw</span><pre class="mono" style="margin: 4px 0 0; white-space: pre-wrap; word-break: break-word; opacity: 0.6; font-size: 11px;">${entry.raw}</pre></div>
                  </div>
                </details>
              `;
              },
            )}
      </div>
      ${filtered.length > 0
        ? html`<div class="muted" style="padding: 8px 0; font-size: 12px;">${filtered.length} events shown</div>`
        : nothing}
    </section>
  `;
}
