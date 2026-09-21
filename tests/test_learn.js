// The detection probe is built as Lua and handed to `hyprctl eval`, and one
// of the values in it is not ours: the keyboard device name comes from
// Hyprland, whose internal-name conversion does not strip quotes or
// backslashes. Pasted into `list = { "..." }` a crafted name would close the
// string and have the rest of itself evaluated as Lua by the compositor.
//
// So the payload is generated through a real encoder, and these tests hold it
// to that: a hostile name has to survive as data, come back byte for byte,
// and never add a statement to the program.

const assert = require("assert")
const fs = require("fs")
const os = require("os")
const path = require("path")
const { execFileSync } = require("child_process")

const script = path.join(__dirname, "..", "scripts", "mousemap")

function payload(device) {
  // stderr is piped so the refusal cases below do not print through.
  return execFileSync(script, ["learn", "payload", device],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] })
}

// Each of these tries a different way out of the string.
const hostile = [
  'evil", list = {"x"} }) os.execute("touch /tmp/pwned") --',
  'quote"inside',
  "back\\slash",
  'both\\"together',
  "trailing\\",
  "]]..os.execute(\"id\")..[[",
  "backslash\\nnot-a-newline",
  "a".repeat(128)
]

const tmp = path.join(os.tmpdir(), "mousemap-learn-check.lua")

for (const device of hostile) {
  const lua = payload(device)

  // It has to stay a syntactically valid program, or the compositor would
  // reject the whole probe.
  fs.writeFileSync(tmp, lua)
  execFileSync("luac", ["-p", tmp])

  // And the name has to survive as a string, exactly as it went in. Reading
  // it back through a real Lua interpreter is the check that matters: it
  // proves those bytes are data, not program.
  // A Lua string literal: quoted, with backslash escapes inside.
  const marker = lua.match(/list = \{ ("(?:[^"\\]|\\.)*") \} \}/)
  assert.ok(marker, `no device list found for ${JSON.stringify(device)}`)
  const back = execFileSync("lua", ["-e", `io.write(${marker[1]})`], { encoding: "utf8" })
  assert.strictEqual(back, device,
    `device name did not round-trip: ${JSON.stringify(device)}`)

  // Nothing the name carried may have become a call of its own. The name is
  // echoed back inside a string literal, so the check has to look at the
  // code around the literals rather than at the whole text.
  const code = lua.replace(/"(?:[^"\\]|\\.)*"/g, '""')
  assert.ok(!/os\.execute|io\.popen|dofile|loadstring|load\s*\(|require/.test(code),
    `payload gained a call from ${JSON.stringify(device)}`)
  assert.ok(!code.includes("--"),
    `payload gained a comment from ${JSON.stringify(device)}`)
}
fs.rmSync(tmp, { force: true })

// Control characters and oversized names are refused outright rather than
// encoded, because nothing legitimate produces them.
const refused = ["with" + String.fromCharCode(0) + "null", "bell" + String.fromCharCode(7) + "here", "del" + String.fromCharCode(127), "x".repeat(129), "newline" + String.fromCharCode(10) + "literal"]
for (const bad of refused) {
  assert.throws(() => payload(bad), `expected refusal for ${JSON.stringify(bad)}`)
}

// The ordinary case still produces the probes it is supposed to.
{
  const lua = payload("logitech-g-pro-")
  assert.ok(/hl\.bind\("mouse:274"/.test(lua), "mouse probes missing")
  assert.ok(/hl\.bind\("code:9"/.test(lua), "keyboard probes missing")
  assert.ok(lua.includes('list = { "logitech-g-pro-" }'), "device scope missing")

  // With no keyboard name there are no key binds at all: an unscoped one
  // would swallow that key on the real keyboard.
  const mouseOnly = payload("")
  assert.ok(/hl\.bind\("mouse:274"/.test(mouseOnly), "mouse probes missing")
  assert.ok(!/code:/.test(mouseOnly), "key probes must not be armed unscoped")
}

console.log("learn probe: all assertions passed")
