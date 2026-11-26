import type { ReactNode } from 'react';

/** AI 답의 굵게·목록·제목·코드·링크만 그린다. HTML은 그대로 글자로 둔다. */
const INLINE = /(\*\*[^*\n]+\*\*|`[^`\n]+`|\[[^\]\n]+\]\([^)\s]+\))/g;

function inline(text: string, base: string): ReactNode[] {
  return text.split(INLINE).map((part, i) => {
    const k = `${base}-${i}`;
    if (part.startsWith('**') && part.endsWith('**') && part.length > 4) return <strong key={k}>{part.slice(2, -2)}</strong>;
    if (part.startsWith('`') && part.endsWith('`') && part.length > 2) return <code key={k}>{part.slice(1, -1)}</code>;
    const link = /^\[([^\]]+)\]\(([^)\s]+)\)$/.exec(part);
    if (link) {
      return /^https?:\/\//i.test(link[2]!)
        ? <a key={k} href={link[2]} target="_blank" rel="noreferrer noopener">{link[1]}</a>
        : <span key={k}>{link[1]}</span>;
    }
    return part;
  });
}

export function Markdown({ text }: { text: string }) {
  const out: ReactNode[] = [];
  let para: string[] = [];
  let list: { ordered: boolean; items: string[] } | null = null;

  const flushPara = () => {
    if (para.length) out.push(<p key={`p${out.length}`}>{inline(para.join('\n'), `p${out.length}`)}</p>);
    para = [];
  };
  const flushList = () => {
    if (!list) return;
    const items = list.items.map((it, i) => <li key={i}>{inline(it, `l${out.length}-${i}`)}</li>);
    out.push(list.ordered ? <ol key={`o${out.length}`}>{items}</ol> : <ul key={`u${out.length}`}>{items}</ul>);
    list = null;
  };

  for (const raw of text.split('\n')) {
    const line = raw.trimEnd();
    const heading = /^#{1,6}\s+(.*)$/.exec(line);
    const bullet = /^\s*[-*•]\s+(.*)$/.exec(line);
    const numbered = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    if (line.trim() === '') { flushPara(); flushList(); continue; }
    if (heading) { flushPara(); flushList(); out.push(<h4 key={`h${out.length}`}>{inline(heading[1]!, `h${out.length}`)}</h4>); continue; }
    if (bullet || numbered) {
      flushPara();
      const ordered = Boolean(numbered && !bullet);
      if (list && list.ordered !== ordered) flushList();
      list ??= { ordered, items: [] };
      list.items.push((bullet ?? numbered)![1]!);
      continue;
    }
    flushList();
    para.push(line.replace(/^>\s?/, ''));
  }
  flushPara();
  flushList();
  return <div className="md">{out}</div>;
}
