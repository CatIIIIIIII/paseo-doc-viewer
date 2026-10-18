import { posix } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { XLSX_MAX_CELL_CHARS } from "../shared/limits";
import { ERROR_MESSAGES } from "../shared/errors";
import { decodeEntities } from "./html";
import { readText, streamEntry, type ZipIndex } from "./zip";

export type StreamedBlock =
  | { type: "heading"; level: number; text: string }
  | { type: "paragraph"; text: string }
  | { type: "list"; ordered: boolean; items: string[] }
  | { type: "table"; rows: string[][] }
  | { type: "source-image"; alt: string; id: number };

export interface DocxLayout {
  part: string;
  styleNames: Map<string, string>;
  levels: Map<string, Map<string, boolean>>;
  styleLevels: Map<string, { level: string; ordered: boolean }>;
  imageRels: Map<string, number>;
  imageParts: string[];
}

interface Paragraph {
  styleId: string;
  numId?: string;
  ilvl?: string;
  deleted: boolean;
  text: string;
  images: StreamedBlock[];
  extras: (Paragraph | StreamedBlock)[];
}

interface Cell {
  span: number;
  merged: boolean;
  parts: { paragraph: boolean; text: string }[];
  chars: number;
}

interface Table {
  rows: string[][];
  row: string[] | null;
  rowDeleted: boolean;
  column: number;
  seen: Set<number>;
  cell: Cell | null;
  bytes: number;
}

