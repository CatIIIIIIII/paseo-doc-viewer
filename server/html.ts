export interface Element {
  tag: string;
  attributes: Record<string, string>;
  children: Node[];
}
export type Node = Element | string;

const VOID_TAGS = new Set(["img", "br", "hr"]);
const TOKEN = /<!--[\s\S]*?-->|<(\/?)([a-zA-Z][a-zA-Z0-9]*)((?:[^>"']|"[^"]*"|'[^']*')*?)(\/?)>|[^<]+|</g;
const ATTRIBUTE = /([^\s=/]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;
const ENTITY = /&(#x[0-9a-f]+|#[0-9]+|amp|lt|gt|quot|apos|nbsp);/gi;
const NAMED: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

function codePoint(value: number): string {
  const valid = value > 0 && value <= 0x10ffff && !(value >= 0xd800 && value <= 0xdfff);
  return valid ? String.fromCodePoint(value) : "\uFFFD";
}

export function decodeEntities(text: string): string {
  return text.replace(ENTITY, (_, entity: string) => {
    const lower = entity.toLowerCase();
    if (lower.startsWith("#x")) return codePoint(Number.parseInt(lower.slice(2), 16));
    if (lower.startsWith("#")) return codePoint(Number.parseInt(lower.slice(1), 10));
    return NAMED[lower];
  });
}

function attributesOf(source: string): Record<string, string> {
  const attributes: Record<string, string> = {};
  for (const match of source.matchAll(ATTRIBUTE)) {
    attributes[match[1].toLowerCase()] = decodeEntities(match[2] ?? match[3] ?? match[4] ?? "");
  }
  return attributes;
}

export function parseHtml(html: string): Element {
  const root: Element = { tag: "#root", attributes: {}, children: [] };
  const stack: Element[] = [root];
  for (const match of html.matchAll(TOKEN)) {
    const [token, closing, rawTag, rawAttributes, selfClosing] = match;
    const parent = stack[stack.length - 1];
    if (rawTag === undefined) {
      if (!token.startsWith("<!--")) parent.children.push(decodeEntities(token));
      continue;
    }
    const tag = rawTag.toLowerCase();
    if (closing) {
      const open = stack.findLastIndex((element) => element.tag === tag);
      if (open > 0) stack.length = open;
      continue;
    }
    const element: Element = { tag, attributes: attributesOf(rawAttributes), children: [] };
    parent.children.push(element);
    if (!selfClosing && !VOID_TAGS.has(tag)) stack.push(element);
  }
  return root;
}

export function textOf(node: Node, skip: (element: Element) => boolean = () => false): string {
  if (typeof node === "string") return node;
  if (node.tag === "br") return "\n";
  if (skip(node)) return "";
  return node.children.map((child) => textOf(child, skip)).join("");
}

export function descendants(node: Element, match: (element: Element) => boolean): Element[] {
  const found: Element[] = [];
  for (const child of node.children) {
    if (typeof child === "string") continue;
    if (match(child)) found.push(child);
    else found.push(...descendants(child, match));
  }
  return found;
}
