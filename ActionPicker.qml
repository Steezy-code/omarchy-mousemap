import QtQuick
import QtQuick.Layouts
import qs.Commons
import qs.Ui as Ui
import "Actions.js" as Actions
import "Devices.js" as Devices

// What the selected button should do. Reads and writes through the panel
// rather than holding its own copy, so the diagram and this list can never
// disagree about what a button is bound to.
Item {
  id: root

  property var panel: null

  readonly property int code: panel ? panel.selectedCode : -1
  readonly property var meta: panel && code >= 0 ? panel.buttonMeta(code) : null
  readonly property var binding: panel && code >= 0 ? panel.bindingFor(code) : null
  readonly property string currentAction: binding ? binding.action : "none"
  readonly property bool isProtected: meta ? meta.protected : false

  ColumnLayout {
    anchors.fill: parent
    spacing: Style.space(3)

    // ---------------------------------------------------------- header
    ColumnLayout {
      Layout.fillWidth: true
      spacing: 2

      Text {
        Layout.fillWidth: true
        text: root.meta ? root.meta.role : ""
        color: Color.foreground
        font.family: Style.font.family
        font.pixelSize: Style.font.subtitle
        font.weight: Font.DemiBold
        elide: Text.ElideRight
      }
      Text {
        Layout.fillWidth: true
        text: root.meta ? root.meta.name + "  ·  code " + root.code : ""
        color: Color.muted
        font.family: Style.font.family
        font.pixelSize: Style.font.caption
      }
    }

    // A button whose onboard profile makes it type something is bound as a
    // key rather than a mouse button. Worth saying, because it explains why
    // the button stopped typing and why the binding is mouse-only.
    Rectangle {
      Layout.fillWidth: true
      visible: root.meta && root.meta.isKey === true
      radius: Style.cornerRadius > 0 ? Style.cornerRadius : 4
      color: Qt.rgba(Color.accent.r, Color.accent.g, Color.accent.b, 0.10)
      border.color: Qt.rgba(Color.accent.r, Color.accent.g, Color.accent.b, 0.35)
      border.width: 1
      implicitHeight: keyNote.implicitHeight + Style.space(4)

      Text {
        id: keyNote
        anchors.fill: parent
        anchors.margins: Style.space(2)
        text: "This button types a keystroke rather than sending a mouse button. "
            + "MouseMap catches it from this mouse only — your keyboard is unaffected."
        wrapMode: Text.WordWrap
        color: Color.accent
        font.family: Style.font.family
        font.pixelSize: Style.font.caption
      }
    }

    // Binding left or right click takes away the ability to click, which
    // includes the ability to undo it here. Say so before they do it.
    Rectangle {
      Layout.fillWidth: true
      visible: root.isProtected
      radius: Style.cornerRadius > 0 ? Style.cornerRadius : 4
      color: Qt.rgba(Color.urgent.r, Color.urgent.g, Color.urgent.b, 0.12)
      border.color: Qt.rgba(Color.urgent.r, Color.urgent.g, Color.urgent.b, 0.4)
      border.width: 1
      implicitHeight: warnText.implicitHeight + Style.space(4)

      Text {
        id: warnText
        anchors.fill: parent
        anchors.margins: Style.space(2)
        text: "This is a primary click. Rebinding it takes the click away everywhere, including in this window."
        wrapMode: Text.WordWrap
        color: Color.urgent
        font.family: Style.font.family
        font.pixelSize: Style.font.caption
      }
    }

    Rectangle {
      Layout.fillWidth: true
      implicitHeight: 1
      color: Qt.rgba(Color.foreground.r, Color.foreground.g, Color.foreground.b, 0.12)
    }

    // ---------------------------------------------------------- list
    Flickable {
      Layout.fillWidth: true
      Layout.fillHeight: true
      contentWidth: width
      contentHeight: actionColumn.implicitHeight
      clip: true
      boundsBehavior: Flickable.StopAtBounds

      ColumnLayout {
        id: actionColumn
        width: parent.width
        spacing: Style.space(1)

        Repeater {
          model: Actions.groups()

          ColumnLayout {
            id: groupBlock
            required property string modelData
            Layout.fillWidth: true
            spacing: Style.space(1)

            Ui.PanelSectionHeader {
              Layout.fillWidth: true
              Layout.topMargin: Style.space(2)
              text: groupBlock.modelData.toUpperCase()
            }

            Repeater {
              model: {
                var out = []
                var all = Actions.catalogue()
                for (var i = 0; i < all.length; i++) {
                  if (all[i].group === groupBlock.modelData) out.push(all[i])
                }
                return out
              }

              delegate: Rectangle {
                id: row
                required property var modelData
                readonly property bool chosen: root.currentAction === modelData.id
                Layout.fillWidth: true
                implicitHeight: rowText.implicitHeight + Style.space(4)
                radius: Style.cornerRadius > 0 ? Style.cornerRadius : 4
                color: chosen ? Qt.rgba(Color.accent.r, Color.accent.g, Color.accent.b, 0.16)
                              : (rowMouse.containsMouse
                                 ? Qt.rgba(Color.foreground.r, Color.foreground.g, Color.foreground.b, 0.07)
                                 : "transparent")
                border.width: chosen ? 1 : 0
                border.color: Qt.rgba(Color.accent.r, Color.accent.g, Color.accent.b, 0.45)

                RowLayout {
                  anchors.fill: parent
                  anchors.leftMargin: Style.space(3)
                  anchors.rightMargin: Style.space(3)
                  spacing: Style.space(2)

                  Text {
                    id: rowText
                    Layout.fillWidth: true
                    text: row.modelData.label
                    color: row.chosen ? Color.accent : Color.foreground
                    font.family: Style.font.family
                    font.pixelSize: Style.font.bodySmall
                    elide: Text.ElideRight
                  }
                  Text {
                    visible: row.modelData.kind === "chord" && !row.modelData.custom
                    text: Actions.keyLabel(row.modelData.mods, row.modelData.key)
                    color: Color.muted
                    font.family: Style.font.family
                    font.pixelSize: Style.font.caption
                  }
                }

                MouseArea {
                  id: rowMouse
                  anchors.fill: parent
                  hoverEnabled: true
                  onClicked: {
                    if (row.modelData.id === "none") root.panel.clearButton(root.code)
                    else root.panel.setAction(root.code, row.modelData.id)
                    root.panel.capturing = (row.modelData.id === "custom-key")
                  }
                }
              }
            }
          }
        }

        Item { Layout.preferredHeight: Style.space(3) }
      }
    }

    // ---------------------------------------------------------- custom key
    Rectangle {
      Layout.fillWidth: true
      visible: root.currentAction === "custom-key"
      radius: Style.cornerRadius > 0 ? Style.cornerRadius : 4
      implicitHeight: captureCol.implicitHeight + Style.space(4)
      color: panel && panel.capturing
        ? Qt.rgba(Color.accent.r, Color.accent.g, Color.accent.b, 0.14)
        : Qt.rgba(Color.foreground.r, Color.foreground.g, Color.foreground.b, 0.05)
      border.width: 1
      border.color: panel && panel.capturing
        ? Color.accent
        : Qt.rgba(Color.foreground.r, Color.foreground.g, Color.foreground.b, 0.16)

      ColumnLayout {
        id: captureCol
        anchors.fill: parent
        anchors.margins: Style.space(2)
        spacing: 2

        Text {
          Layout.fillWidth: true
          text: panel && panel.capturing ? "Listening — press a shortcut"
                                         : (root.binding && root.binding.key
                                            ? Actions.keyLabel(root.binding.mods, root.binding.key)
                                            : "No shortcut set")
          color: panel && panel.capturing ? Color.accent : Color.foreground
          font.family: Style.font.family
          font.pixelSize: Style.font.body
          font.weight: Font.DemiBold
          horizontalAlignment: Text.AlignHCenter
        }
        Text {
          Layout.fillWidth: true
          text: panel && panel.capturing ? "Esc cancels" : "Click to record a new one"
          color: Color.muted
          font.family: Style.font.family
          font.pixelSize: Style.font.caption
          horizontalAlignment: Text.AlignHCenter
        }
      }

      MouseArea {
        anchors.fill: parent
        onClicked: {
          root.panel.capturing = true
          captureSink.forceActiveFocus()
        }
      }

      // Focused only while recording, so the panel's own Escape handling
      // and any text field keep working the rest of the time.
      Item {
        id: captureSink
        focus: panel ? panel.capturing : false
        Keys.priority: Keys.BeforeItem
        Keys.onPressed: function (event) {
          if (!panel || !panel.capturing) return
          event.accepted = true

          if (event.key === Qt.Key_Escape) { panel.capturing = false; return }

          var sym = Actions.keysymFor(event.key, event.text)
          // A modifier on its own is the user still assembling the chord.
          if (sym === "") return

          panel.setChord(root.code, Actions.modsFromQt(event.modifiers), sym)
          panel.capturing = false
        }
      }
    }

    // ---------------------------------------------------------- custom command
    Rectangle {
      Layout.fillWidth: true
      visible: root.currentAction === "custom-command"
      radius: Style.cornerRadius > 0 ? Style.cornerRadius : 4
      implicitHeight: Style.spacing.controlHeight + Style.space(2)
      color: Qt.rgba(Color.foreground.r, Color.foreground.g, Color.foreground.b, 0.05)
      border.width: 1
      border.color: commandInput.activeFocus
        ? Color.accent
        : Qt.rgba(Color.foreground.r, Color.foreground.g, Color.foreground.b, 0.16)

      TextInput {
        id: commandInput
        anchors.fill: parent
        anchors.leftMargin: Style.space(3)
        anchors.rightMargin: Style.space(3)
        verticalAlignment: TextInput.AlignVCenter
        color: Color.foreground
        font.family: Style.font.family
        font.pixelSize: Style.font.bodySmall
        selectByMouse: true
        selectionColor: Qt.rgba(Color.accent.r, Color.accent.g, Color.accent.b, 0.35)
        clip: true

        // Bound one way only: re-reading on every keystroke would fight
        // the cursor. The panel is updated on edit instead.
        text: root.panel ? root.panel.draftCommand : ""
        onTextEdited: if (root.panel) root.panel.setCommand(root.code, text)

        Text {
          anchors.fill: parent
          verticalAlignment: Text.AlignVCenter
          visible: commandInput.text === ""
          text: "e.g. omarchy-capture-screenshot"
          color: Qt.rgba(Color.muted.r, Color.muted.g, Color.muted.b, 0.7)
          font: commandInput.font
        }
      }
    }

    // ---------------------------------------------------------- hint
    Text {
      Layout.fillWidth: true
      visible: text !== ""
      text: {
        var spec = Actions.byId(root.currentAction)
        return spec && spec.hint ? spec.hint : ""
      }
      wrapMode: Text.WordWrap
      color: Color.muted
      font.family: Style.font.family
      font.pixelSize: Style.font.caption
    }

    RowLayout {
      Layout.fillWidth: true
      spacing: Style.space(2)

      Ui.Button {
        text: "Clear"
        bordered: true
        enabled: root.currentAction !== "none"
        onClicked: root.panel.clearButton(root.code)
      }
      Item { Layout.fillWidth: true }
      Ui.Button {
        text: "Done"
        bordered: true
        onClicked: root.panel.selectedCode = -1
      }
    }
  }
}
