import QtQuick
import qs.Commons
import "Profiles.js" as Profiles

// The diagram: shell silhouette, button hotspots, and the leader lines out
// to the label chips. Chips themselves are real Items owned by the panel
// so they can take hover and clicks; everything vector lives here.
//
// Nothing in here decides where anything goes. The panel hands down
// `buttons` and `placements` already solved in canvas pixels, so the
// drawing and the hit-testing can never disagree about where a button is.
//
// The shell is drawn from the same halfWidthAt() the anchors come from, so
// the click panels, the seam and the flank buttons all meet the outline
// exactly rather than being separately fudged into place.
Canvas {
  id: root

  // Geometry, all in canvas pixels.
  property var buttons: []          // [{ code, x, y, side, kind, role }]
  property var placements: []       // Leaders.layout() output
  property rect shell: Qt.rect(0, 0, 1, 1)
  property string shapeName: "generic"

  // Interaction state.
  property int hoveredCode: -1
  property int selectedCode: -1
  property var mapped: ({})         // code -> true when the button is bound
  property int pulseCode: -1        // flashes during a learn pass

  // Normalized battery from Devices.matchBattery, or null for a wired
  // mouse that has nothing to report.
  property var battery: null
  onBatteryChanged: requestPaint()

  // Entrance animation: leaders draw outward from the shell.
  property real reveal: 1.0

  readonly property color line: Color.foreground
  readonly property color accent: Color.accent

  onButtonsChanged: requestPaint()
  onPlacementsChanged: requestPaint()
  onHoveredCodeChanged: requestPaint()
  onSelectedCodeChanged: requestPaint()
  onMappedChanged: requestPaint()
  onRevealChanged: requestPaint()
  onPulseCodeChanged: requestPaint()
  onShellChanged: requestPaint()
  onShapeNameChanged: requestPaint()

  function alpha(c, a) { return Qt.rgba(c.r, c.g, c.b, a) }

  // Box coordinates -> canvas pixels.
  function bx(x) { return shell.x + (x / Profiles.BOX_W) * shell.width }
  function by(y) { return shell.y + (y / Profiles.BOX_H) * shell.height }

  // Canvas x of the shell edge at a given box y.
  function edgeX(boxY, side) {
    var half = Profiles.halfWidthAt(shapeName, boxY, side)
    return bx(Profiles.BOX_W / 2 + (side === "left" ? -half : half))
  }

  // The seam dividing the click panels from the palm. It dips toward the
  // middle like a real shell parting line, and is defined in terms of the
  // outline so both ends land exactly on the edge.
  readonly property real seamBoxY: Profiles.splitY(shapeName)

  function seamPoint(t) {
    var boxY = seamBoxY + Math.sin(t * Math.PI) * 6.5
    var side = t < 0.5 ? "left" : "right"
    var half = Profiles.halfWidthAt(shapeName, boxY, side)
    return { x: bx(Profiles.BOX_W / 2 + (t - 0.5) * 2 * half), y: by(boxY) }
  }

  // ---------------------------------------------------------------- paths

  // Smooth a polyline by running a quadratic through the midpoint of each
  // pair. With enough samples this reads as a continuous curve.
  function tracePath(ctx, points, close) {
    if (points.length < 3) return
    var mid = { x: (points[0].x + points[1].x) / 2, y: (points[0].y + points[1].y) / 2 }
    ctx.moveTo(mid.x, mid.y)
    for (var i = 1; i < points.length - 1; i++) {
      var next = { x: (points[i].x + points[i + 1].x) / 2, y: (points[i].y + points[i + 1].y) / 2 }
      ctx.quadraticCurveTo(points[i].x, points[i].y, next.x, next.y)
    }
    if (close) {
      var back = { x: (points[points.length - 1].x + points[0].x) / 2,
                   y: (points[points.length - 1].y + points[0].y) / 2 }
      ctx.quadraticCurveTo(points[points.length - 1].x, points[points.length - 1].y, back.x, back.y)
      ctx.closePath()
    } else {
      ctx.lineTo(points[points.length - 1].x, points[points.length - 1].y)
    }
  }

  function shellPoints() {
    var raw = Profiles.outlinePoints(shapeName, 64)
    var out = []
    for (var i = 0; i < raw.length; i++) out.push({ x: bx(raw[i].x), y: by(raw[i].y) })
    return out
  }

  // The click-panel region: up the left edge to the nose, across, down the
  // right edge to the seam, then back along the seam. Traced as one closed
  // loop so it can be filled and clipped against.
  function panelPoints() {
    var steps = 22
    var out = []
    var i, boxY

    for (i = steps; i >= 0; i--) {          // left edge, seam -> nose
      boxY = (i / steps) * seamBoxY
      out.push({ x: edgeX(boxY, "left"), y: by(boxY) })
    }
    for (i = 0; i <= steps; i++) {          // right edge, nose -> seam
      boxY = (i / steps) * seamBoxY
      out.push({ x: edgeX(boxY, "right"), y: by(boxY) })
    }
    for (i = steps; i >= 0; i--) {          // seam, right -> left
      out.push(seamPoint(i / steps))
    }
    return out
  }

  // ---------------------------------------------------------------- paint

  onPaint: {
    var ctx = getContext("2d")
    ctx.reset()
    ctx.lineCap = "round"
    ctx.lineJoin = "round"

    drawGlow(ctx)
    drawShell(ctx)
    drawLeaders(ctx)
    drawHotspots(ctx)
  }

  // A wide, very faint accent wash behind the shell so the mouse sits in
  // its own pool of light instead of floating on a flat panel.
  function drawGlow(ctx) {
    var cx = shell.x + shell.width / 2
    var cy = shell.y + shell.height * 0.55
    var r = Math.max(shell.width, shell.height) * 0.72
    var g = ctx.createRadialGradient(cx, cy, 0, cx, cy, r)
    g.addColorStop(0, alpha(accent, 0.14))
    g.addColorStop(0.5, alpha(accent, 0.05))
    g.addColorStop(1, alpha(accent, 0))
    ctx.fillStyle = g
    ctx.fillRect(cx - r, cy - r, r * 2, r * 2)
  }

  function drawShell(ctx) {
    var outline = shellPoints()

    // Contact shadow: the same silhouette a few pixels down, stroked at
    // widening radii. Canvas has no blur, so a handful of fading strokes
    // stands in for one.
    ctx.save()
    ctx.translate(0, shell.height * 0.012)
    for (var s = 5; s >= 1; s--) {
      ctx.beginPath()
      tracePath(ctx, outline, true)
      ctx.strokeStyle = Qt.rgba(0, 0, 0, 0.05)
      ctx.lineWidth = s * 3
      ctx.stroke()
    }
    ctx.restore()

    // Body.
    ctx.beginPath()
    tracePath(ctx, outline, true)
    var body = ctx.createLinearGradient(0, shell.y, 0, shell.y + shell.height)
    body.addColorStop(0, alpha(line, 0.13))
    body.addColorStop(0.5, alpha(line, 0.065))
    body.addColorStop(1, alpha(line, 0.028))
    ctx.fillStyle = body
    ctx.fill()

    // Click panels sit slightly proud of the palm, so they catch a touch
    // more light. Filling the region is what makes the top of the shell
    // read as two buttons rather than a line drawn across a blob.
    var panel = panelPoints()
    ctx.beginPath()
    tracePath(ctx, panel, true)
    var panelFill = ctx.createLinearGradient(0, shell.y, 0, by(seamBoxY))
    panelFill.addColorStop(0, alpha(line, 0.10))
    panelFill.addColorStop(1, alpha(line, 0.02))
    ctx.fillStyle = panelFill
    ctx.fill()

    drawWheel(ctx)
    drawFlankButtons(ctx)
    drawBattery(ctx)

    // Parting line between the click panels, drawn as a dark gap with a
    // hairline highlight down one side so it reads as a moulded seam.
    var cx = shell.x + shell.width / 2
    var splitTop = by(Profiles.BOX_H * 0.02)
    var splitBottom = seamPoint(0.5).y
    ctx.beginPath()
    ctx.moveTo(cx, splitTop)
    ctx.lineTo(cx, splitBottom)
    ctx.strokeStyle = alpha(Color.background, 0.85)
    ctx.lineWidth = 2.6
    ctx.stroke()
    ctx.beginPath()
    ctx.moveTo(cx + 1.1, splitTop)
    ctx.lineTo(cx + 1.1, splitBottom)
    ctx.strokeStyle = alpha(line, 0.20)
    ctx.lineWidth = 1
    ctx.stroke()

    // Seam across the shell.
    ctx.beginPath()
    var seam = []
    for (var i = 0; i <= 26; i++) seam.push(seamPoint(i / 26))
    tracePath(ctx, seam, false)
    ctx.strokeStyle = alpha(Color.background, 0.6)
    ctx.lineWidth = 2.2
    ctx.stroke()
    ctx.beginPath()
    tracePath(ctx, seam, false)
    ctx.strokeStyle = alpha(line, 0.30)
    ctx.lineWidth = 1
    ctx.stroke()

    // Outline last so nothing overdraws it.
    ctx.beginPath()
    tracePath(ctx, outline, true)
    ctx.strokeStyle = alpha(line, 0.46)
    ctx.lineWidth = 1.6
    ctx.stroke()

    drawRimLight(ctx)
  }

  // A brighter arc along the upper-left of the outline. One light source,
  // top-left, consistent with the body gradient.
  function drawRimLight(ctx) {
    var pts = []
    var steps = 30
    for (var i = 0; i <= steps; i++) {
      var boxY = (i / steps) * Profiles.BOX_H * 0.55
      pts.push({ x: edgeX(boxY, "left"), y: by(boxY) })
    }
    ctx.beginPath()
    tracePath(ctx, pts, false)
    var g = ctx.createLinearGradient(0, shell.y, 0, by(Profiles.BOX_H * 0.55))
    g.addColorStop(0, alpha(line, 0.0))
    g.addColorStop(0.35, alpha(line, 0.38))
    g.addColorStop(1, alpha(line, 0.0))
    ctx.strokeStyle = g
    ctx.lineWidth = 1.5
    ctx.stroke()
  }

  function roundedRect(ctx, x, y, w, h, r) {
    var radius = Math.min(r, w / 2, h / 2)
    ctx.beginPath()
    ctx.moveTo(x + radius, y)
    ctx.arcTo(x + w, y, x + w, y + radius, radius)
    ctx.arcTo(x + w, y + h, x + w - radius, y + h, radius)
    ctx.arcTo(x, y + h, x, y + h - radius, radius)
    ctx.arcTo(x, y, x + radius, y, radius)
    ctx.closePath()
  }

  function drawWheel(ctx) {
    var cx = shell.x + shell.width / 2
    var top = by(Profiles.BOX_H * 0.125)
    var bottom = by(Profiles.BOX_H * 0.30)
    var w = Math.max(6, shell.width * 0.115)
    var h = bottom - top

    // Recessed well the wheel sits in.
    roundedRect(ctx, cx - w / 2 - 2.5, top - 2.5, w + 5, h + 5, (w + 5) / 2)
    ctx.fillStyle = alpha(Color.background, 0.7)
    ctx.fill()
    ctx.strokeStyle = alpha(line, 0.18)
    ctx.lineWidth = 1
    ctx.stroke()

    // The wheel itself, lit from the left like everything else.
    roundedRect(ctx, cx - w / 2, top, w, h, w / 2)
    var wheel = ctx.createLinearGradient(cx - w / 2, 0, cx + w / 2, 0)
    wheel.addColorStop(0, alpha(accent, 0.16))
    wheel.addColorStop(0.42, alpha(accent, 0.38))
    wheel.addColorStop(1, alpha(accent, 0.12))
    ctx.fillStyle = wheel
    ctx.fill()

    // Ridges, clipped to the wheel so they cannot spill into the well.
    ctx.save()
    roundedRect(ctx, cx - w / 2, top, w, h, w / 2)
    ctx.clip()
    ctx.strokeStyle = alpha(Color.background, 0.38)
    ctx.lineWidth = 1
    var ridges = 7
    for (var i = 1; i < ridges; i++) {
      var y = top + (h * i) / ridges
      ctx.beginPath()
      ctx.moveTo(cx - w / 2, y)
      ctx.lineTo(cx + w / 2, y)
      ctx.stroke()
    }
    ctx.restore()

    roundedRect(ctx, cx - w / 2, top, w, h, w / 2)
    ctx.strokeStyle = alpha(accent, 0.5)
    ctx.lineWidth = 1.1
    ctx.stroke()
  }

  // Battery, drawn into the palm where a charge LED usually sits.
  //
  // Putting it on the shell rather than only in the header means the
  // reading belongs to the mouse you are looking at, which matters as soon
  // as a second mouse is connected.
  function drawBattery(ctx) {
    if (!battery || battery.percent < 0) return

    var cx = shell.x + shell.width / 2
    var cy = by(Profiles.BOX_H * 0.74)
    var w = shell.width * 0.40
    var h = Math.max(7, shell.height * 0.035)
    var r = h * 0.34
    var x = cx - w / 2
    var y = cy - h / 2
    var tint = battery.low ? Color.urgent : accent

    // Shell of the cell, plus the little terminal nub on the right.
    roundedRect(ctx, x, y, w, h, r)
    ctx.fillStyle = alpha(Color.background, 0.55)
    ctx.fill()
    ctx.strokeStyle = alpha(tint, 0.55)
    ctx.lineWidth = 1.2
    ctx.stroke()

    var nubW = Math.max(1.5, w * 0.028)
    roundedRect(ctx, x + w + 1.5, cy - h * 0.22, nubW, h * 0.44, nubW * 0.4)
    ctx.fillStyle = alpha(tint, 0.55)
    ctx.fill()

    // Charge level, inset so the fill never overlaps the outline.
    var pad = 2
    var innerW = (w - pad * 2) * Math.max(0, Math.min(1, battery.percent / 100))
    if (innerW > 0.5) {
      roundedRect(ctx, x + pad, y + pad, Math.max(innerW, r), h - pad * 2, Math.max(0, r - 1))
      var fill = ctx.createLinearGradient(x, 0, x + w, 0)
      fill.addColorStop(0, alpha(tint, 0.75))
      fill.addColorStop(1, alpha(tint, 0.45))
      ctx.fillStyle = fill
      ctx.fill()
    }

    // A bolt through the middle while charging, so the state reads without
    // needing the header.
    if (battery.charging) {
      var bw = h * 0.30
      var bh = h * 0.62
      ctx.beginPath()
      ctx.moveTo(cx + bw * 0.35, cy - bh / 2)
      ctx.lineTo(cx - bw * 0.55, cy + bh * 0.10)
      ctx.lineTo(cx - bw * 0.02, cy + bh * 0.10)
      ctx.lineTo(cx - bw * 0.35, cy + bh / 2)
      ctx.lineTo(cx + bw * 0.55, cy - bh * 0.10)
      ctx.lineTo(cx + bw * 0.02, cy - bh * 0.10)
      ctx.closePath()
      ctx.fillStyle = Color.background
      ctx.fill()
    }
  }

  // Flank buttons get a moulded shape hugging the outline rather than a
  // bare dot, so a thumb button looks like a thumb button.
  function drawFlankButtons(ctx) {
    for (var i = 0; i < buttons.length; i++) {
      var b = buttons[i]
      if (b.kind !== "flank") continue

      var live = !!mapped[b.code]
      var hot = b.code === hoveredCode || b.code === selectedCode
      var half = shell.height * 0.055
      var depth = Math.max(5, shell.width * 0.055)
      var inward = b.side === "left" ? 1 : -1

      ctx.save()
      // Clipping to the shell keeps the pad flush with the edge however
      // the silhouette curves away behind it.
      ctx.beginPath()
      tracePath(ctx, shellPoints(), true)
      ctx.clip()

      roundedRect(ctx, b.x - (inward > 0 ? 0 : depth), b.y - half, depth, half * 2, depth * 0.42)
      ctx.fillStyle = live ? alpha(accent, hot ? 0.42 : 0.26)
                           : alpha(line, hot ? 0.20 : 0.10)
      ctx.fill()
      ctx.strokeStyle = live ? alpha(accent, 0.7) : alpha(line, 0.34)
      ctx.lineWidth = 1
      ctx.stroke()
      ctx.restore()
    }
  }

  // Total length of a polyline, so reveal can trim it proportionally.
  function polyLength(points) {
    var total = 0
    for (var i = 1; i < points.length; i++) {
      total += Math.abs(points[i].x - points[i - 1].x) + Math.abs(points[i].y - points[i - 1].y)
    }
    return total
  }

  // Stroke a leader with rounded corners, cut short at `fraction` so the
  // whole set can animate outward from the shell on open.
  function strokeLeader(ctx, points, radius, fraction) {
    var budget = polyLength(points) * Math.max(0, Math.min(1, fraction))
    if (budget <= 0) return

    ctx.beginPath()
    ctx.moveTo(points[0].x, points[0].y)
    for (var i = 1; i < points.length; i++) {
      var from = points[i - 1]
      var to = points[i]
      var span = Math.abs(to.x - from.x) + Math.abs(to.y - from.y)

      if (budget < span) {
        var k = span > 0 ? budget / span : 0
        ctx.lineTo(from.x + (to.x - from.x) * k, from.y + (to.y - from.y) * k)
        budget = 0
        break
      }
      budget -= span

      // Round the corner into the following segment rather than drawing a
      // hard elbow; arcTo needs the next point to know which way to bend.
      if (radius > 0 && i < points.length - 1) {
        ctx.arcTo(to.x, to.y, points[i + 1].x, points[i + 1].y, radius)
      } else {
        ctx.lineTo(to.x, to.y)
      }
    }
    ctx.stroke()
  }

  function drawLeaders(ctx) {
    for (var i = 0; i < placements.length; i++) {
      var p = placements[i]
      var hot = p.code === hoveredCode || p.code === selectedCode
      var isMapped = !!mapped[p.code]

      ctx.strokeStyle = hot ? alpha(accent, 0.95)
                            : (isMapped ? alpha(accent, 0.40) : alpha(line, 0.24))
      ctx.lineWidth = hot ? 2.0 : 1.1
      strokeLeader(ctx, p.leader.points, p.leader.radius, reveal)

      // A dot where the leader meets the chip closes the line off and
      // stops it reading as if it runs under the label.
      if (reveal > 0.985) {
        var end = p.leader.points[p.leader.points.length - 1]
        ctx.beginPath()
        ctx.arc(end.x, end.y, hot ? 2.6 : 1.8, 0, Math.PI * 2)
        ctx.fillStyle = hot ? accent : (isMapped ? alpha(accent, 0.55) : alpha(line, 0.32))
        ctx.fill()
      }
    }
  }

  function drawHotspots(ctx) {
    for (var i = 0; i < buttons.length; i++) {
      var b = buttons[i]
      var hot = b.code === hoveredCode || b.code === selectedCode
      var isMapped = !!mapped[b.code]
      var pulsing = b.code === pulseCode
      var r = hot || pulsing ? 6.8 : 5.0

      if (isMapped || hot || pulsing) {
        var g = ctx.createRadialGradient(b.x, b.y, 0, b.x, b.y, r * 3.6)
        g.addColorStop(0, alpha(accent, pulsing ? 0.6 : (hot ? 0.40 : 0.20)))
        g.addColorStop(1, alpha(accent, 0))
        ctx.fillStyle = g
        ctx.fillRect(b.x - r * 3.6, b.y - r * 3.6, r * 7.2, r * 7.2)
      }

      ctx.beginPath()
      ctx.arc(b.x, b.y, r, 0, Math.PI * 2)
      if (isMapped || pulsing) {
        ctx.fillStyle = pulsing ? accent : alpha(accent, hot ? 0.95 : 0.82)
        ctx.fill()
        ctx.strokeStyle = alpha(Color.background, 0.8)
        ctx.lineWidth = 1.5
        ctx.stroke()
      } else {
        ctx.fillStyle = alpha(Color.background, 0.92)
        ctx.fill()
        ctx.strokeStyle = hot ? alpha(accent, 0.9) : alpha(line, 0.45)
        ctx.lineWidth = hot ? 2.0 : 1.3
        ctx.stroke()
      }
    }
  }

  // Nearest button within a forgiving radius, for click-to-select on the
  // shell itself. Returns -1 when the press was not near anything.
  function buttonAt(px, py, radius) {
    var best = -1
    var reach = radius || 18
    var bestDistance = reach * reach
    for (var i = 0; i < buttons.length; i++) {
      var dx = buttons[i].x - px
      var dy = buttons[i].y - py
      var d = dx * dx + dy * dy
      if (d < bestDistance) { bestDistance = d; best = buttons[i].code }
    }
    return best
  }
}
