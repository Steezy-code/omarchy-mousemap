# MouseMap

An Omarchy shell plugin that shows every button on your mouse on a diagram,
with a leader line from each button to a label saying what it does — and lets
you rebind any of them to a shortcut, a window action, or a command. It also
gives the mouse named DPI presets you can switch between, including from a
button on the mouse itself.

The diagram is generated from whatever mouse is actually plugged in. A
two-button travel mouse and a seven-button gaming mouse each draw as
themselves, and the leaders land on the right places on the shell.

![the panel](preview.png)

## Nothing is written to the mouse

This is the important difference from Piper / libratbag, which is the usual
answer to remapping a mouse on Linux. Piper flashes the mouse's **onboard
memory**, so your remaps follow the device to every machine you plug it into.

MouseMap never touches the hardware. Everything it does is a Hyprland setting
on *this* machine, scoped to *this* device name — a keybinding, or a pointer
speed. Plug the mouse into another computer and it behaves exactly as it did
out of the box.

## Install

```bash
omarchy plugin add https://github.com/Steezy-code/omarchy-mousemap --enable
```

That clones the repository into `~/.config/omarchy/plugins/` and enables it.
Open the map from its bar icon, or:

```bash
omarchy-shell shell toggle io.github.steezy-code.mousemap
```

The first time you open the panel it sets itself up, because the panel cannot
draw itself without it: the window rule that floats this window lives in the
file it generates. Setup writes that generated file under
`~/.local/state/omarchy-mousemap/`, takes a one-time backup of
`~/.config/hypr/bindings.lua` at `bindings.lua.mousemap.bak`, and adds one
`dofile` line to it inside `-- BEGIN mousemap` markers.

That line is the only change ever made to a file you wrote, and nothing of
yours is rewritten — everything outside the markers is preserved byte for
byte. Your own mappings are a separate step: a button does nothing until you
choose an action and press **Apply**.

To update later:

```bash
omarchy plugin update io.github.steezy-code.mousemap
```

### Requirements

Omarchy 4 (Hyprland 0.56+ with the Lua config), which is where `hl.bind`,
`hl.device`, the `device` bind option and `send_key_state` come from.

No packages beyond what Omarchy already installs. The helper script uses
`bash`, `python3` and `hyprctl`; the panel is Quickshell QML. Two of the
built-in actions shell out to things Omarchy ships — `playerctl` for the media
actions and `wpctl` for the volume ones — and *Toggle dictation* runs
`voxtype`, which is optional. An action whose command is missing simply does
nothing; nothing else is affected.

### Developing on it

```bash
./install
```

`install` copies this checkout into
`~/.config/omarchy/plugins/io.github.steezy-code.mousemap`. It copies rather
than symlinks on purpose: Quickshell watches the plugin tree for changes and
does not follow a symlinked directory, so a symlinked install silently stops
hot-reloading. (The marketplace refuses symlinks inside a plugin folder for a
better reason: a symlink in a trusted plugin directory can point anywhere.)

Re-run `./install` after editing. QML components are cached once loaded, so
changes to an already-open panel need `omarchy restart shell`.

## Using it

Click any button on the diagram, or its label, and pick what it should do.
Nothing is live until you press **Apply**.

- **Pointer** — next / previous DPI preset, jump to one, hold for one
- **Navigate** — Back, Forward, tab switching, reload
- **Edit** — copy, paste, cut, undo, redo, find
- **Window** — close, fullscreen, float/tile, pin
- **Workspace** — next, previous, last, scratchpad
- **Omarchy** — menu, launcher, screenshot, clipboard history, emoji picker,
  dictation
- **Media** — volume, play/pause, track skip
- **Custom** — record any key combo, or run any command

Left and right click are shown but flagged: binding them takes the click
away everywhere, including in the panel that did it.

## DPI presets

Press **DPI** in the footer. Give the mouse a few named speeds — the defaults
are a quarter, a half, and all of it — and switch between them by clicking, or
by binding a button to **Next DPI preset**. A switch draws an on-screen
overlay saying which one you landed on, and the choice survives a Hyprland
reload.

**Hold to slow down** is the sniper button: press and hold to drop to one
preset, let go and spring back to the one you had. Both edges are bound, so
there is nothing to toggle back.

### What a "DPI" is here, exactly

Hyprland hands a device's `sensitivity` to libinput as the pointer
acceleration speed. Under the **flat** profile, libinput turns that into a
constant factor:

```
factor = speed + 1        (libinput, filter-flat.c)
```

which is an exact linear multiplier from 0× to 2×, with 1× at 0. So presets
pin `accel_profile = "flat"` — the adaptive profile's curve is
velocity-dependent, and a DPI computed against it would be a number that means
nothing — and then:

```
effective = base × (1 + sensitivity)
```

