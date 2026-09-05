// What a mouse button can be made to do, and the Lua that does it.
//
// Three kinds of action, because Hyprland needs three different mechanisms:
//
//   chord     Type a shortcut at the focused surface. This is what makes a
//             thumb button page back in a browser: the app already listens
//             for Alt+Left, so we press it for them. Emitted as a
//             send_key_state down/up pair rather than send_shortcut — see
//             emitChord().
//
//   dispatch  Ask the compositor directly (close window, next workspace).
//             No key is typed, so it works regardless of what the focused
//             app binds.
//
//   exec      Run a command.
//
// Everything here compiles to a string that Hyprland will execute as Lua,
// so every value that reaches the output goes through luaString() or an
// allowlist. Nothing interpolates raw.

// ------------------------------------------------------------ escaping

// Lua long-bracket strings can be terminated by the input, and Lua's \ddd
// escapes are decimal, not octal. Escape explicitly rather than quoting.
function luaString(value) {
  var s = String(value === undefined || value === null ? "" : value)
  var out = ""
  for (var i = 0; i < s.length; i++) {
    var ch = s.charAt(i)
    var code = s.charCodeAt(i)
    if (ch === "\\") out += "\\\\"
    else if (ch === '"') out += '\\"'
    else if (ch === "\n") out += "\\n"
    else if (ch === "\r") out += "\\r"
    else if (ch === "\t") out += "\\t"
    else if (code < 0x20 || code === 0x7f) out += "\\" + code
    else out += ch
  }
  return '"' + out + '"'
}

// Modifier and key names are pasted into a Lua table, so they are matched
// against a pattern instead of escaped: a key name is a short token, and
// anything that is not one is a bug or an attack, not a key.
var MOD_NAMES = ["SUPER", "CTRL", "ALT", "SHIFT"]

function normalizeMods(mods) {
  var wanted = {}
  var list = Array.isArray(mods) ? mods : String(mods || "").split(/[\s+]+/)
  for (var i = 0; i < list.length; i++) {
    var name = String(list[i] || "").toUpperCase()
    if (name === "CONTROL") name = "CTRL"
    if (name === "META" || name === "MOD" || name === "WIN") name = "SUPER"
    if (MOD_NAMES.indexOf(name) !== -1) wanted[name] = true
  }
  // Canonical order keeps generated Lua stable across saves.
  var out = []
  for (var m = 0; m < MOD_NAMES.length; m++) if (wanted[MOD_NAMES[m]]) out.push(MOD_NAMES[m])
  return out
}

// xkb keysyms plus Hyprland's "code:NN" form. Deliberately strict.
function validKey(key) {
  return /^(code:\d{1,3}|[A-Za-z0-9_]{1,32})$/.test(String(key || ""))
}

function keyLabel(mods, key) {
  var parts = normalizeMods(mods).slice()
  if (key) parts.push(prettyKey(key))
  return parts.join(" + ")
}

function prettyKey(key) {
  var k = String(key || "")
  var names = {
    left: "←", right: "→", up: "↑", down: "↓",
    Return: "Enter", space: "Space", Escape: "Esc",
    Prior: "PgUp", Next: "PgDn", BackSpace: "Backspace", Delete: "Del"
  }
  if (names[k]) return names[k]
  return k.length === 1 ? k.toUpperCase() : k
}

// ------------------------------------------------------------ key capture

// Qt key codes -> the keysym names Hyprland wants. Only keys that do not
// produce usable text need to be here; everything printable comes back
// through event.text. Values are Qt's own constants, spelled numerically
// so this file stays loadable outside QML.
var QT_KEYSYMS = {
  0x01000000: "Escape",
  0x01000001: "Tab",
  0x01000002: "ISO_Left_Tab",
  0x01000003: "BackSpace",
  0x01000004: "Return",
  0x01000005: "KP_Enter",
  0x01000006: "Insert",
  0x01000007: "Delete",
  0x01000009: "Print",
  0x0100000a: "Sys_Req",
  0x0100000b: "Clear",
  0x01000010: "Home",
  0x01000011: "End",
  0x01000012: "left",
  0x01000013: "up",
  0x01000014: "right",
  0x01000015: "down",
  0x01000016: "Prior",
  0x01000017: "Next",
  0x01000020: "Shift_L",
  0x01000021: "Control_L",
  0x01000022: "Meta_L",
  0x01000023: "Alt_L",
  0x01000024: "Caps_Lock",
  0x01000025: "Num_Lock",
  0x01000026: "Scroll_Lock",
  0x01000053: "Super_L",
  0x01000055: "Menu",
  0x20: "space"
}

