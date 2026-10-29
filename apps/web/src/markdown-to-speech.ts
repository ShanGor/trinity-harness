import type { Nodes } from 'mdast';
import remarkGfm from 'remark-gfm';
import remarkParse from 'remark-parse';
import { unified } from 'unified';

const markdownProcessor = unified().use(remarkParse).use(remarkGfm);

function renderChildren(node: Extract<Nodes, { children: unknown[] }>, separator = ''): string {
  return node.children.map((child) => renderNode(child)).join(separator);
}

function isUrlOrEmailLabel(label: string): boolean {
  return /^(?:https?:\/\/\S+|www\.\S+|[^\s@]+@[^\s@]+\.[^\s@]+)$/iu.test(label);
}

/**
 * Projects Markdown structure to speech without deleting ordinary text by
 * keyword or punctuation. Rich display content and structured citations are
 * separate inputs; callers only pass the assistant's Markdown body here.
 */
function renderNode(node: Nodes): string {
  switch (node.type) {
    case 'root':
    case 'blockquote':
    case 'list':
    case 'listItem':
      return renderChildren(node, '\n');
    case 'paragraph':
    case 'heading':
    case 'emphasis':
    case 'strong':
    case 'delete':
    case 'linkReference':
      return renderChildren(node);
    case 'link': {
      const label = renderChildren(node);
      // Autolinks have their target as their label. Speaking every URL
      // character adds noise, while a prose label remains useful.
      return isUrlOrEmailLabel(label.trim()) ? '' : label;
    }
    case 'table':
      return renderChildren(node, '\n');
    case 'tableRow':
      return renderChildren(node, ' ');
    case 'tableCell':
      return renderChildren(node);
    case 'text':
    case 'inlineCode':
      return node.value;
    case 'break':
      return '\n';
    case 'code':
    case 'definition':
    case 'footnoteDefinition':
    case 'footnoteReference':
    case 'html':
    case 'image':
    case 'imageReference':
    case 'thematicBreak':
    case 'yaml':
      return '';
    default:
      return '';
  }
}

/**
 * Returns derived speech text only; the committed/displayed Markdown is never
 * modified. In particular, plain prose such as "Ground Truth Reference" and
 * punctuation in C++, C#, snake_case or a*b is retained.
 */
export function markdownToSpeechText(markdown: string): string {
  const tree = markdownProcessor.parse(markdown);
  return renderNode(tree).replace(/\s+/gu, ' ').trim();
}
