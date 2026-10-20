export const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
export const RPC_DEADLINE_MS = 20_000;
export const MAX_RENDER_EDGE_PX = 3072;
export const DEFAULT_RENDER_WIDTH_PX = 1600;
export const THUMBNAIL_MIN_WIDTH_PX = 48;
export const THUMBNAIL_MAX_WIDTH_PX = 320;
export const XLSX_MAX_ROWS = 200;
export const XLSX_MAX_COLUMNS = 50;
export const XLSX_MAX_CELL_CHARS = 2000;
export const PDF_MAX_TEXT_CHARS = 100_000;
export const DOCX_MAX_BLOCKS = 100;
export const MEDIA_MAX_CHUNK_BYTES = 4 * 1024 * 1024;
export const ANIMATION_MAX_BYTES = 16 * 1024 * 1024;
export const RECENT_MAX_ENTRIES = 50;
export const RECENT_MAX_LIMIT = 1_000;
export const RECENT_MAX_SCANNED_ENTRIES = 50_000;
export const RECENT_MAX_FOLDER_ENTRIES = 5_000;
export const RECENT_MAX_DEPTH = 16;
export const PINS_MAX_PER_FILE = 30;
export const OPENED_REVISIONS_MAX_PATHS = 50;
export const PIN_LABEL_MAX_CHARS = 60;
export const REVIEW_MAX_NOTES = 50;
export const REVIEW_MAX_NOTE_CHARS = 2000;
export const REVIEW_MAX_IMAGES = 5;
export const REVIEW_IMAGE_MAX_EDGE_PX = 2000;
export const REVIEW_IMAGE_MAX_BASE64_CHARS = 3_000_000;
// JSON Lines and Parquet: columns come from the first DATA_SAMPLE_ROWS records of a JSON Lines file,
// nested objects are split into key paths up to DATA_MAX_DEPTH keys deep, and at most DATA_MAX_COLUMNS are listed.
export const DATA_SAMPLE_ROWS = 1000;
export const DATA_MAX_DEPTH = 3;
export const DATA_MAX_COLUMNS = 500;
// The inspector's full cell value (doc.cell) is cut at this many characters.
export const CELL_FULL_MAX_CHARS = 256 * 1024;