// Punctuation that arrives as text but whose keysym name is a word.
var PUNCT_KEYSYMS = {
  " ": "space", "-": "minus", "=": "equal", "[": "bracketleft", "]": "bracketright",
  "\\": "backslash", ";": "semicolon", "'": "apostrophe", ",": "comma", ".": "period",
  "/": "slash", "`": "grave", "+": "plus", "*": "asterisk", "!": "exclam", "@": "at",
  "#": "numbersign", "$": "dollar", "%": "percent", "^": "asciicircum", "&": "ampersand",
  "(": "parenleft", ")": "parenright", "_": "underscore", "{": "braceleft",
  "}": "braceright", "|": "bar", ":": "colon", '"': "quotedbl", "<": "less",
  ">": "greater", "?": "question", "~": "asciitilde"
}

// True for keys that are only ever modifiers, which must not be captured as
// the chord's key — holding Ctrl to type Ctrl+C fires a Control_L press
// first, and recording that would store a shortcut of "Ctrl + Ctrl".
function isModifierKey(qtKey) {
  return (qtKey >= 0x01000020 && qtKey <= 0x01000026) || qtKey === 0x01000053 || qtKey === 0x01000054
}

// F1..F35 occupy a contiguous run from Qt.Key_F1.
function functionKey(qtKey) {
  if (qtKey < 0x01000030 || qtKey > 0x01000052) return ""
  return "F" + (qtKey - 0x01000030 + 1)
}

// Turn a QML key event into a keysym, or "" when the press is not usable
// as the key half of a shortcut.
function keysymFor(qtKey, text) {
  if (isModifierKey(qtKey)) return ""
  var fn = functionKey(qtKey)
  if (fn) return fn
  if (QT_KEYSYMS[qtKey]) return QT_KEYSYMS[qtKey]

  var s = String(text || "")
  if (s.length === 1) {
    if (PUNCT_KEYSYMS[s]) return PUNCT_KEYSYMS[s]
    // Letters go down as lowercase; SHIFT is carried in the modifier list,
    // so recording "C" would double up with it.
    if (/[A-Za-z0-9]/.test(s)) return s.toLowerCase()
  }
  return ""
}

// Qt modifier bitmask -> our modifier names.
function modsFromQt(modifiers) {
  var out = []
  if (modifiers & 0x10000000) out.push("SUPER")  // Qt.MetaModifier
  if (modifiers & 0x04000000) out.push("CTRL")   // Qt.ControlModifier
  if (modifiers & 0x08000000) out.push("ALT")    // Qt.AltModifier
  if (modifiers & 0x02000000) out.push("SHIFT")  // Qt.ShiftModifier
  return normalizeMods(out)
}

// ------------------------------------------------------------ catalogue