`base` is what the mouse's own sensor is set to. MouseMap cannot read it and
never changes it; you tell it in the panel, and set the sensor itself with
your mouse's own configurator — `solaar`, `piper`/`ratbagd`, or a vendor tool
such as G HUB.

Two consequences worth knowing:

**Set the sensor high and come down from it.** A preset can reach at most 2×
the base, which sounds like a limit and mostly is not, because scaling *down*
is the good direction: the sensor still reports at full resolution and the
compositor divides, so low-DPI motion stays smooth. Scaling up multiplies
whole sensor counts and steps the pointer.

**If `base` is wrong, nothing breaks.** Every preset is then wrong by the same
factor: the numbers become labels, but the ratios between them stay exact. So
a mouse whose sensor setting you cannot find out still gets a working feature.

Switching a preset is one `hl.device` call inside the generated Lua, with the
sensitivity table precomputed — no process to spawn on the press. The helper
is only asked afterwards to remember the choice and draw the overlay.

### Moving a button

Drag a label to say where its button really is. The shell shows every spot
it could go, and dropping on one — or onto another label — exchanges the
two, so nothing is ever left stacked on top of anything else. The same
spots are listed in the sidebar under **Where is this button?** for anyone
who would rather click than drag.

This matters because detection asks *which button is which*, and a
mis-press during that pass puts a button in the wrong place on the diagram.
**Test placement** arms the same probes but records nothing: press a
button, watch where it lights up, and drag its label if it is wrong.

### Detect buttons

Behind a wireless receiver the kernel often cannot tell you which buttons the
mouse has. A receiver is a HID multiplexer: it advertises the union of
everything it *could* ever carry — all sixteen `BTN_MOUSE` codes plus a full
keyboard — regardless of what is actually paired to it. Logitech's Unifying
and Lightspeed dongles are the common case, but anything that multiplexes
behaves this way. That is why a capability list alone is not trustworthy.

**Detect buttons** resolves it by watching: it temporarily binds every
candidate button code, you press each button on your mouse, and whatever
fires is recorded as the real button list. Left and right click are left
alone so you can still click. Press **Apply** to keep the result.

If a button never shows up during a detect pass, it is probably not sending a
mouse button at all — see below.

### Battery

Wireless mice that speak HID++ report their charge through the kernel, and
MouseMap shows it in the header and draws it on the mouse's palm. The reading
is matched to the mouse by sysfs path rather than by name, so it stays correct
when two of the same model are paired to one receiver. Wired mice simply have
no battery section.

## Buttons that type instead of clicking

Plenty of mouse buttons never send a mouse button at all. An onboard profile
that assigns a button a keystroke or a shift-layer macro makes it arrive as a
**keyboard key**, from the receiver's keyboard interface rather than its
pointer one — vendor configurators all do this, Logitech's G HUB and Razer's
Synapse among them. A gaming mouse can easily have one thumb button sending
`2` and the other sending `Left Ctrl`.

MouseMap handles these. The same physical mouse appears in Hyprland a second
time as a keyboard, with its own device name, so the key can be bound scoped
to *that* device — the mouse and nothing else. Your real keyboard keeps
working normally, and the button stops typing because the compositor now
consumes it.

This is why per-device scoping is not optional for such a button: binding a
bare `2` or `Ctrl` globally would swallow that key everywhere and break
typing. Generation refuses to emit one unscoped, and says so in the panel
rather than doing it anyway.

Detection covers them too — the guided pass watches the mouse's keyboard
device alongside its buttons, which is only safe because every one of those
probe binds is scoped to the mouse.

If you would rather have real mouse buttons, reassign them in the mouse's
onboard profile with its vendor configurator, or `piper`/`ratbagd`. Be aware
that this writes to the mouse, so unlike everything else here it *does*
follow the device to other machines.

If a button still never shows up — in **Detect buttons** or **Test
placement** — the compositor is not receiving anything from it, and the only
place left to look is the raw kernel event stream. MouseMap deliberately ships
nothing for that. Reading `/dev/input/event*` needs root, and root should only
ever run code that cannot be swapped out while the password prompt is open,
which rules out anything in a plugin folder the desktop user can write to. Use
a packaged, root-owned tool instead, such as `evtest` from the Arch
repositories.

Nothing in MouseMap runs with elevated privileges, at any point.

## How it works

```
~/.config/omarchy/mousemap.json          your mapping (source of truth)
        │
        ▼  generated on Apply
~/.local/state/omarchy-mousemap/
   bindings.lua    the binds and the DPI runtime
   dpi.json        preset names and numbers, for the overlay
   dpi-active      which preset each mouse is on
        │
        ▼  one loader line, added once
~/.config/hypr/bindings.lua
```

The plugin generates whole files it owns, rather than editing a fenced block
inside your hand-written `bindings.lua`. The only change to your own config is
a single `dofile` line inside `-- BEGIN mousemap` markers, and a one-time
backup is taken at `bindings.lua.mousemap.bak` before that line is ever added.

