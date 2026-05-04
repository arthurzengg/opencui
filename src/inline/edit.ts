import * as vscode from "vscode"
import { ServerManager } from "../server"
import { SessionRunner } from "../session"
import { Preferences } from "../preferences"
import { log } from "../output"

const FENCE_RE = /```[a-zA-Z0-9_+-]*\n([\s\S]*?)```/

export class InlineEdit {
  private runner: SessionRunner | undefined

  constructor(private servers: ServerManager, private prefs: Preferences) {}

  async run() {
    const editor = vscode.window.activeTextEditor
    if (!editor) {
      vscode.window.showWarningMessage("OpenCUI: open a file first")
      return
    }
    if (editor.selection.isEmpty) {
      vscode.window.showWarningMessage("OpenCUI: select code to edit first")
      return
    }
    const instruction = await vscode.window.showInputBox({
      prompt: "What change do you want?",
      placeHolder: "e.g. add error handling, refactor to async, ...",
    })
    if (!instruction) return

    const original = editor.document.getText(editor.selection)
    const language = editor.document.languageId

    const proceed = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: "OpenCUI is editing...",
        cancellable: false,
      },
      async () => {
        try {
          const backend = await this.servers.ensure()
          this.runner ??= new SessionRunner(backend, this.prefs)
          this.runner.newSession()
          const prompt = buildEditPrompt(instruction, language, original)
          const reply = await this.runner.prompt({ text: prompt })
          const replacement = extractCode(reply, original)
          return replacement
        } catch (e) {
          log("inline edit failed", e)
          vscode.window.showErrorMessage(`OpenCUI: ${(e as Error).message}`)
          return undefined
        }
      },
    )
    if (!proceed) return

    await previewAndApply(editor, editor.selection, original, proceed, language)
  }
}

function buildEditPrompt(instruction: string, language: string, code: string) {
  return [
    `You are editing a ${language} file. Apply this instruction to the selected code:`,
    instruction,
    "",
    "Return ONLY the rewritten code in a single fenced code block, no explanation.",
    "",
    "Selected code:",
    "```" + language,
    code,
    "```",
  ].join("\n")
}

function extractCode(reply: string, fallback: string): string {
  const m = reply.match(FENCE_RE)
  if (m) return m[1].replace(/\n$/, "")
  return reply.trim() || fallback
}

async function previewAndApply(
  editor: vscode.TextEditor,
  range: vscode.Range,
  original: string,
  replacement: string,
  language: string,
) {
  const doc = editor.document
  const leftUri = vscode.Uri.parse(`untitled:OpenCUI-original.${ext(language)}`)
  const rightUri = vscode.Uri.parse(`untitled:OpenCUI-proposed.${ext(language)}`)

  const left = await vscode.workspace.openTextDocument(leftUri)
  const right = await vscode.workspace.openTextDocument(rightUri)
  const leftEdit = new vscode.WorkspaceEdit()
  leftEdit.insert(leftUri, new vscode.Position(0, 0), original)
  await vscode.workspace.applyEdit(leftEdit)
  const rightEdit = new vscode.WorkspaceEdit()
  rightEdit.insert(rightUri, new vscode.Position(0, 0), replacement)
  await vscode.workspace.applyEdit(rightEdit)

  await vscode.commands.executeCommand("vscode.diff", leftUri, rightUri, "OpenCUI: Proposed change")

  const choice = await vscode.window.showInformationMessage(
    "Apply OpenCUI's edit?",
    { modal: false },
    "Apply",
    "Discard",
  )
  if (choice === "Apply") {
    const edit = new vscode.WorkspaceEdit()
    edit.replace(doc.uri, range, replacement)
    await vscode.workspace.applyEdit(edit)
  }
}

function ext(language: string) {
  const map: Record<string, string> = {
    typescript: "ts",
    typescriptreact: "tsx",
    javascript: "js",
    javascriptreact: "jsx",
    python: "py",
    rust: "rs",
    go: "go",
  }
  return map[language] ?? "txt"
}