// `mods`/`key` are what gets typed; `dispatch` is raw Lua naming a
// dispatcher (never user input — these are literals from this file).
var ACTIONS = [
  { id: "none", group: "Default", label: "Leave alone", kind: "none",
    hint: "Button keeps whatever it does today. Nothing is bound." },

  // -------------------------------------------------- pointer speed
  //
  // These compile to a call into the DPI runtime at the top of the
  // generated file, which already holds this device's presets as a table
  // of accel speeds. So a press is one hl.device call — no process to
  // spawn, nothing to recompute — and the helper is only asked afterwards
  // to remember the choice and draw the OSD.
  { id: "dpi-cycle", group: "Pointer", label: "Next DPI preset", kind: "dpi", mode: "step", delta: 1,
    hint: "Steps through this mouse's DPI presets, wrapping at the end." },
  { id: "dpi-cycle-back", group: "Pointer", label: "Previous DPI preset", kind: "dpi", mode: "step", delta: -1,
    hint: "The same, in the other direction." },
  { id: "dpi-preset", group: "Pointer", label: "Switch to a preset…", kind: "dpi", mode: "select", custom: true,
    hint: "Jumps straight to one preset, wherever you were before." },
  { id: "dpi-sniper", group: "Pointer", label: "Hold to slow down…", kind: "dpi", mode: "hold", custom: true,
    hint: "Drops to one preset while the button is held and springs back when you let go." },

  // -------------------------------------------------- navigation
  { id: "back", group: "Navigate", label: "Back", kind: "chord", mods: "ALT", key: "left",
    hint: "Alt+← — page back in browsers, file managers, and most editors." },
  { id: "forward", group: "Navigate", label: "Forward", kind: "chord", mods: "ALT", key: "right",
    hint: "Alt+→ — page forward." },
  { id: "tab-close", group: "Navigate", label: "Close tab", kind: "chord", mods: "CTRL", key: "w" },
  { id: "tab-reopen", group: "Navigate", label: "Reopen tab", kind: "chord", mods: "CTRL SHIFT", key: "t" },
  { id: "tab-next", group: "Navigate", label: "Next tab", kind: "chord", mods: "CTRL", key: "Tab" },
  { id: "tab-prev", group: "Navigate", label: "Previous tab", kind: "chord", mods: "CTRL SHIFT", key: "Tab" },
  { id: "reload", group: "Navigate", label: "Reload page", kind: "chord", mods: "CTRL", key: "r" },

  // -------------------------------------------------- editing
  { id: "copy", group: "Edit", label: "Copy", kind: "chord", mods: "CTRL", key: "c" },
  { id: "paste", group: "Edit", label: "Paste", kind: "chord", mods: "CTRL", key: "v" },
  { id: "cut", group: "Edit", label: "Cut", kind: "chord", mods: "CTRL", key: "x" },
  { id: "undo", group: "Edit", label: "Undo", kind: "chord", mods: "CTRL", key: "z" },
  { id: "redo", group: "Edit", label: "Redo", kind: "chord", mods: "CTRL SHIFT", key: "z" },
  { id: "select-all", group: "Edit", label: "Select all", kind: "chord", mods: "CTRL", key: "a" },
  { id: "find", group: "Edit", label: "Find", kind: "chord", mods: "CTRL", key: "f" },

  // -------------------------------------------------- window
  { id: "win-close", group: "Window", label: "Close window", kind: "dispatch",
    dispatch: "hl.dsp.window.close()" },
  { id: "win-fullscreen", group: "Window", label: "Fullscreen", kind: "dispatch",
    dispatch: 'hl.dsp.window.fullscreen({ mode = "fullscreen" })' },
  { id: "win-maximize", group: "Window", label: "Maximize", kind: "dispatch",
    dispatch: 'hl.dsp.window.fullscreen({ mode = "maximized" })' },
  { id: "win-float", group: "Window", label: "Float / tile", kind: "dispatch",
    dispatch: 'hl.dsp.window.float({ action = "toggle" })' },
  { id: "win-pin", group: "Window", label: "Pin window", kind: "dispatch",
    dispatch: "hl.dsp.window.pin()" },

  // -------------------------------------------------- workspace
  { id: "ws-next", group: "Workspace", label: "Next workspace", kind: "dispatch",
    dispatch: 'hl.dsp.focus({ workspace = "e+1" })' },
  { id: "ws-prev", group: "Workspace", label: "Previous workspace", kind: "dispatch",
    dispatch: 'hl.dsp.focus({ workspace = "e-1" })' },
  { id: "ws-back", group: "Workspace", label: "Last workspace", kind: "dispatch",
    dispatch: 'hl.dsp.focus({ workspace = "previous" })' },
  { id: "ws-scratchpad", group: "Workspace", label: "Scratchpad", kind: "dispatch",
    dispatch: 'hl.dsp.workspace.toggle_special("scratchpad")' },

  // -------------------------------------------------- omarchy
  { id: "omarchy-menu", group: "Omarchy", label: "Omarchy menu", kind: "exec",
    command: "omarchy-menu toggle root" },
  { id: "omarchy-launcher", group: "Omarchy", label: "App launcher", kind: "exec",
    command: "omarchy-menu toggle launcher" },
  { id: "omarchy-screenshot", group: "Omarchy", label: "Screenshot", kind: "exec",
    command: "omarchy-capture-screenshot" },
  { id: "omarchy-clipboard", group: "Omarchy", label: "Clipboard history", kind: "exec",
    command: "omarchy-shell shell toggle omarchy.clipboard" },
  { id: "omarchy-emoji", group: "Omarchy", label: "Emoji picker", kind: "exec",
    command: "omarchy-shell shell toggle omarchy.emojis" },
  // Runs the command Omarchy's own Super+Ctrl+X runs, rather than typing
  // that chord. Typing it does nothing at all: a chord is injected at the
  // focused client, and Hyprland's keybind matcher never sees an injected
  // key, so a shortcut the compositor owns cannot be triggered this way.
  // See emitChord().
  { id: "dictation", group: "Omarchy", label: "Toggle dictation", kind: "exec",
    command: "voxtype record toggle",
    hint: "Same as Omarchy's Super+Ctrl+X. Needs voxtype installed." },

  // -------------------------------------------------- media
  { id: "vol-up", group: "Media", label: "Volume up", kind: "exec",
    command: "wpctl set-volume -l 1.0 @DEFAULT_AUDIO_SINK@ 5%+" },
  { id: "vol-down", group: "Media", label: "Volume down", kind: "exec",
    command: "wpctl set-volume @DEFAULT_AUDIO_SINK@ 5%-" },
  { id: "vol-mute", group: "Media", label: "Mute", kind: "exec",
    command: "wpctl set-mute @DEFAULT_AUDIO_SINK@ toggle" },
  { id: "media-play", group: "Media", label: "Play / pause", kind: "exec",
    command: "playerctl play-pause" },
  { id: "media-next", group: "Media", label: "Next track", kind: "exec",
    command: "playerctl next" },
  { id: "media-prev", group: "Media", label: "Previous track", kind: "exec",
    command: "playerctl previous" },

  // -------------------------------------------------- user supplied
  { id: "custom-key", group: "Custom", label: "Key combo…", kind: "chord", custom: true,
    hint: "Press any shortcut and this button will type it." },
  { id: "custom-command", group: "Custom", label: "Run command…", kind: "exec", custom: true,
    hint: "Run any shell command." }
]