`dofile` rather than `require`: Hyprland's bootstrap only clears
`package.loaded` for the `default.hypr`, `hypr` and theme prefixes, so a
required module under any other name would be cached and a reload would
silently keep serving the previous mapping.

Bindings and pointer speed are both scoped to the device with Hyprland's
`device` option, so two different mice can carry two different maps.

Everything that touches the filesystem or the compositor goes through
`scripts/mousemap`, so there is one place to read to know what this plugin can
do. Nothing generated ever interpolates a name into a shell command: a DPI
bind passes the helper two integers, and the helper looks up what they mean.

### Typing a shortcut

A binding like "Back" works by pressing `Alt+Left` at whatever is focused,
via `send_key_state` down/up rather than `send_shortcut` — Hyprland can leave
the synthetic key latched with the latter, so the modifier sticks down and the
next real keystroke arrives mangled. Omarchy's own clipboard bindings use the
same workaround ([discussion #14099](https://github.com/hyprwm/Hyprland/discussions/14099)).

A virtual keyboard such as `wtype` is also wrong here: it types at the seat,
so a modifier you are physically holding merges into the injected chord.

The limit of this mechanism is that a chord only ever reaches the focused
**application**. Hyprland matches its own keybindings against real input
from the seat, so an injected key never reaches the bind matcher and a
shortcut the compositor owns cannot be triggered by typing it —
`send_shortcut` included. Anything Hyprland binds (a Super shortcut, nearly
always) has to be **Run command…** with whatever that binding runs, which
is why *Toggle dictation* execs `voxtype record toggle` rather than sending
Super+Ctrl+X. The panel says so when you record a chord carrying Super.

## Layout

The label placement is isotonic regression (pool-adjacent-violators). Each
chip wants to sit at its button's height; chips must not overlap; and leaders
must not cross. The third falls out of the second as long as chips keep their
anchors' vertical order, which makes the whole thing one-dimensional and
exactly solvable.

The obvious greedy alternative — push each label down until it fits — drifts
badly once a cluster forms near the top, shoving every label below it down
even when there was slack above. PAVA spreads a crowded cluster around its own
centre of mass and leaves everything else where it wanted to be.

The shell silhouette is sampled from one width function, which the button
anchors also call, so a side-button marker can never drift off the drawn edge.

## Files

| | |
|---|---|
| `Devices.js` | discovery: evdev capabilities, receiver detection, battery join |
| `Profiles.js` | shell geometry and the known-device table |
| `Leaders.js` | label placement and leader routing |
| `Actions.js` | what a button can do, and the Lua it compiles to |
| `Dpi.js` | DPI presets, and the sensitivity arithmetic behind them |
| `Config.js` | config shape, Lua generation, the loader hook |
| `MouseCanvas.qml` | the diagram |
| `MouseMapPanel.qml` | the panel |
| `ActionPicker.qml` | the rebinding sidebar |
| `DpiPanel.qml` | the DPI sidebar |
| `scripts/mousemap` | the only path to the filesystem and the compositor |

## Tests

```bash
tests/run
```

No framework and no dependencies — each file is `node` plus the real `lua`
and `luac` binaries, because the interesting failures are not in JavaScript.

`test_dpi.js` executes the generated Lua in a real interpreter against a stub
compositor and then presses the binds, so cycling, wrapping, sniper release
and the state file are checked by behaviour rather than by grepping the
output. That sandbox has `os.execute` and `io.popen` deleted, which turns a
preset name or a device name that escaped its string literal into a loud
failure rather than something a substring check might miss.

`test_config.js` round-trips hostile strings through the real `lua`
interpreter and syntax-checks generated output with `luac -p`, because the
generated file is executed by the compositor. It also holds the two copies
of the trigger rules — `Config` generates the bind string, `Devices` states
it for the UI — to each other across the whole id space, because two copies
of one rule is how keystroke buttons were silently dropped once already.

`test_leaders.js` sweeps every button count from 2 to 16 and shuffles each
one through every place, asserting that no two buttons ever end up in the
same spot.

`test_manifest.js` checks the manifest against the schema the shell enforces,
and holds every other file that repeats the plugin id to it.

## Uninstall

```bash
omarchy plugin remove io.github.steezy-code.mousemap
```

Then delete the `-- BEGIN mousemap` … `-- END mousemap` block from
`~/.config/hypr/bindings.lua` and run `hyprctl reload`. Your original file is
at `~/.config/hypr/bindings.lua.mousemap.bak`.

Your mapping and the generated files are left behind in case you come back;
remove them with:

```bash
rm -f  ~/.config/omarchy/mousemap.json
rm -rf ~/.local/state/omarchy-mousemap
```

## License

MIT — see [LICENSE](LICENSE).
