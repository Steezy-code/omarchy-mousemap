import QtQuick
import QtQuick.Layouts
import Quickshell
import Quickshell.Io
import qs.Commons
import qs.Ui as Ui
import "Devices.js" as Devices
import "Profiles.js" as Profiles
import "Leaders.js" as Leaders
import "Actions.js" as Actions
import "Config.js" as Config

// MouseMap — see what every button on your mouse does, and change it.
//
// The diagram is the interface. Buttons are drawn where they physically
// sit on the shell, each one led out to a chip naming what it does; click
// a chip to rebind it. Everything reacts to the mouse that is actually
// plugged in, so a two-button travel mouse and a seven-button gaming mouse
// each draw as themselves rather than as a stock picture.
Item {
  id: root

  readonly property string pluginId: "steezy.mousemap"
  property var shell: null
  property string sourceDir: ""
  property bool closingFromHost: false

  function open(payloadJson) {
    closingFromHost = false
    window.visible = true
    refresh()
    revealAnim.restart()
    floatTimer.restart()
  }

  function close() {
    closingFromHost = true
    window.visible = false
    closingFromHost = false
  }

  function requestClose() {
    if (learning) stopLearn()
    window.visible = false
    if (shell && typeof shell.hide === "function") shell.hide(root.pluginId)
  }

  // ------------------------------------------------------------ state

  property var devices: []
  property int deviceIndex: 0
  property var config: Config.defaults()

  // QML cannot see into a plain JS object, so every mutation bumps this
  // and the bindings that care depend on it.
  property int configRev: 0

  property int selectedCode: -1
  property int hoveredCode: -1
  property bool dirty: false
  property string status: ""
  property bool statusBad: false
  property bool busy: false

  property bool learning: false
  property var learnedCodes: []

  // The action picker's working copy for the selected button, so a
  // half-typed command does not churn the config on every keystroke.
  property string draftCommand: ""
  property bool capturing: false

  readonly property var device: deviceIndex >= 0 && deviceIndex < devices.length
    ? devices[deviceIndex] : null
  readonly property string deviceKey: device ? device.key : ""

  readonly property var buttonList: {
    configRev
    return device ? device.buttons : []
  }

  readonly property var battery: device && device.battery ? device.battery : null

  // code -> place id for this device, as recorded by the guided pass.
  readonly property var layout: {
    configRev
    var entry = Config.deviceEntry(config, deviceKey)
    return entry.layout || ({})
  }

  // Geometry in box coordinates, which is where roles now come from: a
  // place the user pointed at knows which flank a button is on, and the
  // code alone does not.
  readonly property var placedButtons: {
    configRev
    return Profiles.buttonGeometry(
      buttonList.map(function (b) { return b.code }), shapeName, null, layout)
  }

  readonly property string shapeName: device
    ? Profiles.shapeFor(device.profileId, device.buttons.length)
    : "generic"

  function bindingFor(code) {
    configRev
    return Config.bindingFor(config, deviceKey, code)
  }

  function resolvedFor(code) {
    return Actions.resolve(bindingFor(code))
  }

  function isMapped(code) {
    return resolvedFor(code).ok
  }

  readonly property var mappedSet: {
    configRev
    var out = ({})
    for (var i = 0; i < buttonList.length; i++) {
      if (isMapped(buttonList[i].code)) out[buttonList[i].code] = true
    }
    return out
  }

  readonly property int mappedCount: {
    configRev
    return Config.countBindings(config, deviceKey)
  }

  // ------------------------------------------------------------ geometry
  //
  // Everything below is computed in canvas pixels and handed to both the
  // canvas and the chips, so the drawing and the hit targets are the same
  // numbers rather than two parallel calculations.

  readonly property int gutterWidth: 224
  readonly property int gutterGap: 30
  readonly property int chipHeight: 40
  readonly property int chipGap: 9

  // Cap on how big the shell is allowed to get. Without it the mouse grows
  // to whatever height the window has and swamps the labels, which are the
  // part you actually read.
  readonly property int maxShellHeight: 480

  // The whole composition — gutter, shell, gutter — is sized together and
  // centred as a unit, so the chips stay beside the mouse instead of being
  // flung out to the window edges when the window is wide.
  function metrics(w, h) {
    var shellH = Math.min(Math.max(150, h - 40), maxShellHeight)
    var shellW = shellH * (Profiles.BOX_W / Profiles.BOX_H)

    var sides = 2 * (gutterWidth + gutterGap)
    if (sides + shellW > w) {
      shellW = Math.max(50, w - sides)
      shellH = shellW * (Profiles.BOX_H / Profiles.BOX_W)
      if (shellH > h - 24) {
        shellH = Math.max(80, h - 24)
        shellW = shellH * (Profiles.BOX_W / Profiles.BOX_H)
      }
    }

    var total = sides + shellW
    var originX = Math.max(0, (w - total) / 2)
    var shellX = originX + gutterWidth + gutterGap

    return {
      shell: Qt.rect(shellX, (h - shellH) / 2, shellW, shellH),
      left: { x: originX, width: gutterWidth },
      right: { x: shellX + shellW + gutterGap, width: gutterWidth }
    }
  }

  function shellRect(w, h) {
    return metrics(w, h).shell
  }

  function canvasButtons(w, h) {
    var rect = shellRect(w, h)
    var geo = Profiles.buttonGeometry(
      buttonList.map(function (b) { return b.code }), shapeName, null, layout)
    var out = []
    for (var i = 0; i < geo.length; i++) {
      var g = geo[i]
      out.push({
        code: g.code, side: g.side, kind: g.kind, role: g.role,
        x: rect.x + (g.x / Profiles.BOX_W) * rect.width,
        y: rect.y + (g.y / Profiles.BOX_H) * rect.height
      })
    }
    return out
  }

  function canvasPlacements(w, h, buttons) {
    if (buttons.length === 0) return []
    var m = metrics(w, h)
    return Leaders.layout({
      buttons: buttons,
      bounds: { top: 8, bottom: Math.max(60, h - 8) },
      left: m.left,
      right: m.right,
      chipHeight: chipHeight, chipGap: chipGap,
      stub: 16, radius: 11, widths: {}
    })
  }

  // ------------------------------------------------------------ actions

  function setAction(code, actionId) {
    var current = bindingFor(code)
    var next = {
      action: actionId,
      mods: current.mods || [],
      key: current.key || "",
      command: current.command || ""
    }
    Config.setBinding(config, deviceKey, code, next)
    configRev++
    dirty = true
    draftCommand = next.command
  }

  function setChord(code, mods, key) {
    var current = bindingFor(code)
    Config.setBinding(config, deviceKey, code, {
      action: "custom-key", mods: mods, key: key, command: current.command || ""
    })
    configRev++
    dirty = true
  }

  function setCommand(code, command) {
    var current = bindingFor(code)
    Config.setBinding(config, deviceKey, code, {
      action: "custom-command", mods: current.mods || [], key: current.key || "",
      command: command
    })
    configRev++
    dirty = true
  }

  function clearButton(code) {
    Config.setBinding(config, deviceKey, code, null)
    configRev++
    dirty = true
  }

  function say(message, bad) {
    status = message
    statusBad = !!bad
  }

  // ------------------------------------------------------------ processes

  function refresh() {
    busy = true
    detectProc.buffer = ""
    detectProc.running = true
  }

  Process {
    id: detectProc
    property string buffer: ""
    command: [root.helper, "detect"]
    stdout: StdioCollector { waitForEnd: true; onStreamFinished: detectProc.buffer = text }
    onExited: function (code) {
      root.busy = false
      if (code !== 0) { root.say("Could not read input devices.", true); return }
      root.applyDetect(detectProc.buffer)
    }
  }

  readonly property string helper: sourceDir !== ""
    ? sourceDir + "/scripts/mousemap"
    : Quickshell.env("HOME") + "/.config/omarchy/plugins/steezy.mousemap/scripts/mousemap"

  function applyDetect(raw) {
    var payload
    try { payload = JSON.parse(raw) } catch (e) { say("Device probe returned nothing usable.", true); return }

    var learnedMap = ({})
    for (var key in config.devices) {
      if (Object.prototype.hasOwnProperty.call(config.devices, key)) {
        var entry = config.devices[key]
        if (entry.learned && entry.learned.length > 0) learnedMap[key] = entry.learned
      }
    }

    var found = Devices.discover(payload.proc, payload.hypr, Profiles.profiles(), learnedMap, payload.batteries)
    devices = found
    if (deviceIndex >= found.length) deviceIndex = 0
    configRev++

    if (found.length === 0) say("No mouse detected.", true)
    else say("")

    ensureSetup()
  }

  // First run installs the one loader line in the user's bindings.lua and
  // writes the generated file it points at. Done here rather than waiting
  // for the first Apply because that file also carries the window rule
  // that floats this panel — without it the diagram opens into a tiling
  // slot and has no room to draw.
  property bool setupChecked: false
  property bool settingUp: false

  function ensureSetup() {
    if (setupChecked || !device) return
    setupChecked = true
    setupReadProc.buffer = ""
    setupReadProc.running = true
  }

  Process {
    id: setupReadProc
    property string buffer: ""
    command: [root.helper, "read", Quickshell.env("HOME") + "/.config/hypr/bindings.lua"]
    stdout: StdioCollector { waitForEnd: true; onStreamFinished: setupReadProc.buffer = text }
    onExited: {
      root.hookPresent = Config.hasHook(setupReadProc.buffer)
      setupLuaProc.buffer = ""
      setupLuaProc.running = true
    }
  }

  property bool hookPresent: false

  // Compare what is on disk with what this version would generate. That
  // catches the missing loader on a first run, and equally an install
  // whose generated file predates a change to the generator — the window
  // rule that floats this panel arrived that way — without needing a
  // migration step or a version stamp to compare against.
  Process {
    id: setupLuaProc
    property string buffer: ""
    command: [root.helper, "read", Quickshell.env("HOME") + "/.local/state/omarchy-mousemap/bindings.lua"]
    stdout: StdioCollector { waitForEnd: true; onStreamFinished: setupLuaProc.buffer = text }
    onExited: {
      var expected = Config.generateLua(root.devices, root.config, Actions).text
      if (root.hookPresent && setupLuaProc.buffer === expected) return
      root.settingUp = true
      root.applyNow()
    }
  }

  // Config is read through the same helper as everything else.
  Process {
    id: readConfigProc
    property string buffer: ""
    command: [root.helper, "read", Quickshell.env("HOME") + "/.config/omarchy/mousemap.json"]
    stdout: StdioCollector { waitForEnd: true; onStreamFinished: readConfigProc.buffer = text }
    onExited: {
      var parsed = null
      if (readConfigProc.buffer.trim() !== "") {
        try { parsed = JSON.parse(readConfigProc.buffer) } catch (e) { parsed = null }
      }
      root.config = Config.normalize(parsed)
      root.configRev++
      root.refresh()
    }
  }

  // Writing is a small pipeline: config JSON, then the generated Lua, then
  // the loader line in the user's bindings.lua, then a reload. Each step
  // only runs if the one before it succeeded, so a failure never leaves
  // Hyprland pointed at a file that was not written.
  property string pendingLua: ""
  property string pendingHypr: ""
  property int applyStage: 0

  function applyNow() {
    if (!device) return
    var generated = Config.generateLua(devices, config, Actions)
    pendingLua = generated.text

    if (generated.skipped.length > 0) {
      say(generated.skipped[0].reason, true)
    }

    busy = true
    applyStage = 1
    writeFile(Quickshell.env("HOME") + "/.config/omarchy/mousemap.json",
              JSON.stringify(config, null, 2) + "\n")
  }

  // stdin has to be armed before the process starts, then closed from
  // onStarted — the helper's `cat` only returns on EOF, so leaving it open
  // hangs the write.
  function writeFile(path, text) {
    writeProc.target = path
    writeProc.payload = text
    writeProc.stdinEnabled = true
    writeProc.running = true
  }

  Process {
    id: writeProc
    property string target: ""
    property string payload: ""
    command: [root.helper, "write", target]
    stdinEnabled: false
    onStarted: {
      writeProc.write(writeProc.payload)
      writeProc.stdinEnabled = false
    }
    onExited: function (code, statusCode) {
      if (code !== 0 || statusCode !== 0) {
        root.busy = false
        root.applyStage = 0
        root.say("Could not write " + writeProc.target + ".", true)
        return
      }
      root.advanceApply()
    }
  }

  // Stages, in order: 1 config written -> 2 lua written -> 3 backup taken
  // -> 4 bindings.lua read and hooked -> 5 reload. Each step is only
  // reached from the success path of the one before it.
  function advanceApply() {
    if (applyStage === 1) {
      applyStage = 2
      writeFile(Quickshell.env("HOME") + "/.local/state/omarchy-mousemap/bindings.lua", pendingLua)
    } else if (applyStage === 2) {
      applyStage = 3
      backupProc.running = true
    } else if (applyStage === 4) {
      applyStage = 5
      reloadProc.running = true
    }
  }

  Process {
    id: backupProc
    command: [root.helper, "backup"]
    onExited: { readHyprProc.buffer = ""; readHyprProc.running = true }
  }

  Process {
    id: readHyprProc
    property string buffer: ""
    command: [root.helper, "read", Quickshell.env("HOME") + "/.config/hypr/bindings.lua"]
    stdout: StdioCollector { waitForEnd: true; onStreamFinished: readHyprProc.buffer = text }
    onExited: {
      var current = readHyprProc.buffer
      var next = Config.withHook(current, "/.local/state/omarchy-mousemap/bindings.lua")
      root.applyStage = 4
      if (next === current) {
        // Already hooked, or an unclosed marker we refuse to guess at:
        // nothing to write, go straight to the reload.
        root.advanceApply()
      } else {
        root.pendingHypr = next
        root.writeFile(Quickshell.env("HOME") + "/.config/hypr/bindings.lua", next)
      }
    }
  }

  Process {
    id: reloadProc
    property string buffer: ""
    command: [root.helper, "reload"]
    stdout: StdioCollector { waitForEnd: true; onStreamFinished: reloadProc.buffer = text }
    onExited: function (code) {
      root.busy = false
      root.applyStage = 0
      if (code !== 0) {
        root.say("Hyprland rejected the config: " + reloadProc.buffer.trim(), true)
        return
      }
      root.dirty = false
      if (root.settingUp) {
        root.settingUp = false
        root.say("Set up. Reopen the panel to get the full-size window.")
        return
      }
      root.say(root.mappedCount === 0 ? "Cleared. No buttons mapped."
                                      : "Applied. " + root.mappedCount + " button" +
                                        (root.mappedCount === 1 ? "" : "s") + " live.")
    }
  }

  // ------------------------------------------------------------ learn

  // Guided detection.
  //
  // The earlier version simply armed every code, collected whatever fired,
  // and replaced the button list with the result. That had two faults: a
  // press it missed silently deleted a button, and knowing a code says
  // nothing about where the button physically is — which matters, because
  // a shell with swappable side panels can put buttons on either flank.
  //
  // So this walks named places instead. It asks for one button at a time,
  // waits for a code it has not seen yet, and records code -> place. Every
  // step is skippable, and nothing is committed until the walk finishes,
  // so an abandoned pass cannot damage a layout that already worked.

  property int learnStep: 0
  property var learnLayout: ({})     // place id -> code, this pass only
  property var learnSeen: []         // codes claimed during this pass
  property int learnRev: 0

  readonly property var learnSteps: Profiles.placeSteps()

  readonly property var learnCurrent: learnStep >= 0 && learnStep < learnSteps.length
    ? learnSteps[learnStep] : null

  function startLearn() {
    learning = true
    learnStep = 0
    learnLayout = ({})
    learnSeen = []
    learnRev++
    learnedCodes = []
    learnTimer.start()
    // The keyboard name lets the probe also watch for buttons that send
    // keystrokes; without it those buttons are invisible to detection.
    learnProc.command = device && device.hyprKbdName
      ? [root.helper, "learn", "arm", device.hyprKbdName]
      : [root.helper, "learn", "arm"]
    learnProc.running = true
    say("Press each button as it is named. Left and right click are left alone.")
  }

  function skipLearnStep() {
    if (learnStep < learnSteps.length - 1) learnStep++
    else finishLearn()
  }

  function cancelLearn() {
    learning = false
    learnTimer.stop()
    disarmProc.running = true
    say("Detection cancelled. Nothing changed.")
  }

  // Commit: the places walked become the layout, and the codes claimed
  // become the button list. Left and right click are added back because
  // the probe deliberately never grabs them.
  function finishLearn() {
    learning = false
    learnTimer.stop()

    var codes = learnSeen.slice()
    if (codes.indexOf(0x110) === -1) codes.push(0x110)
    if (codes.indexOf(0x111) === -1) codes.push(0x111)
    codes.sort(function (a, b) { return a - b })

    if (!config.devices[deviceKey]) {
      config.devices[deviceKey] = { label: "", learned: [], layout: {}, bindings: {} }
    }
    var entry = config.devices[deviceKey]
    entry.learned = codes
    entry.label = device ? device.label : ""

    var layoutOut = { "272": "left-click", "273": "right-click" }
    for (var place in learnLayout) {
      if (Object.prototype.hasOwnProperty.call(learnLayout, place)) {
        layoutOut[String(learnLayout[place])] = place
      }
    }
    entry.layout = layoutOut

    dirty = true
    configRev++
    disarmProc.running = true

    var found = learnSeen.length
    say(found === 0
      ? "No buttons detected. If a button does nothing here it is probably sending a keystroke — see scripts/mousemap-sniff."
      : "Found " + found + " button" + (found === 1 ? "" : "s") + ". Press Apply to save.")
  }

  function stopLearn() { cancelLearn() }

  Process { id: learnProc }
  Process {
    id: disarmProc
    command: [root.helper, "learn", "disarm"]
    onExited: root.refresh()
  }

  Process {
    id: learnReadProc
    property string buffer: ""
    command: [root.helper, "learn", "read"]
    stdout: StdioCollector { waitForEnd: true; onStreamFinished: learnReadProc.buffer = text }
    onExited: {
      if (!root.learning) return
      var lines = learnReadProc.buffer.split("\n")
      for (var i = 0; i < lines.length; i++) {
        var code = parseInt(lines[i].trim(), 10)
        if (!isFinite(code) || code < 0x110 || code > 0x11f) continue
        // Only a code this pass has not already claimed advances the walk,
        // so holding a button or double-pressing cannot eat the next step.
        if (root.learnSeen.indexOf(code) !== -1) continue

        root.learnSeen.push(code)
        if (root.learnCurrent) root.learnLayout[root.learnCurrent.place] = code
        root.learnedCodes = root.learnSeen.slice()
        root.pulseCode = code
        pulseTimer.restart()
        root.learnRev++

        if (root.learnStep < root.learnSteps.length - 1) root.learnStep++
        else { root.finishLearn(); return }
      }
    }
  }

  property int pulseCode: -1
  Timer { id: pulseTimer; interval: 260; onTriggered: root.pulseCode = -1 }
  Timer {
    id: learnTimer
    interval: 300
    repeat: true
    onTriggered: if (!learnReadProc.running) learnReadProc.running = true
  }

  // A battery reading goes stale while the panel sits open. Re-running
  // discovery is cheap (two small reads) and also picks up a mouse that
  // was plugged in or switched off in the meantime.
  Timer {
    id: batteryTimer
    interval: 60000
    repeat: true
    running: window.visible && !root.learning && !root.busy
    onTriggered: if (!detectProc.running) root.refresh()
  }

  // Float the window once it exists. Hyprland cannot do this with a rule
  // (see `mousemap float`), and the window is not mapped the instant open()
  // returns, so this waits a beat rather than racing it.
  Timer {
    id: floatTimer
    interval: 220
    repeat: false
    onTriggered: if (!floatProc.running) floatProc.running = true
  }

  Process {
    id: floatProc
    command: [root.helper, "float"]
  }

  Component.onCompleted: readConfigProc.running = true

  // ------------------------------------------------------------ window

  FloatingWindow {
    id: window
    title: "MouseMap — mouse buttons for Omarchy"
    color: Color.background
    implicitWidth: 1180
    implicitHeight: 760
    minimumSize: Qt.size(960, 640)

    onVisibleChanged: {
      if (!visible && !root.closingFromHost && root.shell && typeof root.shell.hide === "function")
        root.shell.hide(root.pluginId)
    }

    FocusScope {
      id: focusScope
      anchors.fill: parent
      focus: true

      Keys.priority: Keys.AfterItem
      Keys.onPressed: function (event) {
        if (root.capturing) return
        if (event.key === Qt.Key_Escape) {
          if (root.selectedCode >= 0) root.selectedCode = -1
          else root.requestClose()
          event.accepted = true
        }
      }

      ColumnLayout {
        anchors.fill: parent
        anchors.margins: Style.space(5)
        spacing: Style.space(4)

        // ---------------------------------------------------- header
        RowLayout {
          Layout.fillWidth: true
          spacing: Style.space(4)

          ColumnLayout {
            spacing: 1
            RowLayout {
              spacing: Style.space(3)
              Text {
                text: "MouseMap"
                color: Color.foreground
                font.family: Style.font.family
                font.pixelSize: Style.font.heading
                font.weight: Font.DemiBold
              }
              Rectangle {
                visible: root.device
                radius: Style.cornerRadius > 0 ? Style.cornerRadius : 3
                color: Qt.rgba(Color.accent.r, Color.accent.g, Color.accent.b, 0.14)
                border.color: Qt.rgba(Color.accent.r, Color.accent.g, Color.accent.b, 0.4)
                border.width: 1
                implicitWidth: sourceLabel.implicitWidth + Style.space(4)
                implicitHeight: sourceLabel.implicitHeight + Style.space(2)
                Layout.alignment: Qt.AlignVCenter
                Text {
                  id: sourceLabel
                  anchors.centerIn: parent
                  color: Color.accent
                  font.family: Style.font.family
                  font.pixelSize: Style.font.caption
                  text: {
                    if (!root.device) return ""
                    if (root.device.source === "learned") return "LEARNED"
                    if (root.device.source === "profile") return "KNOWN MODEL"
                    if (root.device.source === "assumed") return "GUESSED"
                    return "DETECTED"
                  }
                }
              }
            }
            RowLayout {
              spacing: Style.space(2)
              Text {
                text: root.device
                  ? root.device.label + "  ·  " + root.buttonList.length + " buttons  ·  " +
                    root.mappedCount + " mapped"
                  : "Looking for a mouse…"
                color: Color.muted
                font.family: Style.font.family
                font.pixelSize: Style.font.bodySmall
              }
              // Only wireless mice report a battery, so this whole group
              // disappears rather than showing an empty reading.
              Text {
                visible: root.battery !== null
                text: "·"
                color: Color.muted
                font.family: Style.font.family
                font.pixelSize: Style.font.bodySmall
              }
              Text {
                visible: root.battery !== null
                text: {
                  if (!root.battery) return ""
                  var glyph = root.battery.charging ? "\uf0e7" : "\uf240"
                  return glyph + "  " + Devices.batteryLabel(root.battery)
                }
                color: root.battery && root.battery.low ? Color.urgent : Color.accent
                font.family: Style.font.family
                font.pixelSize: Style.font.bodySmall
                font.weight: Font.DemiBold
              }
            }
          }

          Item { Layout.fillWidth: true }

          // Device switcher, only when there is a choice to make.
          Repeater {
            model: root.devices.length > 1 ? root.devices : []
            Ui.Button {
              text: modelData.label
              bordered: true
              selected: index === root.deviceIndex
              onClicked: { root.deviceIndex = index; root.selectedCode = -1; root.configRev++ }
            }
          }
        }

        Rectangle {
          Layout.fillWidth: true
          implicitHeight: 1
          color: Qt.rgba(Color.foreground.r, Color.foreground.g, Color.foreground.b, 0.12)
        }

        // ---------------------------------------------------- body
        RowLayout {
          Layout.fillWidth: true
          Layout.fillHeight: true
          spacing: Style.space(4)

          // -------------------------------------------- diagram
          Item {
            id: diagram
            Layout.fillWidth: true
            Layout.fillHeight: true

            readonly property var buttons: root.canvasButtons(width, height)
            readonly property var placements: root.canvasPlacements(width, height, buttons)

            MouseCanvas {
              id: canvas
              anchors.fill: parent
              buttons: diagram.buttons
              placements: diagram.placements
              shell: root.shellRect(diagram.width, diagram.height)
              shapeName: root.shapeName
              hoveredCode: root.hoveredCode
              selectedCode: root.selectedCode
              mapped: root.mappedSet
              pulseCode: root.pulseCode
              battery: root.battery
              reveal: 0

              NumberAnimation {
                id: revealAnim
                target: canvas
                property: "reveal"
                from: 0; to: 1
                duration: 620
                easing.type: Easing.OutCubic
              }
            }

            // Clicking the shell itself selects the nearest button, so the
            // drawing is a hit target and not just a picture.
            MouseArea {
              anchors.fill: parent
              hoverEnabled: true
              acceptedButtons: Qt.LeftButton
              onPositionChanged: function (mouse) {
                var code = canvas.buttonAt(mouse.x, mouse.y, 22)
                if (code >= 0) root.hoveredCode = code
                else if (root.hoveredCode >= 0 && !chipHover.active) root.hoveredCode = -1
              }
              onExited: if (!chipHover.active) root.hoveredCode = -1
              onClicked: function (mouse) {
                var code = canvas.buttonAt(mouse.x, mouse.y, 22)
                if (code >= 0) root.selectButton(code)
              }
            }

            QtObject { id: chipHover; property bool active: false }

            // -------------------------------------------- chips
            Repeater {
              model: diagram.placements
              delegate: Rectangle {
                id: chip
                readonly property int code: modelData.code
                readonly property var resolved: root.resolvedFor(code)
                readonly property bool live: resolved.ok
                readonly property bool hot: root.hoveredCode === code || root.selectedCode === code
                readonly property var meta: root.buttonMeta(code)

                x: modelData.chip.x
                y: modelData.chip.y - modelData.chip.h / 2
                width: modelData.chip.w
                height: modelData.chip.h
                radius: Style.cornerRadius > 0 ? Style.cornerRadius : 5

                color: hot ? Qt.rgba(Color.accent.r, Color.accent.g, Color.accent.b, 0.16)
                           : (live ? Qt.rgba(Color.accent.r, Color.accent.g, Color.accent.b, 0.07)
                                   : Qt.rgba(Color.foreground.r, Color.foreground.g, Color.foreground.b, 0.045))
                border.width: 1
                border.color: hot ? Color.accent
                                  : (live ? Qt.rgba(Color.accent.r, Color.accent.g, Color.accent.b, 0.42)
                                          : Qt.rgba(Color.foreground.r, Color.foreground.g, Color.foreground.b, 0.16))

                opacity: canvas.reveal
                Behavior on color { ColorAnimation { duration: 110 } }

                ColumnLayout {
                  anchors.fill: parent
                  anchors.leftMargin: Style.space(3)
                  anchors.rightMargin: Style.space(3)
                  spacing: 0

                  Item { Layout.fillHeight: true }
                  // The button's identity leads. What it currently does is
                  // the second line: an unmapped button is not "unassigned",
                  // it still does whatever it always did.
                  Text {
                    Layout.fillWidth: true
                    text: chip.meta.role
                    color: Color.foreground
                    font.family: Style.font.family
                    font.pixelSize: Style.font.bodySmall
                    font.weight: Font.DemiBold
                    elide: Text.ElideRight
                    horizontalAlignment: modelData.side === "left" ? Text.AlignRight : Text.AlignLeft
                  }
                  Text {
                    Layout.fillWidth: true
                    text: chip.live
                      ? (chip.resolved.detail && chip.resolved.detail !== chip.resolved.label
                         ? chip.resolved.label + "  " + chip.resolved.detail
                         : chip.resolved.label)
                      : "default"
                    color: chip.live ? Color.accent
                                     : Qt.rgba(Color.muted.r, Color.muted.g, Color.muted.b, 0.75)
                    font.family: Style.font.family
                    font.pixelSize: Style.font.caption
                    font.italic: !chip.live
                    elide: Text.ElideRight
                    horizontalAlignment: modelData.side === "left" ? Text.AlignRight : Text.AlignLeft
                  }
                  Item { Layout.fillHeight: true }
                }

                MouseArea {
                  anchors.fill: parent
                  hoverEnabled: true
                  onEntered: { chipHover.active = true; root.hoveredCode = chip.code }
                  onExited: { chipHover.active = false; root.hoveredCode = -1 }
                  onClicked: root.selectButton(chip.code)
                }
              }
            }

            // Empty state.
            Text {
              anchors.centerIn: parent
              visible: root.devices.length === 0 && !root.busy
              text: "No mouse found.\nPlug one in and press Rescan."
              horizontalAlignment: Text.AlignHCenter
              color: Color.muted
              font.family: Style.font.family
              font.pixelSize: Style.font.body
            }
          }

          // -------------------------------------------- detect wizard
          Rectangle {
            Layout.preferredWidth: 320
            Layout.fillHeight: true
            visible: root.learning
            radius: Style.cornerRadius > 0 ? Style.cornerRadius : 6
            color: Qt.rgba(Color.accent.r, Color.accent.g, Color.accent.b, 0.06)
            border.width: 1
            border.color: Qt.rgba(Color.accent.r, Color.accent.g, Color.accent.b, 0.35)

            ColumnLayout {
              anchors.fill: parent
              anchors.margins: Style.space(4)
              spacing: Style.space(3)

              Text {
                Layout.fillWidth: true
                text: "Detecting buttons"
                color: Color.foreground
                font.family: Style.font.family
                font.pixelSize: Style.font.subtitle
                font.weight: Font.DemiBold
              }
              Text {
                Layout.fillWidth: true
                text: root.learnCurrent
                  ? "Step " + (root.learnStep + 1) + " of " + root.learnSteps.length
                  : ""
                color: Color.muted
                font.family: Style.font.family
                font.pixelSize: Style.font.caption
              }

              // The ask.
              Rectangle {
                Layout.fillWidth: true
                radius: Style.cornerRadius > 0 ? Style.cornerRadius : 5
                color: Qt.rgba(Color.accent.r, Color.accent.g, Color.accent.b, 0.14)
                border.color: Color.accent
                border.width: 1
                implicitHeight: promptText.implicitHeight + Style.space(6)

                Text {
                  id: promptText
                  anchors.fill: parent
                  anchors.margins: Style.space(3)
                  text: root.learnCurrent ? root.learnCurrent.prompt : ""
                  wrapMode: Text.WordWrap
                  horizontalAlignment: Text.AlignHCenter
                  verticalAlignment: Text.AlignVCenter
                  color: Color.accent
                  font.family: Style.font.family
                  font.pixelSize: Style.font.body
                  font.weight: Font.DemiBold
                }
              }

              Text {
                Layout.fillWidth: true
                text: "If your mouse has no such button, press Skip."
                wrapMode: Text.WordWrap
                color: Color.muted
                font.family: Style.font.family
                font.pixelSize: Style.font.caption
              }

              // What has been claimed so far, so a mis-press is visible
              // immediately rather than at the end.
              Ui.PanelSectionHeader {
                Layout.fillWidth: true
                Layout.topMargin: Style.space(2)
                text: "FOUND SO FAR"
              }

              Repeater {
                model: { root.learnRev; return root.learnSeen }
                delegate: RowLayout {
                  required property var modelData
                  Layout.fillWidth: true
                  spacing: Style.space(2)
                  Text {
                    text: Devices.buttonName(modelData)
                    color: Color.foreground
                    font.family: Style.font.family
                    font.pixelSize: Style.font.caption
                  }
                  Item { Layout.fillWidth: true }
                  Text {
                    text: {
                      root.learnRev
                      for (var place in root.learnLayout) {
                        if (root.learnLayout[place] === modelData) {
                          var spec = Profiles.places()[place]
                          return spec ? spec.role : place
                        }
                      }
                      return ""
                    }
                    color: Color.accent
                    font.family: Style.font.family
                    font.pixelSize: Style.font.caption
                  }
                }
              }

              Text {
                Layout.fillWidth: true
                visible: root.learnSeen.length === 0
                text: "nothing yet"
                color: Color.muted
                font.italic: true
                font.family: Style.font.family
                font.pixelSize: Style.font.caption
              }

              Item { Layout.fillHeight: true }

              RowLayout {
                Layout.fillWidth: true
                spacing: Style.space(2)
                Ui.Button {
                  text: "Cancel"
                  bordered: true
                  onClicked: root.cancelLearn()
                }
                Item { Layout.fillWidth: true }
                Ui.Button {
                  text: "Skip"
                  bordered: true
                  onClicked: root.skipLearnStep()
                }
                Ui.Button {
                  text: "Finish"
                  bordered: true
                  active: root.learnSeen.length > 0
                  onClicked: root.finishLearn()
                }
              }
            }
          }

          // -------------------------------------------- inspector
          Rectangle {
            Layout.preferredWidth: 320
            Layout.fillHeight: true
            visible: root.selectedCode >= 0 && !root.learning
            radius: Style.cornerRadius > 0 ? Style.cornerRadius : 6
            color: Qt.rgba(Color.foreground.r, Color.foreground.g, Color.foreground.b, 0.035)
            border.width: 1
            border.color: Qt.rgba(Color.foreground.r, Color.foreground.g, Color.foreground.b, 0.12)

            ActionPicker {
              anchors.fill: parent
              anchors.margins: Style.space(4)
              panel: root
            }
          }
        }

        // ---------------------------------------------------- footer
        Rectangle {
          Layout.fillWidth: true
          implicitHeight: 1
          color: Qt.rgba(Color.foreground.r, Color.foreground.g, Color.foreground.b, 0.12)
        }

        RowLayout {
          Layout.fillWidth: true
          spacing: Style.space(3)

          Text {
            Layout.fillWidth: true
            text: root.status !== "" ? root.status
                 : (root.dirty ? "Unsaved changes." : "Click a button on the mouse to map it.")
            color: root.statusBad ? Color.urgent : (root.dirty ? Color.accent : Color.muted)
            font.family: Style.font.family
            font.pixelSize: Style.font.bodySmall
            elide: Text.ElideRight
          }

          Ui.Button {
            text: root.learning ? "Cancel detect" : "Detect buttons"
            bordered: true
            selected: root.learning
            tooltipText: "Walk through each button so MouseMap learns which ones exist and where they are."
            onClicked: root.learning ? root.cancelLearn() : root.startLearn()
          }
          Ui.Button {
            text: "Rescan"
            bordered: true
            enabled: !root.busy
            onClicked: root.refresh()
          }
          Ui.Button {
            text: "Revert"
            bordered: true
            enabled: root.dirty && !root.busy
            onClicked: { root.selectedCode = -1; readConfigProc.running = true; root.dirty = false; root.say("") }
          }
          Ui.Button {
            text: root.busy ? "Applying…" : "Apply"
            bordered: true
            active: root.dirty
            enabled: root.dirty && !root.busy
            onClicked: root.applyNow()
          }
        }
      }
    }
  }

  // ------------------------------------------------------------ helpers

  function selectButton(code) {
    selectedCode = code
    draftCommand = bindingFor(code).command || ""
    capturing = false
  }

  // Role and protection flags for a code on the current device. The role
  // comes from the placed geometry rather than the code's conventional
  // meaning, so a button the user put on the right flank is labelled as
  // being on the right flank.
  function buttonMeta(code) {
    var placed = placedButtons
    for (var i = 0; i < placed.length; i++) {
      if (placed[i].code === code) {
        return {
          code: code, role: placed[i].role, side: placed[i].side,
          protected: Devices.isProtected(code), name: Devices.buttonName(code),
          isKey: Devices.isKeyTrigger(code)
        }
      }
    }
    return { code: code, role: Devices.defaultRole(code), protected: Devices.isProtected(code),
             name: Devices.buttonName(code), isKey: Devices.isKeyTrigger(code) }
  }
}
