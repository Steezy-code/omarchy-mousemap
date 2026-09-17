// The manifest is the marketplace's source of truth for what this plugin
// is called, and four other files repeat that name: the shell looks the
// panel up by it, the bar widget names its module with it, the installer
// puts the folder there, and the README tells the user to type it.
//
// A rename that misses one of them installs cleanly and then does nothing,
// explained only by a line on the shell's console — so they are checked
// against the manifest rather than against each other.

const assert = require("assert")
const fs = require("fs")
const path = require("path")

const root = path.join(__dirname, "..")
const read = name => fs.readFileSync(path.join(root, name), "utf8")

const manifest = JSON.parse(read("manifest.json"))

// ---------------------------------------------------------------- schema
//
// The same checks omarchy-plugin-validate makes, so a broken manifest is
// caught by `node tests/…` rather than only at install time.

assert.strictEqual(manifest.schemaVersion, 1, "schemaVersion must be the number 1")
for (const field of ["id", "name", "version", "author", "license", "description", "kinds", "entryPoints"]) {
  assert.ok(manifest[field], `manifest is missing '${field}'`)
}
assert.ok(/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(manifest.id), `invalid plugin id '${manifest.id}'`)
assert.ok(!manifest.id.startsWith("omarchy."), "the omarchy.* namespace is reserved")
assert.ok(!manifest.id.includes(".."), "a plugin id may not contain '..'")
assert.ok(manifest.version.length <= 64, "version is capped at 64 characters")
assert.ok(Array.isArray(manifest.kinds) && manifest.kinds.length > 0, "kinds must be a non-empty array")

// A kind is a promise to supply something to load. Claiming one without its
// entry point installs, enables, and does nothing.
const ENTRY_FOR_KIND = {
  "bar": "bar", "bar-widget": "barWidget", "menu": "menu",
  "overlay": "overlay", "panel": "panel", "service": "service"
}
for (const kind of manifest.kinds) {
  const key = ENTRY_FOR_KIND[kind]
  if (!key) continue
  assert.ok(manifest.entryPoints[key], `kind '${kind}' needs entryPoints.${key}`)
}
for (const [name, target] of Object.entries(manifest.entryPoints)) {
  assert.ok(!target.startsWith("/"), `entry point '${name}' must be relative`)
  assert.ok(!target.includes(".."), `entry point '${name}' may not contain '..'`)
  assert.ok(fs.existsSync(path.join(root, target)), `entry point '${name}' -> ${target} does not exist`)
}

if (manifest.barWidget && manifest.barWidget.defaultSection) {
  assert.ok(["left", "center", "right"].includes(manifest.barWidget.defaultSection),
    "barWidget.defaultSection must be left, center, or right")
}

// ---------------------------------------------------------------- id

const id = manifest.id
for (const [file, pattern] of [
  ["MouseMapPanel.qml", new RegExp(`readonly property string pluginId: "${id}"`)],
  ["BarWidget.qml", new RegExp(`moduleName: "${id}"`)],
  ["BarWidget.qml", new RegExp(`shell toggle ${id.replace(/\./g, "\\.")}"`)],
  ["install", new RegExp(`PLUGIN_ID="${id}"`)],
  ["README.md", new RegExp(id.replace(/\./g, "\\."))]
]) {
  assert.ok(pattern.test(read(file)), `${file} does not carry the manifest id '${id}'`)
}

