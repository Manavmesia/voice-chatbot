'use client';

import React from 'react';

interface FormattedMessageProps {
  content: string;
}

// ─── Inline Renderer ─────────────────────────────────────────────────────────
// Handles **bold**, *italic*, and `inline code` within a line of text.
function renderInline(text: string): React.ReactNode {
  const parts: React.ReactNode[] = [];
  // Pattern: `code`, **bold**, *italic*
  const pattern = /(`[^`]+`|\*\*[^*]+\*\*|\*[^*]+\*)/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  let idx = 0;

  while ((match = pattern.exec(text)) !== null) {
    const before = text.slice(lastIndex, match.index);
    if (before) parts.push(<span key={`t-${idx++}`}>{before}</span>);

    const token = match[0];
    if (token.startsWith('`') && token.endsWith('`')) {
      // Inline code
      parts.push(
        <code
          key={`c-${idx++}`}
          className="px-1.5 py-0.5 rounded text-[0.82em] font-mono bg-neutral-800 text-emerald-300 border border-neutral-700"
        >
          {token.slice(1, -1)}
        </code>
      );
    } else if (token.startsWith('**') && token.endsWith('**')) {
      parts.push(
        <strong key={`b-${idx++}`} className="font-semibold text-white">
          {token.slice(2, -2)}
        </strong>
      );
    } else if (token.startsWith('*') && token.endsWith('*')) {
      parts.push(
        <em key={`i-${idx++}`} className="italic text-neutral-300">
          {token.slice(1, -1)}
        </em>
      );
    }
    lastIndex = match.index + token.length;
  }

  const remaining = text.slice(lastIndex);
  if (remaining) parts.push(<span key={`t-${idx++}`}>{remaining}</span>);

  return parts.length === 0 ? text : <>{parts}</>;
}

// ─── Block Parser ─────────────────────────────────────────────────────────────
// Splits raw text into typed blocks for rendering.
type Block =
  | { type: 'code'; lang: string; content: string }
  | { type: 'heading'; level: 1 | 2 | 3; content: string }
  | { type: 'bullet'; items: string[] }
  | { type: 'numbered'; items: string[] }
  | { type: 'paragraph'; content: string }
  | { type: 'divider' };

function parseBlocks(raw: string): Block[] {
  const lines = raw.split('\n');
  const blocks: Block[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // ── Fenced code block ────────────────────────────────────────────────────
    const fenceMatch = line.match(/^```(\w*)$/);
    if (fenceMatch) {
      const lang = fenceMatch[1] || 'text';
      const codeLines: string[] = [];
      i++;
      while (i < lines.length && !lines[i].startsWith('```')) {
        codeLines.push(lines[i]);
        i++;
      }
      i++; // skip closing ```
      blocks.push({ type: 'code', lang, content: codeLines.join('\n') });
      continue;
    }

    // ── Markdown headings ────────────────────────────────────────────────────
    const h1 = line.match(/^#\s+(.*)/);
    if (h1) { blocks.push({ type: 'heading', level: 1, content: h1[1] }); i++; continue; }
    const h2 = line.match(/^##\s+(.*)/);
    if (h2) { blocks.push({ type: 'heading', level: 2, content: h2[1] }); i++; continue; }
    const h3 = line.match(/^###\s+(.*)/);
    if (h3) { blocks.push({ type: 'heading', level: 3, content: h3[1] }); i++; continue; }

    // ── Bullet list (•, -, *) ────────────────────────────────────────────────
    if (/^[•\-*]\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^[•\-*]\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^[•\-*]\s+/, ''));
        i++;
      }
      blocks.push({ type: 'bullet', items });
      continue;
    }

    // ── Numbered list ────────────────────────────────────────────────────────
    if (/^\d+\.\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\d+\.\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\d+\.\s+/, ''));
        i++;
      }
      blocks.push({ type: 'numbered', items });
      continue;
    }

    // ── Horizontal rule ──────────────────────────────────────────────────────
    if (/^---+$/.test(line.trim())) {
      blocks.push({ type: 'divider' });
      i++;
      continue;
    }

    // ── Empty line – skip ────────────────────────────────────────────────────
    if (line.trim() === '') {
      i++;
      continue;
    }

    // ── Paragraph: collect consecutive non-special lines ────────────────────
    const paragraphLines: string[] = [];
    while (
      i < lines.length &&
      lines[i].trim() !== '' &&
      !/^[•\-*]\s+/.test(lines[i]) &&
      !/^\d+\.\s+/.test(lines[i]) &&
      !lines[i].match(/^```/) &&
      !lines[i].match(/^#{1,3}\s/) &&
      !/^---+$/.test(lines[i].trim())
    ) {
      paragraphLines.push(lines[i]);
      i++;
    }
    if (paragraphLines.length > 0) {
      blocks.push({ type: 'paragraph', content: paragraphLines.join('\n') });
    }
  }

  return blocks;
}

// ─── Block Renderers ─────────────────────────────────────────────────────────

function CodeBlock({ lang, content }: { lang: string; content: string }) {
  const [copied, setCopied] = React.useState(false);

  const handleCopy = () => {
    navigator.clipboard.writeText(content).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };

  return (
    <div className="rounded-xl overflow-hidden border border-neutral-700/60 my-1">
      {/* Header bar */}
      <div className="flex items-center justify-between px-4 py-2 bg-neutral-800/80 border-b border-neutral-700/60">
        <span className="text-[10px] font-mono font-semibold text-neutral-400 uppercase tracking-widest">
          {lang || 'code'}
        </span>
        <button
          onClick={handleCopy}
          className="flex items-center gap-1.5 text-[10px] text-neutral-400 hover:text-neutral-200 transition-colors"
        >
          {copied ? (
            <>
              <svg className="w-3 h-3 text-emerald-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M5 13l4 4L19 7" />
              </svg>
              <span className="text-emerald-400">Copied</span>
            </>
          ) : (
            <>
              <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                  d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z"
                />
              </svg>
              Copy
            </>
          )}
        </button>
      </div>
      {/* Code content */}
      <pre className="px-4 py-3 overflow-x-auto bg-neutral-950 text-sm leading-6">
        <code className="font-mono text-emerald-200 whitespace-pre">
          {content}
        </code>
      </pre>
    </div>
  );
}

function BulletList({ items }: { items: string[] }) {
  return (
    <ul className="flex flex-col gap-1.5 my-1 pl-1">
      {items.map((item, i) => (
        <li key={i} className="flex items-start gap-2.5 text-sm leading-relaxed text-slate-200">
          <span className="mt-[5px] w-1.5 h-1.5 rounded-full bg-neutral-500 flex-shrink-0" />
          <span>{renderInline(item)}</span>
        </li>
      ))}
    </ul>
  );
}

function NumberedList({ items }: { items: string[] }) {
  return (
    <ol className="flex flex-col gap-1.5 my-1 pl-1">
      {items.map((item, i) => (
        <li key={i} className="flex items-start gap-2.5 text-sm leading-relaxed text-slate-200">
          <span className="mt-0 min-w-[18px] text-right text-[11px] font-mono text-neutral-500 flex-shrink-0 pt-[2px]">
            {i + 1}.
          </span>
          <span>{renderInline(item)}</span>
        </li>
      ))}
    </ol>
  );
}

function Heading({ level, content }: { level: 1 | 2 | 3; content: string }) {
  if (level === 1)
    return (
      <h2 className="text-base font-bold text-white mt-2 mb-0.5 leading-snug">
        {renderInline(content)}
      </h2>
    );
  if (level === 2)
    return (
      <h3 className="text-sm font-semibold text-neutral-200 mt-1.5 mb-0.5 leading-snug">
        {renderInline(content)}
      </h3>
    );
  return (
    <h4 className="text-sm font-medium text-neutral-300 mt-1 mb-0.5 leading-snug">
      {renderInline(content)}
    </h4>
  );
}

function Paragraph({ content }: { content: string }) {
  // Detect "Label: value" lines (e.g. "Definition: A list is...")
  // and render the label in a slightly highlighted way.
  const labelMatch = content.match(/^([A-Za-z ]{2,30}):\s+([\s\S]+)$/);
  if (labelMatch) {
    const [, label, rest] = labelMatch;
    // Only treat it as a labelled line if label is short and title-case-ish
    const isLabel = label.length <= 25 && /^[A-Z]/.test(label);
    if (isLabel) {
      return (
        <p className="text-sm leading-relaxed text-slate-200">
          <span className="font-semibold text-neutral-300">{label}:</span>{' '}
          {renderInline(rest)}
        </p>
      );
    }
  }

  return (
    <p className="text-sm leading-relaxed text-slate-200">
      {renderInline(content)}
    </p>
  );
}

// ─── Main Component ───────────────────────────────────────────────────────────

export function FormattedMessage({ content }: FormattedMessageProps) {
  const blocks = parseBlocks(content);

  return (
    <div className="flex flex-col gap-2.5 w-full">
      {blocks.map((block, i) => {
        switch (block.type) {
          case 'code':
            return <CodeBlock key={i} lang={block.lang} content={block.content} />;
          case 'heading':
            return <Heading key={i} level={block.level} content={block.content} />;
          case 'bullet':
            return <BulletList key={i} items={block.items} />;
          case 'numbered':
            return <NumberedList key={i} items={block.items} />;
          case 'divider':
            return <hr key={i} className="border-neutral-700/60 my-1" />;
          case 'paragraph':
          default:
            return <Paragraph key={i} content={block.content} />;
        }
      })}
    </div>
  );
}