function catalogue() {
  return ACTIONS
}

function byId(id) {
  for (var i = 0; i < ACTIONS.length; i++) if (ACTIONS[i].id === id) return ACTIONS[i]
  return null
}

function groups() {
  var seen = {}
  var out = []
  for (var i = 0; i < ACTIONS.length; i++) {
    if (!seen[ACTIONS[i].group]) { seen[ACTIONS[i].group] = true; out.push(ACTIONS[i].group) }
  }
  return out
}

// ------------------------------------------------------------ binding model

// A binding is what the user chose for one button: an action id plus the
// fields a custom action needs. Resolving it merges the catalogue entry
// with those overrides and reports whether the result is actually usable.
//
// `context` carries what only the generator knows: `dpi` is this device's
// resolved preset list and `dpiSlot` its slot number in the generated
// runtime. Both are absent when the panel is only asking what a binding
// would be called, which is why a DPI action still resolves to a sensible
// label without them.
function resolve(binding, context) {
  var spec = byId(binding && binding.action)
  if (!spec || spec.id === "none") return { ok: false, empty: true, kind: "none" }

  var out = {
    ok: true, empty: false, id: spec.id, kind: spec.kind,
    label: spec.label, group: spec.group, hint: spec.hint || ""
  }

  if (spec.kind === "chord") {
    var mods = normalizeMods(spec.custom ? (binding.mods || []) : spec.mods)
    var key = spec.custom ? binding.key : spec.key
    if (!validKey(key)) return { ok: false, empty: false, kind: "chord", error: "no key chosen" }
    out.mods = mods
    out.key = key
    out.label = spec.custom ? keyLabel(mods, key) : spec.label
    out.detail = keyLabel(mods, key)
  } else if (spec.kind === "exec") {
    var command = spec.custom ? String(binding.command || "").trim() : spec.command
    if (!command) return { ok: false, empty: false, kind: "exec", error: "no command given" }
    out.command = command
    out.detail = command
    if (spec.custom) out.label = command.length > 28 ? command.substring(0, 27) + "…" : command
  } else if (spec.kind === "dispatch") {
    out.dispatch = spec.dispatch
    out.detail = spec.label
  } else if (spec.kind === "dpi") {
    return resolveDpi(spec, binding, context, out)
  }
  return out
}

// Pointer-speed actions are the one kind whose usability depends on the
// device rather than on the binding alone: a button cannot switch to a
// preset on a mouse that has none, and cannot switch to the fourth preset
// on a mouse with three. Both are refused here rather than compiled into a
// call the runtime would silently ignore.
function resolveDpi(spec, binding, context, out) {
  var dpi = context && context.dpi
  var slot = context && context.dpiSlot

  out.mode = spec.mode
  out.delta = spec.delta || 0
  out.preset = spec.custom ? Math.max(0, parseInt(binding && binding.preset, 10) || 0) : -1
  out.slot = slot || 0

  if (spec.custom) {
    var preset = dpi && dpi.presets ? dpi.presets[out.preset] : null
    if (preset) {
      out.label = (spec.mode === "hold" ? "Hold for " : "") + preset.name + " · " + preset.dpi + " DPI"
      out.detail = out.label
    } else {
      // No device context at all means the caller is only labelling a row
      // in the picker, which has no device to ask about.
      out.detail = out.label
      if (dpi) return { ok: false, empty: false, kind: "dpi", error: "that DPI preset no longer exists" }
    }
  } else {
    out.detail = spec.label
  }

  if (context && !dpi) {
    return {
      ok: false, empty: false, kind: "dpi",
      error: "This button changes DPI, and this mouse has no DPI presets switched on yet."
    }
  }
  // Only the generator supplies a slot, and only the generator can emit.
  // The panel asks the same question without one, to label a chip.
  if (context && context.dpiSlot !== undefined && !slot) {
    return { ok: false, empty: false, kind: "dpi", error: "no DPI runtime slot for this device" }
  }
  // Hold binds a release as well as a press, which the generator emits.
  out.release = spec.mode === "hold"
  return out
}

