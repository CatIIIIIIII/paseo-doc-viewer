// Live check for turn cards on an isolated dev daemon with the devkit's fake agent. Not part of npm test.
//
// Setup (XDG_STATE_HOME keeps the viewer's state and the ppd record out of the user's home; ppd drops
// PASEO_* variables, so PASEO_DOC_VIEWER_STATE_DIR does not reach the daemon):
//   export XDG_STATE_HOME=/tmp/refl-turn-docs-state
//   ppd daemon up --port 7842 --name turn-docs --fake-agent --workspace /tmp/refl-turn-docs-ws
//   ppd install . --name turn-docs
//   /tmp/refl-turn-docs-ws/.fake-agent.json: turn 1 runs a `bash` step with run: true that copies a PDF to
//   out/reports/weekly-report.pdf and writes out/metrics.xlsx with openpyxl; turn 2 only says something;
//   turn 3 rewrites the PDF.
//   ppd paseo -- run --provider fake-agent --workspace <wks> --title "Report builder" "Build the weekly report"
//   ppd paseo -- send <agent> "Summarize the report"; ppd paseo -- send <agent> "Regenerate the PDF"
//
// Usage: node scripts/turn-docs-live.mjs <base-url> <serverId> <agentId> desktop|phone <out-dir>
import { chromium } from "playwright";

const [, , base, serverId, agentId, mode, out] = process.argv;
const compact = mode === "phone";
const viewport = compact ? { width: 390, height: 844 } : { width: 1440, height: 900 };
const browser = await chromium.launch();
const page = await browser.newPage({ viewport, deviceScaleFactor: compact ? 3 : 2, isMobile: compact, hasTouch: compact });
const errors = [];
page.on("console", (message) => message.type() === "error" && errors.push(message.text().slice(0, 300)));
page.on("pageerror", (error) => errors.push(`pageerror: ${error.message}`));

await page.goto(base);
await page.getByLabel("New workspace", { exact: true }).or(page.getByLabel("Open menu", { exact: true })).first().waitFor({ timeout: 60_000 });
await page.goto(`${base}/h/${serverId}/agent/${agentId}`);
const title = page.getByText(/documents? changed while this turn ran/).first();
await title.waitFor({ timeout: 60_000 });
await page.waitForTimeout(1_500);
console.log("cards:", await page.getByText(/changed while this turn ran/).count());

await page.getByText(/2 documents changed while this turn ran/).first().scrollIntoViewIfNeeded();
await page.screenshot({ path: `${out}/${mode}-card-turn1.png` });
await page.getByText(/1 document changed while this turn ran/).last().scrollIntoViewIfNeeded();
await page.screenshot({ path: `${out}/${mode}-card-turn3-changed.png` });

const before = page.url();
await page.getByRole("button", { name: /^Open out\/reports\/weekly-report\.pdf/ }).last().click();
await page.waitForURL(/\/plugin\/paseo-doc-viewer\/surface\/document/, { timeout: 30_000 });
console.log("viewer:", decodeURIComponent(page.url()));
await page.waitForTimeout(4_000);
await page.screenshot({ path: `${out}/${mode}-open-viewer.png` });
await page.goBack();
await title.waitFor({ timeout: 30_000 });
console.log("back to the agent:", page.url() === before);
await page.screenshot({ path: `${out}/${mode}-after-back.png` });
console.log("errors:", JSON.stringify(errors));
await browser.close();
