// Live check for turn card folder rows on an isolated dev daemon with the devkit's fake agent. Not part of npm test.
//
// Setup (see turn-docs-live.mjs for the isolation notes):
//   /tmp/<ws>/proj: a Git repo with 65 tracked documents; /tmp/<ws>/other: a Git repo with one.
//   ppd daemon up --port 7851 --name collapse --fake-agent --workspace /tmp/<ws>; ppd install . --name collapse
//   turn 1, a `bash` step with run: true: git -C proj worktree add ../proj-gallery -b gallery, then copy a PDF to
//   out/report.pdf and a workbook to out/metrics.xlsx. Turn 2 copies a PDF to other/findings.pdf.
//
// Usage: node scripts/turn-docs-collapse-live.mjs <base-url> <serverId> <agentId> desktop|phone <out-dir>
import { chromium } from "playwright";

const [, , base, serverId, agentId, mode, out] = process.argv;
const compact = mode === "phone";
const viewport = compact ? { width: 390, height: 844 } : { width: 1440, height: 900 };
const browser = await chromium.launch();
const page = await browser.newPage({ viewport, deviceScaleFactor: compact ? 3 : 2, isMobile: compact, hasTouch: compact });
const errors = [];
page.on("console", (message) => message.type() === "error" && errors.push(message.text().slice(0, 300)));
page.on("pageerror", (error) => errors.push(`pageerror: ${error.message}`));
const check = (label, ok) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${label}`);
  if (!ok) process.exitCode = 1;
};

await page.goto(base);
await page.getByLabel("New workspace", { exact: true }).or(page.getByLabel("Open menu", { exact: true })).first().waitFor({ timeout: 60_000 });
await page.goto(`${base}/h/${serverId}/agent/${agentId}`);
const checkoutTitle = page.getByText("67 documents changed while this turn ran", { exact: true });
await checkoutTitle.waitFor({ timeout: 60_000 });
await page.waitForTimeout(1_500);

const show = page.getByRole("button", { name: "Show proj-gallery, new Git checkout, 65 documents", exact: true });
check("checkout row", await page.getByText("New checkout · 65 documents", { exact: true }).isVisible());
check("report and metrics listed", await page.getByRole("button", { name: /^Open out\/report\.pdf, / }).isVisible()
  && await page.getByRole("button", { name: /^Open out\/metrics\.xlsx, / }).isVisible());
check("no checkout file listed while collapsed", await page.getByRole("button", { name: /^Open proj-gallery\// }).count() === 0);
await checkoutTitle.scrollIntoViewIfNeeded();
await page.screenshot({ path: `${out}/${mode}-checkout-collapsed.png` });

const existing = page.getByRole("button", { name: /^Open other\/findings\.pdf, PDF, new$/ });
check("new PDF in an existing repo listed", await existing.isVisible());
await existing.scrollIntoViewIfNeeded();
await page.screenshot({ path: `${out}/${mode}-existing-repo.png` });

await show.click();
await page.waitForTimeout(2_000);
check("expanded lists 12 checkout files", await page.getByRole("button", { name: /^Open proj-gallery\// }).count() === 12);
check("rest of the checkout in Documents", await page.getByRole("button", { name: "+53 more in Documents", exact: true }).isVisible());
await checkoutTitle.scrollIntoViewIfNeeded();
await page.screenshot({ path: `${out}/${mode}-checkout-expanded.png` });

await page.getByRole("button", { name: /^Open proj-gallery\// }).first().click();
await page.waitForURL(/\/plugin\/paseo-doc-viewer\/surface\/document/, { timeout: 30_000 });
const stepper = await page.getByText(/^Document \d+ of \d+$/).first().textContent({ timeout: 15_000 }).catch(() => null);
console.log("viewer:", decodeURIComponent(page.url()), stepper);
check("stepper covers listed and shown files", stepper === "Document 3 of 14");
await page.waitForTimeout(3_000);
await page.screenshot({ path: `${out}/${mode}-viewer-from-checkout.png` });
console.log("errors:", JSON.stringify(errors));
await browser.close();