// A start tag and its quoted values stop at the next "<" (never valid inside a tag), so a run of
// unclosed tags costs linear time instead of a rescan to the end of the chunk per tag.
const TOKEN = /<(\/?)([A-Za-z_][\w.:-]*)((?:[^<>"']|"[^"<]*"|'[^'<]*')*?)(\/?)>|<[!?][^<>]*>|[^<]+/g;
const CONTAINERS = new Set([
  "w:document", "w:body", "w:p", "w:r", "w:t", "w:hyperlink", "w:ins", "w:smartTag", "w:customXml", "w:sdt", "w:sdtContent",
  "w:moveTo", "w:object", "w:drawing", "w:pict", "v:roundrect", "v:shape", "v:textbox", "w:txbxContent", "v:group", "v:rect",
  "wp:inline", "wp:anchor", "a:graphic", "a:graphicData", "pic:pic", "pic:blipFill", "mc:AlternateContent", "mc:Fallback",
  "w:tbl", "w:tr", "w:tc", "w:pPr", "w:rPr", "w:numPr", "w:tcPr", "w:trPr",
]);
const PROPERTIES = new Set(["w:pPr", "w:tcPr", "w:trPr"]);
const MAX_LIST_LEVEL = 5;
const MAX_ALT_CHARS = 1000;
const MAX_PENDING_CHARS = 64 * 1024;

const ATTRIBUTES = new Map<string, RegExp>();
function attribute(source: string, name: string): string | undefined {
  let pattern = ATTRIBUTES.get(name);
  if (!pattern) ATTRIBUTES.set(name, (pattern = new RegExp(`(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`)));
  const match = pattern.exec(source);
  return match ? decodeEntities(match[1] ?? match[2]) : undefined;
}

// Index of the ">" ending a start tag whose attributes begin at `from`, or -1 when a "<" or the end
// comes first. Quoted values may hold ">" but never "<".
function startTagEnd(xml: string, from: number): number {
  let quote = "";
  for (let at = from; at < xml.length; at++) {
    const char = xml[at];
    if (char === "<") return -1;
    if (quote) {
      if (char === quote) quote = "";
    } else if (char === '"' || char === "'") quote = char;
    else if (char === ">") return at;
  }
  return -1;
}

// Each `name` element: its attributes and its body up to the first closing tag. indexOf keeps this
// linear; a lazy regex rescanned to the end of the part once per unclosed element.
function* elements(xml: string, name: string): Generator<{ attributes: string; body: string }> {
  const open = `<${name}`;
  const close = `</${name}>`;
  let closes = true;
  let from = 0;
  for (let start = xml.indexOf(open); start >= 0; start = xml.indexOf(open, from)) {
    from = start + open.length;
    if (/\w/.test(xml[from] ?? "")) continue;
    const gt = startTagEnd(xml, from);
    if (gt < 0) continue;
    if (xml[gt - 1] === "/") {
      yield { attributes: xml.slice(from, gt - 1), body: "" };
      from = gt + 1;
      continue;
    }
    // Once one element has no closing tag, no later one can have it either.
    const end = closes ? xml.indexOf(close, gt + 1) : -1;
    if (end < 0) {
      closes = false;
      continue;
    }
    yield { attributes: xml.slice(from, gt), body: xml.slice(gt + 1, end) };
    from = end + close.length;
  }
}

const first = (xml: string, name: string, key = "w:val") => {
  for (const element of elements(xml, name)) return attribute(element.attributes, key);
  return undefined;
};

const OFFICE_DOCUMENT = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument";

interface Relationship {
  id: string;
  type: string;
  // The Target attribute as written, and resolved against the source part's folder.
  raw: string;
  target: string;
  external: boolean;
}

export async function relationshipList(index: ZipIndex, part: string): Promise<Relationship[]> {
  const xml = (await readText(index, posix.join(posix.dirname(part), "_rels", `${posix.basename(part)}.rels`), "docx")) ?? "";
  const found: Relationship[] = [];
  for (const { attributes } of elements(xml, "Relationship")) {
    const id = attribute(attributes, "Id");
    const raw = attribute(attributes, "Target");
    if (!id || !raw) continue;
    const target = raw.startsWith("/") ? raw.slice(1) : posix.normalize(posix.join(posix.dirname(part), raw));
    found.push({ id, type: attribute(attributes, "Type") ?? "", raw, target, external: attribute(attributes, "TargetMode") === "External" });
  }
  return found;
}

export async function relationships(index: ZipIndex, part: string): Promise<Map<string, { type: string; target: string }>> {
  const found = new Map<string, { type: string; target: string }>();
  for (const { id, type, target, external } of await relationshipList(index, part)) if (!external) found.set(id, { type, target });
  return found;
}

// The part mammoth converts (docx-reader.js findPartPath): the first officeDocument target that
// exists, joined without normalizing, whatever its TargetMode, else word/document.xml.
export async function mainDocumentPart(index: ZipIndex): Promise<string> {
  for (const { type, raw } of await relationshipList(index, "")) {
    const name = raw.startsWith("/") ? raw.slice(1) : raw;
    if (type === OFFICE_DOCUMENT && index.entries.has(name)) return name;
  }
  return "word/document.xml";
}

export async function readDocxLayout(index: ZipIndex): Promise<DocxLayout> {
  const part = await mainDocumentPart(index);
  if (!index.entries.has(part)) throw new Error(ERROR_MESSAGES.invalidOffice("docx"));
  const rels = await relationships(index, part);
  const partOf = (suffix: string) => [...rels.values()].find((rel) => rel.type.endsWith(suffix))?.target;

  const styleNames = new Map<string, string>();
  const stylesPart = partOf("/styles");
  const styles = (stylesPart && (await readText(index, stylesPart, "docx"))) || "";
  for (const style of elements(styles, "w:style")) {
    const id = attribute(style.attributes, "w:styleId");
    const name = first(style.body, "w:name");
    if (id && name !== undefined && attribute(style.attributes, "w:type") === "paragraph") styleNames.set(id, name);
  }

  const abstracts = new Map<string, Map<string, boolean>>();
  const styleLevels = new Map<string, { level: string; ordered: boolean }>();
  const numberingPart = partOf("/numbering");
  const numbering = (numberingPart && (await readText(index, numberingPart, "docx"))) || "";
  for (const abstract of elements(numbering, "w:abstractNum")) {
    const levels = new Map<string, boolean>();
    let unindexed: boolean | undefined;
    for (const lvl of elements(abstract.body, "w:lvl")) {
      const level = attribute(lvl.attributes, "w:ilvl");
      const ordered = first(lvl.body, "w:numFmt") !== "bullet";
      const style = first(lvl.body, "w:pStyle");
      if (level === undefined) unindexed ??= ordered;
      else levels.set(level, ordered);
      if (style !== undefined) styleLevels.set(style, { level: level ?? "0", ordered });
    }
    if (unindexed !== undefined && !levels.has("0")) levels.set("0", unindexed);
    const id = attribute(abstract.attributes, "w:abstractNumId");
    if (id !== undefined) abstracts.set(id, levels);
  }
  const levels = new Map<string, Map<string, boolean>>();
  for (const num of elements(numbering, "w:num")) {
    const id = attribute(num.attributes, "w:numId");
    const abstract = abstracts.get(first(num.body, "w:abstractNumId") ?? "");
    if (id !== undefined && abstract) levels.set(id, abstract);
  }

  const imageRels = new Map<string, number>();
  const imageParts: string[] = [];
  for (const [id, rel] of rels) {
    if (!index.entries.has(rel.target)) continue;
    let image = imageParts.indexOf(rel.target);
    if (image < 0) image = imageParts.push(rel.target) - 1;
    imageRels.set(id, image);
  }
  return { part, styleNames, levels, styleLevels, imageRels, imageParts };
}

function headingLevel(layout: DocxLayout, styleId: string): number | null {
  const name = layout.styleNames.get(styleId) ?? "";
  const byId = /^Heading([1-6])$/.exec(styleId);
  if (byId) return Number(byId[1]);
  const byName = /^heading ([1-6])$/i.exec(name);
  if (byName) return Number(byName[1]);
  return styleId === "Heading" || name.toUpperCase() === "HEADING" ? 1 : null;
}

function listLevel(layout: DocxLayout, paragraph: Paragraph): { level: number; ordered: boolean } | null {
  let found: { level: string; ordered: boolean } | null = null;
  if (paragraph.numId !== undefined) {
    const level = paragraph.ilvl ?? "0";
    const ordered = layout.levels.get(paragraph.numId)?.get(level);
    found = ordered === undefined ? null : { level, ordered };
  } else {
    found = layout.styleLevels.get(paragraph.styleId) ?? null;
  }
  const level = found ? Number(found.level) : NaN;
  return found && level >= 0 && level < MAX_LIST_LEVEL ? { level, ordered: found.ordered } : null;
}

export async function* streamDocxBlocks(index: ZipIndex, layout: DocxLayout, blockBudget: number): AsyncGenerator<StreamedBlock> {
  const out: StreamedBlock[] = [];
  const paragraphs: Paragraph[] = [];
  const tables: Table[] = [];
  let list: { ordered: boolean; items: string[]; bytes: number } | null = null;
  let carried: Paragraph | null = null;
  let skip = 0;
  let props: string | null = null;
  let inText = false;
  let pict = 0;
  let alt = "";

  const textCap = blockBudget;
  const append = (paragraph: Paragraph, text: string) => {
    if (paragraph.text.length < textCap) paragraph.text += text;
  };
  const closeList = () => {
    if (list?.items.length) out.push({ type: "list", ordered: list.ordered, items: list.items });
    list = null;
  };
  const image = (relId: string | undefined, target: Paragraph | undefined) => {
    const id = relId === undefined ? undefined : layout.imageRels.get(relId);
    if (id === undefined || !target) return;
    const block: StreamedBlock = { type: "source-image", alt: alt.slice(0, MAX_ALT_CHARS), id };
    if (pict > 0) target.extras.push(block);
    else target.images.push(block);
  };

  const emitBody = (paragraph: Paragraph) => {
    const heading = paragraph.styleId ? headingLevel(layout, paragraph.styleId) : null;
    const numbered = heading === null ? listLevel(layout, paragraph) : null;
    if (numbered) {
      if (!list || (numbered.level === 0 && numbered.ordered !== list.ordered)) {
        closeList();
        list = { ordered: numbered.level === 0 ? numbered.ordered : false, items: [], bytes: 0 };
      }
      const text = paragraph.text.trim();
      if (text && list.bytes <= blockBudget) {
        const item = "  ".repeat(numbered.level) + text;
        list.items.push(item);
        list.bytes += item.length;
      }
      return;
    }
    closeList();
    if (paragraph.text.trim()) {
      out.push(heading === null ? { type: "paragraph", text: paragraph.text } : { type: "heading", level: heading, text: paragraph.text });
    }
    out.push(...paragraph.images);
  };

  const emitCell = (cell: Cell, paragraph: Paragraph) => {
    const plain = (paragraph.styleId ? headingLevel(layout, paragraph.styleId) : null) === null && !listLevel(layout, paragraph);
    if (cell.chars > XLSX_MAX_CELL_CHARS) return;
    cell.parts.push({ paragraph: plain, text: paragraph.text });
    cell.chars += paragraph.text.length + 1;
  };

  const emit = (paragraph: Paragraph) => {
    if (paragraph.text === "" && paragraph.images.length === 0 && paragraph.extras.length === 0) return;
    const cell = tables[0]?.cell;
    if (tables.length > 0 && !cell) return;
    if (paragraph.text !== "" || paragraph.images.length > 0) {
      if (cell) emitCell(cell, paragraph);
      else emitBody(paragraph);
    }
    for (const extra of paragraph.extras) {
      if ("extras" in extra) emit(extra);
      else if (!cell) {
        closeList();
        out.push(extra);
      }
    }
  };

  const open = (name: string, attributes: string, selfClosing: boolean) => {
    const paragraph = paragraphs.at(-1);
    switch (name) {
      case "w:p":
        if (selfClosing) return;
        paragraphs.push({ styleId: "", deleted: false, text: "", images: [], extras: [] });
        if (carried && paragraphs.length === 1) {
          Object.assign(paragraphs[0], { text: carried.text, images: carried.images, extras: carried.extras });
          carried = null;
        }
        return;
      case "w:pPr":
      case "w:tcPr":
      case "w:trPr":
        if (!selfClosing) props = name;
        return;
      case "w:t":
        inText = !selfClosing;
        return;
      case "w:tab":
        if (paragraph) append(paragraph, "\t");
        return;
      case "w:br": {
        const type = attribute(attributes, "w:type");
        if (paragraph && (type === undefined || type === "textWrapping")) append(paragraph, "\n");
        return;
      }
      case "w:noBreakHyphen":
        if (paragraph) append(paragraph, "‑");
        return;
      case "w:softHyphen":
        if (paragraph) append(paragraph, "­");
        return;
      case "w:pStyle":
        if (paragraph && props === "w:pPr") paragraph.styleId = attribute(attributes, "w:val") ?? "";
        return;
      case "w:ilvl":
        if (paragraph && props === "w:pPr") paragraph.ilvl = attribute(attributes, "w:val");
        return;
      case "w:numId":
        if (paragraph && props === "w:pPr") paragraph.numId = attribute(attributes, "w:val");
        return;
      case "wp:docPr": {
        const description = attribute(attributes, "descr");
        alt = description === undefined || /^\s*$/.test(description) ? (attribute(attributes, "title") ?? "") : description;
        return;
      }
      case "a:blip":
        image(attribute(attributes, "r:embed"), paragraph);
        return;
      case "v:imagedata":
        alt = attribute(attributes, "o:title") ?? "";
        image(attribute(attributes, "r:id"), paragraph);
        return;
      case "w:pict":
        if (!selfClosing) pict++;
        return;
      case "w:tbl":
        if (!selfClosing) {
          if (tables.length === 0 && !paragraph) closeList();
          tables.push({ rows: [], row: null, rowDeleted: false, column: 0, seen: new Set(), cell: null, bytes: 0 });
        }
        return;
      case "w:tr":
        if (tables.length === 1 && !selfClosing) Object.assign(tables[0], { row: [], rowDeleted: false, column: 0 });
        return;
      case "w:tc":
        if (tables.length === 1 && tables[0].row && !selfClosing) tables[0].cell = { span: 1, merged: false, parts: [], chars: 0 };
        else if (tables.length === 1 && tables[0].row) tables[0].row.push("");
        return;
      case "w:gridSpan":
        if (props === "w:tcPr" && tables.length === 1 && tables[0].cell) tables[0].cell.span = Number.parseInt(attribute(attributes, "w:val") ?? "1", 10) || 1;
        return;
      case "w:vMerge": {
        const value = attribute(attributes, "w:val");
        if (props === "w:tcPr" && tables.length === 1 && tables[0].cell) tables[0].cell.merged = value === undefined || value === "continue";
        return;
      }
      case "w:del":
        if (props === "w:pPr" && paragraph) paragraph.deleted = true;
        else if (props === "w:trPr" && tables.length === 1) tables[0].rowDeleted = true;
        return;
    }
  };

  const close = (name: string) => {
    if (PROPERTIES.has(name)) props = null;
    switch (name) {
      case "w:t":
        inText = false;
        return;
      case "w:pict":
        pict--;
        return;
      case "w:p": {
        const paragraph = paragraphs.pop();
        if (!paragraph) return;
        const outer = paragraphs.at(-1);
        if (outer) outer.extras.push(paragraph);
        else if (paragraph.deleted) carried = paragraph;
        else emit(paragraph);
        return;
      }
      case "w:tc": {
        const table = tables[0];
        if (tables.length !== 1 || !table.row || !table.cell) return;
        const cell = table.cell;
        table.cell = null;
        if (!(cell.merged && table.seen.has(table.column))) {
          table.seen.add(table.column);
          const paragraphParts = cell.parts.filter((part) => part.paragraph);
          const text = paragraphParts.length ? paragraphParts.map((part) => part.text).join("\n") : cell.parts.map((part) => part.text).join("");
          table.row.push(text.slice(0, XLSX_MAX_CELL_CHARS));
        }
        table.column += cell.span;
        return;
      }
      case "w:tr": {
        const table = tables[0];
        if (tables.length !== 1 || !table.row) return;
        if (!table.rowDeleted && table.bytes <= blockBudget) {
          table.rows.push(table.row);
          table.bytes += table.row.reduce((total, text) => total + text.length + 3, 2);
        }
        table.row = null;
        return;
      }
      case "w:tbl": {
        const table = tables.pop();
        if (table && tables.length === 0 && table.rows.length) out.push({ type: "table", rows: table.rows });
        return;
      }
    }
  };

  const feed = (xml: string) => {
    TOKEN.lastIndex = 0;
    for (let match = TOKEN.exec(xml); match; match = TOKEN.exec(xml)) {
      const [token, closing, name, attributes, selfClosing] = match;
      if (name === undefined) {
        if (skip === 0 && inText && !token.startsWith("<")) {
          const paragraph = paragraphs.at(-1);
          if (paragraph) append(paragraph, decodeEntities(token));
        }
        continue;
      }
      if (closing) {
        if (skip > 0) skip--;
        else close(name);
        continue;
      }
      if (skip > 0) {
        if (!selfClosing) skip++;
        continue;
      }
      open(name, attributes, selfClosing === "/");
      if (!selfClosing && !CONTAINERS.has(name)) skip = 1;
    }
  };

  const decoder = new StringDecoder("utf8");
  let pending = "";
  for await (const chunk of streamEntry(index, layout.part, "docx")) {
    pending += decoder.write(chunk);
    const tag = pending.lastIndexOf("<");
    let cut = tag >= 0 && !pending.includes(">", tag) ? tag : pending.length;
    const entity = pending.lastIndexOf("&", cut - 1);
    if (entity > pending.lastIndexOf(">", cut - 1) && !pending.slice(entity, cut).includes(";")) cut = entity;
    if (pending.length - cut > MAX_PENDING_CHARS) throw new Error(ERROR_MESSAGES.invalidOffice("docx"));
    if (cut > 0) {
      feed(pending.slice(0, cut));
      pending = pending.slice(cut);
    }
    yield* out.splice(0);
  }
  feed(pending + decoder.end());
  closeList();
  yield* out.splice(0);
}
