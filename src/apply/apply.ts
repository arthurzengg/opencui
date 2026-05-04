import * as vscode from "vscode"

/**
 * Apply a code block from chat to the active editor.
 *
 * Strategy (kept intentionally minimal):
 *  - If a selection exists, replace it.
 *  - Otherwise replace the entire active document.
 *  - User must accept via VS Code's normal undo (Cmd+Z) to revert.
 */
export async function applyCode(code: string, _language?: string) {
  const editor = vscode.window.activeTextEditor
  if (!editor) {
    vscode.window.showWarningMessage("OpenCUI: open a file first to apply")
    return
  }
  const doc = editor.document
  const target = editor.selection.isEmpty
    ? new vscode.Range(doc.positionAt(0), doc.positionAt(doc.getText().length))
    : editor.selection

  const original = doc.getText(target)
  const proposedUri = vscode.Uri.parse(
    `untitled:OpenCUI-apply-${Date.now()}.${doc.languageId}`,
  )
  const proposedDoc = await vscode.workspace.openTextDocument(proposedUri)
  const insert = new vscode.WorkspaceEdit()
  insert.insert(proposedUri, new vscode.Position(0, 0), code)
  await vscode.workspace.applyEdit(insert)

  await vscode.commands.executeCommand("vscode.diff", doc.uri, proposedUri, "OpenCUI: Apply preview")

  const choice = await vscode.window.showInformationMessage(
    "Apply this change?",
    { modal: false },
    "Apply",
    "Cancel",
  )
  if (choice !== "Apply") return

  const edit = new vscode.WorkspaceEdit()
  edit.replace(doc.uri, target, code)
  await vscode.workspace.applyEdit(edit)
  void original
}
