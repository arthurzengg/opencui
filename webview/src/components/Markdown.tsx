import { CodeBlock } from "./CodeBlock"

type Props = { text: string }

type Segment =
  | { kind: "text"; value: string }
  | { kind: "code"; language?: string; value: string }

function parse(text: string): Segment[] {
  const segs: Segment[] = []
  const re = /```([a-zA-Z0-9_+-]*)\n([\s\S]*?)```/g
  let last = 0
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) segs.push({ kind: "text", value: text.slice(last, m.index) })
    segs.push({ kind: "code", language: m[1] || undefined, value: m[2].replace(/\n$/, "") })
    last = m.index + m[0].length
  }
  if (last < text.length) segs.push({ kind: "text", value: text.slice(last) })
  return segs
}

function renderInline(value: string): string {
  // very small markdown: **bold**, *italic*, `code`, links
  let html = value
    .replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]!)
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|\W)\*(\S.*?)\*(?=\W|$)/g, "$1<em>$2</em>")
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>')
  // paragraphs: double newline → <br/><br/>
  html = html.replace(/\n/g, "<br/>")
  return html
}

export function Markdown({ text }: Props) {
  const segs = parse(text)
  return (
    <div className="md">
      {segs.map((s, i) =>
        s.kind === "code" ? (
          <CodeBlock key={i} code={s.value} language={s.language} />
        ) : (
          <div key={i} className="md-text" dangerouslySetInnerHTML={{ __html: renderInline(s.value) }} />
        ),
      )}
    </div>
  )
}