// ------------------------------------------------------------ lua emission

// Type a chord at whatever is focused.
//
// send_shortcut is the obvious dispatcher for this and it is the wrong
// one: Hyprland can leave the synthetic key latched, so the modifier
// sticks down and the next real keystroke arrives mangled. Omarchy's own
// clipboard bindings work around it by pressing and releasing explicitly,
// and this does the same. https://github.com/hyprwm/Hyprland/discussions/14099
//
// A virtual keyboard (wtype) is also wrong here: it types at the seat, so
// a modifier the user is physically holding merges into the chord.
//
// The limit of the whole mechanism: a chord reaches the focused client and
// nothing else. Hyprland's keybind matcher runs on real input from the
// seat, so an injected key never reaches it and a chord cannot trigger a
// binding the compositor owns — verified against a throwaway bind, with
// send_shortcut failing the same way. Anything Hyprland binds (a Super
// shortcut, almost always) has to be an exec of what that binding runs.
function emitChord(mods, key, indent) {
  var pad = indent || "  "
  var modArg = mods.length > 0 ? luaString(mods.join(" ")) : '""'
  var keyArg = luaString(key)
  return [
    pad + "hl.dispatch(hl.dsp.send_key_state({ mods = " + modArg + ", key = " + keyArg + ", state = \"down\" }))",
    pad + "hl.timer(function()",
    pad + "  hl.dispatch(hl.dsp.send_key_state({ mods = " + modArg + ", key = " + keyArg + ", state = \"up\" }))",
    pad + "end, { timeout = 40, type = \"oneshot\" })"
  ].join("\n")
}

// The body of the bind callback for a resolved binding.
function emitBody(resolved, indent) {
  var pad = indent || "  "
  if (resolved.kind === "chord") return emitChord(resolved.mods, resolved.key, pad)
  if (resolved.kind === "dispatch") return pad + "hl.dispatch(" + resolved.dispatch + ")"
  if (resolved.kind === "exec") return pad + "hl.dispatch(hl.dsp.exec_cmd(" + luaString(resolved.command) + "))"
  if (resolved.kind === "dpi") return emitDpi(resolved, pad)
  return pad + "-- nothing to do"
}

// Slot and preset are integers this file produced, and the function names
// are literals, so nothing here is interpolated from user input.
function emitDpi(resolved, pad) {
  var slot = parseInt(resolved.slot, 10) || 0
  if (slot <= 0) return pad + "-- no DPI runtime for this device"
  if (resolved.mode === "step") return pad + "mm_step(" + slot + ", " + (resolved.delta < 0 ? -1 : 1) + ")"
  // Presets are zero-based everywhere in the config and one-based in Lua.
  var index = (parseInt(resolved.preset, 10) || 0) + 1
  if (resolved.mode === "hold") return pad + "mm_hold(" + slot + ", " + index + ")"
  return pad + "mm_select(" + slot + ", " + index + ")"
}

// The body of the *release* bind, for an action that needs both edges, or
// "" for the vast majority that do not.
function emitReleaseBody(resolved, indent) {
  if (!resolved || !resolved.release) return ""
  var slot = parseInt(resolved.slot, 10) || 0
  if (slot <= 0) return ""
  return (indent || "  ") + "mm_release(" + slot + ")"
}

if (typeof module !== "undefined") {
  module.exports = {
    luaString: luaString,
    normalizeMods: normalizeMods,
    validKey: validKey,
    keyLabel: keyLabel,
    keysymFor: keysymFor,
    modsFromQt: modsFromQt,
    isModifierKey: isModifierKey,
    prettyKey: prettyKey,
    catalogue: catalogue,
    byId: byId,
    groups: groups,
    resolve: resolve,
    emitChord: emitChord,
    emitBody: emitBody,
    emitReleaseBody: emitReleaseBody
  }
}