// Nothing may still be naming the plugin by a previous id.
//
// Matched by the places an id is actually used rather than by its shape:
// this plugin also writes `bindings.lua.mousemap.bak` and reads
// `mousemap.json`, and a sweep loose enough to see a stale id would flag
// both of those every time.
const USES = [
  /omarchy(?:-plugin)?[ -](?:plugin )?(?:enable|disable|remove|update|add)\s+(\S+)/g,
  /shell toggle\s+([^"'\s]+)/g,
  /plugins\/([A-Za-z0-9][A-Za-z0-9._-]*)/g,
  /PLUGIN_ID="([^"]+)"/g,
  /pluginId: "([^"]+)"/g,
  /moduleName: "([^"]+)"/g
]
for (const file of ["MouseMapPanel.qml", "BarWidget.qml", "install", "README.md", "scripts/mousemap"]) {
  const text = read(file)
  for (const pattern of USES) {
    pattern.lastIndex = 0
    let hit
    while ((hit = pattern.exec(text)) !== null) {
      // A git URL is what `plugin add` takes, and a shell variable is the
      // installer already holding the id in one place — neither is a
      // literal that can go stale.
      if (/^https?:\/\//.test(hit[1]) || hit[1].startsWith("$")) continue
      assert.strictEqual(hit[1], id, `${file} names the plugin '${hit[1]}'`)
    }
  }
}

// ---------------------------------------------------------------- shipping
//
// The marketplace clones the repository as the plugin folder, so every file
// the shell loads has to be in it, executable where it needs to be, and
// there can be no symlinks anywhere.

for (const required of ["README.md", "LICENSE", "manifest.json", "preview.png"]) {
  assert.ok(fs.existsSync(path.join(root, required)), `missing required file ${required}`)
}

for (const script of ["scripts/mousemap", "scripts/mousemap-sniff"]) {
  const mode = fs.statSync(path.join(root, script)).mode
  assert.ok(mode & 0o111, `${script} must be executable in the repository`)
}

// The installer copies a list of files; every QML and JS module the shell
// loads has to be on it, or a fresh install is missing a component.
{
  const installer = read("install")
  for (const entry of fs.readdirSync(root)) {
    if (!/\.(qml|js)$/.test(entry)) continue
    assert.ok(new RegExp(`^\\s*${entry.replace(/\./g, "\\.")}\\s*$`, "m").test(installer),
      `${entry} is not in the installer's file list`)
  }
}

// Symlinks are refused by omarchy-plugin-validate, because a copied plugin
// could otherwise point back at arbitrary files once it lands in the
// trusted plugins directory.
{
  const walk = dir => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === ".git" || entry.name === "node_modules") continue
      const full = path.join(dir, entry.name)
      assert.ok(!entry.isSymbolicLink(), `symlinks are not allowed in a plugin folder: ${full}`)
      if (entry.isDirectory()) walk(full)
    }
  }
  walk(root)
}

// The README has to tell someone how to install it and how to get rid of
// it again; the marketplace requires both.
{
  const readme = read("README.md")
  assert.ok(/omarchy plugin add/.test(readme), "README must document installation")
  assert.ok(/omarchy plugin remove|plugin disable/.test(readme), "README must document removal")
  assert.ok(/## Requirements|dependenc/i.test(readme), "README must document dependencies")
}

// ---------------------------------------------------------------- glyphs
//
// Icon glyphs are written as the character itself, never as a \u escape.
//
// An escape takes exactly four hex digits, which is not enough for the
// Material Design range Nerd Fonts put above U+FFFF: a five-digit escape is
// silently read as a four-digit one plus a literal character, so the label
// renders as some unrelated icon with a stray letter after it. Writing the
// character makes the mistake unavailable rather than merely discouraged.
//
// Comments are stripped first, so the note explaining this rule does not
// trip it.
{
  const files = fs.readdirSync(root).filter(f => /\.(qml|js)$/.test(f))
  const pua = /\\u[eEfF][0-9a-fA-F]{3}/

  for (const file of files) {
    const code = read(file)
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .split("\n")
      .map(line => line.replace(/^\s*\/\/.*$/, ""))
      .join("\n")

    const hit = pua.exec(code)
    assert.ok(!hit,
      `${file} writes an icon glyph as ${hit && hit[0]}; write the character itself instead`)
  }
}

console.log("manifest + packaging: all assertions passed")
