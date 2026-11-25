import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { minify } from "terser";

const root = new URL("../", import.meta.url);
const output = new URL("installers/", root);
const args = process.argv.slice(2);
if (args.length && !(args.length === 1 && args[0] === "--check")) {
  throw new Error("Usage: node scripts/build.mjs [--check]");
}
const check = args.includes("--check");
const tools = JSON.parse(await readFile(new URL("tools.json", root), "utf8"));
const template = await readFile(new URL("scripts/installer.html", root), "utf8");

function html(text) {
  return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");
}

function bookmarkURL(code) {
  // These five punctuation marks can stay literal in an opaque javascript: URL.
  // Keep percent signs, fragment/query delimiters, ampersands and whitespace encoded.
  const encoded = encodeURIComponent(code).replace(/%(?:3A|2F|3B|3D|2C)/g, decodeURIComponent);
  return "javascript:" + encoded;
}

async function render(tool) {
  const source = await readFile(new URL("src/" + tool.id + ".js", root), "utf8");
  const { code } = await minify("void function () {\n" + source + "\n}();", {
    ecma: 2020,
    compress: false,
    mangle: true,
    format: { ascii_only: true, comments: false },
  });
  if (!code) throw new Error("No bookmarklet code generated for " + tool.name);
  const url = bookmarkURL(code);
  // Keep links within the default Firefox Places limit, including the scheme.
  if (url.length > 65536) throw new Error(tool.name + ": bookmark URL has " + url.length + " characters");
  const replacements = {
    ID: html(tool.id),
    NAME: html(tool.name),
    SITE: tool.host === "music.youtube.com" ? "YouTube Music" : "YouTube",
    HOST: html(tool.host),
    VERSION: html(tool.version),
    LABEL: html(tool.label),
    SUMMARY: html(tool.summary),
    NOTES: tool.notes.map(note => "    <li>" + html(note) + "</li>").join("\n"),
    SOURCE: html(source),
    BOOKMARK_URL: html(url),
  };
  return template.replace(/\{\{([A-Z_]+)\}\}/g, (_, name) => {
    if (!Object.hasOwn(replacements, name)) throw new Error("Unknown installer field " + name);
    return replacements[name];
  });
}

const expected = new Set(tools.map(tool => tool.installer));
if (expected.size !== tools.length) throw new Error("Duplicate installer filename in tools.json");
if (!check) await mkdir(output, { recursive: true });
for (const tool of tools) {
  const destination = new URL(tool.installer, output);
  const content = await render(tool);
  if (check) {
    if (await readFile(destination, "utf8") !== content) {
      throw new Error("Stale installer: " + tool.installer + ". Run npm run build.");
    }
  } else {
    await writeFile(destination, content, "utf8");
  }
}
for (const file of await readdir(output)) {
  if (file.endsWith(".html") && !expected.has(file)) {
    throw new Error("Unexpected installer: " + file);
  }
}
console.log((check ? "Verified " : "Built ") + tools.length + " installers in " + fileURLToPath(output));
