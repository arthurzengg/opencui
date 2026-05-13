import type { ReviewChange, ReviewHunkState } from "../protocol"
import { escapeHtml } from "./paths"
import {
  type ReviewDiffLine,
  diffLines,
  reviewKey,
  splitReviewDiff,
} from "./diff"

/**
 * Build the inline review-panel HTML for a single ReviewChange. Pending hunks
 * (those not yet accepted/rejected in `reviewed`) get Keep/Undo buttons; the
 * panel posts back via webview messages on click.
 */
export function reviewChangeHtml(change: ReviewChange, reviewed: Record<string, ReviewHunkState>): string {
  const diff = splitReviewDiff(change.patch)
  const pending = diff.hunks
    .map((hunk) => ({ ...hunk, key: reviewKey(change, hunk.id) }))
    .filter((hunk) => !reviewed[hunk.key])
  const payload = JSON.stringify(
    pending.map(({ key, oldText, newText, reversible }) => ({ key, oldText, newText, reversible })),
  ).replace(/</g, "\\u003c")
  const body = pending.length
    ? pending.map((hunk) => `
      <section class="hunk" data-key="${escapeHtml(hunk.key)}">
        <div class="hunk-head">
          <button class="action accept" data-action="accepted" data-key="${escapeHtml(hunk.key)}">Keep</button>
          <button class="action reject" data-action="rejected" data-key="${escapeHtml(hunk.key)}"${hunk.reversible ? "" : " disabled title=\"This patch format cannot be undone as a hunk\""}>Undo</button>
        </div>
        <pre class="code"><code>${hunk.lines.map(diffLineHtml).join("")}</code></pre>
      </section>
    `).join("")
    : `<div class="empty">All hunks in this file have been reviewed.</div>`

  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline';">
  <style>
    * { box-sizing: border-box; }
    body {
      margin: 0;
      color: var(--vscode-editor-foreground);
      background: var(--vscode-editor-background);
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
    }
    .top {
      position: sticky;
      top: 0;
      z-index: 2;
      display: flex;
      align-items: center;
      gap: 10px;
      min-width: 0;
      padding: 10px 14px;
      border-bottom: 1px solid var(--vscode-panel-border);
      background: var(--vscode-editor-background);
    }
    .title {
      min-width: 0;
      overflow: hidden;
      white-space: nowrap;
      text-overflow: ellipsis;
      font-weight: 650;
    }
    .stats {
      flex: 0 0 auto;
      margin-left: auto;
      font-family: var(--vscode-editor-font-family);
      font-size: 12px;
    }
    .add { color: var(--vscode-gitDecoration-addedResourceForeground, #3fb950); }
    .del { color: var(--vscode-gitDecoration-deletedResourceForeground, #f85149); }
    main { padding: 12px 14px 24px; }
    .hunk {
      margin: 0 0 14px;
      border: 1px solid var(--vscode-panel-border);
      border-radius: 6px;
      overflow: hidden;
      background: var(--vscode-textCodeBlock-background);
    }
    .hunk-head {
      display: flex;
      align-items: center;
      justify-content: flex-end;
      gap: 8px;
      padding: 7px 8px;
      border-bottom: 1px solid var(--vscode-panel-border);
      background: var(--vscode-editorWidget-background);
    }
    .action {
      flex: 0 0 auto;
      min-width: 64px;
      padding: 3px 9px;
      border: 1px solid var(--vscode-button-border, transparent);
      border-radius: 4px;
      background: var(--vscode-button-secondaryBackground);
      color: var(--vscode-button-secondaryForeground);
      font: inherit;
      font-size: 12px;
      cursor: pointer;
    }
    .action:hover:not(:disabled) { background: var(--vscode-button-secondaryHoverBackground); }
    .action.accept { color: var(--vscode-gitDecoration-addedResourceForeground, #3fb950); }
    .action.reject { color: var(--vscode-gitDecoration-deletedResourceForeground, #f85149); }
    .action:disabled { cursor: default; opacity: 0.55; }
    .code {
      margin: 0;
      padding: 0;
      overflow: auto;
      font-family: var(--vscode-editor-font-family);
      font-size: var(--vscode-editor-font-size);
      line-height: 1.45;
    }
    .line {
      display: block;
      min-height: 1.45em;
      padding: 0 12px;
      white-space: pre;
    }
    .line.add {
      color: var(--vscode-gitDecoration-addedResourceForeground, #3fb950);
      background: color-mix(in srgb, var(--vscode-gitDecoration-addedResourceForeground, #3fb950) 14%, transparent);
    }
    .line.del {
      color: var(--vscode-gitDecoration-deletedResourceForeground, #f85149);
      background: color-mix(in srgb, var(--vscode-gitDecoration-deletedResourceForeground, #f85149) 14%, transparent);
    }
    .line.hunk {
      color: var(--vscode-textLink-foreground);
      background: var(--vscode-editor-lineHighlightBackground);
    }
    .empty {
      padding: 24px;
      color: var(--vscode-descriptionForeground);
      text-align: center;
    }
  </style>
</head>
<body>
  <div class="top">
    <span class="title" title="${escapeHtml(change.path)}">${escapeHtml(change.path)}</span>
    <span class="stats"><span class="add">+${change.additions}</span> <span class="del">-${change.deletions}</span></span>
  </div>
  <main>${body}</main>
  <script>
    const vscode = acquireVsCodeApi();
    const hunks = new Map(${payload}.map((hunk) => [hunk.key, hunk]));
    document.addEventListener("click", (event) => {
      const button = event.target.closest("button[data-key]");
      if (!button) return;
      const hunk = hunks.get(button.dataset.key);
      if (!hunk) return;
      if (button.dataset.action === "rejected" && !hunk.reversible) return;
      button.closest(".hunk")?.querySelectorAll("button").forEach((item) => item.disabled = true);
      vscode.postMessage({
        type: "reviewHunk",
        key: hunk.key,
        path: ${JSON.stringify(change.path)},
        action: button.dataset.action,
        oldText: hunk.oldText,
        newText: hunk.newText
      });
    });
  </script>
</body>
</html>`
}

function diffLineHtml(line: ReviewDiffLine) {
  return `<span class="line ${line.kind}">${escapeHtml(line.text || " ")}</span>`
}

export function hasPendingReviewHunks(change: ReviewChange, reviewed: Record<string, ReviewHunkState>) {
  return splitReviewDiff(change.patch).hunks.some((hunk) => !reviewed[reviewKey(change, hunk.id)])
}

export function fallbackHtml(message: string): string {
  return `<!doctype html><html><body style="padding:20px;font-family:sans-serif;">
    <h2>OpenCode Panel</h2><p>${message}</p></body></html>`
}
