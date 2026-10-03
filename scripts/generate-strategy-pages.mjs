// Generates one brief HTML description page per registered option strategy into public/strategies/.
// Run with: npm run strategy-pages
import { build } from "esbuild";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
import os from "node:os";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outDir = path.join(root, "public", "strategies");
const bundle = path.join(os.tmpdir(), `strategy-catalog-${process.pid}.mjs`);

await build({
  entryPoints: [path.join(root, "src", "trading", "options", "strategies", "catalog.ts")],
  bundle: true,
  format: "esm",
  platform: "node",
  outfile: bundle,
  logLevel: "error",
});
const { defaultRegistry } = await import(pathToFileURL(bundle).href);
await rm(bundle, { force: true });

const escapeHtml = (value) => String(value).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const thesisLabel = { bullish: "Bullish", bearish: "Bearish", range_bound: "Range-bound", large_move: "Large move" };
const style = "body{font:16px/1.5 system-ui,sans-serif;max-width:640px;margin:2rem auto;padding:0 1rem;color:#0f172a}h1{margin-bottom:.25rem}.tag{display:inline-block;padding:.1rem .5rem;margin:0 .25rem .25rem 0;border-radius:4px;background:#e2e8f0;font-size:.85rem}a{color:#0369a1}";

const page = (title, body) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title><style>${style}</style></head>
<body>${body}</body></html>
`;

await rm(outDir, { recursive: true, force: true });
await mkdir(outDir, { recursive: true });

const definitions = defaultRegistry.list();
for (const def of definitions) {
  const theses = def.theses.map((t) => `<span class="tag">${escapeHtml(thesisLabel[t] ?? t)}</span>`).join("");
  const aliases = def.aliases.length ? `<p><strong>Also known as:</strong> ${def.aliases.map(escapeHtml).join(", ")}</p>` : "";
  const notes = [def.usesStock ? "Includes a stock leg (100 shares)." : "", def.multiExpiry ? "Uses two different expirations." : ""].filter(Boolean).join(" ");
  await writeFile(path.join(outDir, `${def.id}.html`), page(def.label, `<p><a href="./index.html">&larr; All strategies</a></p>
<h1>${escapeHtml(def.label)}</h1>
<p><span class="tag">${escapeHtml(def.category)}</span>${theses}</p>
<p>${escapeHtml(def.description)}</p>
${aliases}${notes ? `<p>${escapeHtml(notes)}</p>` : ""}
<p><small>Educational research description only; not investment advice.</small></p>`));
}

const items = definitions
  .map((def) => `<li><a href="./${def.id}.html">${escapeHtml(def.label)}</a> &mdash; ${escapeHtml(def.description)}</li>`)
  .join("\n");
await writeFile(path.join(outDir, "index.html"), page("Option strategies", `<h1>Option strategies</h1><ul>\n${items}\n</ul>`));
console.log(`Wrote ${definitions.length} strategy pages to ${path.relative(root, outDir)}`);
