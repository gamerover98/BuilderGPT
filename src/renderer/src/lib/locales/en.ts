/**
 * The English messages. Also the fallback, and for now the only locale.
 *
 * Flat and dotted rather than nested. A nested tree reads better in this file
 * and worse everywhere else: `t("doc.saveAs")` can be grepped for and found,
 * and the test that hunts for orphaned keys can compare two sets of strings
 * instead of walking a tree.
 *
 * Only the *renderer's* strings live here. Anything the main process phrases --
 * every `Failure.message`, every writer's complaint about a block with no
 * legacy id -- arrives already worded and is shown as it came. Translating
 * those would mean replacing the messages with error codes and rebuilding the
 * wording on this side: a different piece of work, and a bigger one.
 */

import type { Catalog } from "../i18n_core.js";

export const en = {
  "app.title": "Schematic AI Studio",

  "bridge.missing":
    "This page is not running inside the Schematic AI Studio desktop app, so the backend is " +
    "unavailable. Start it with `npm run dev` (or the packaged app) rather than " +
    "opening the dev-server URL in a browser.",

  "common.choose": "Choose…",
  "common.clear": "Clear",
  "common.dismiss": "Dismiss",
  "common.open": "Open",
  "common.reset": "Reset",
  "common.save": "Save",
  "common.close": "Close",
  "common.cancel": "Cancel",

  "settings.title": "Settings",
  "settings.openShortcut": "Settings (Ctrl+,)",
  "settings.keywords": "preferences options theme language api key",
  "settings.appearance": "Appearance",
  "settings.viewport": "Viewport",
  "settings.quality": "Quality",
  "settings.textures": "Textures & colours",
  "settings.providers": "Providers",
  "settings.theme": "Theme",
  "settings.theme.system": "Match the system",
  "settings.theme.light": "Light",
  "settings.theme.dark": "Dark",
  "settings.themeHint":
    "“Match the system” follows your desktop, and changes with it while the app is running.",
  "settings.language": "Language",
  "settings.language.en": "English",
  "settings.languageHint":
    "Applies to this window straight away. Messages from the schematic reader and writers are " +
    "not translated.",
  "settings.qualityHint":
    "These cost frame time, not accuracy — lower them if the viewport feels heavy on a large " +
    "schematic.",
  "settings.rebuildsHint":
    "These are baked into the texture atlas, so changing one rebuilds the preview. Everything " +
    "under Viewport and Quality applies to the next frame instead.",

  "sidebar.hide": "Hide the control panel",
  "sidebar.show": "Show the control panel",
  "sidebar.hideShortcut": "Hide the control panel (Ctrl+B)",
  "sidebar.showShortcut": "Show the control panel (Ctrl+B)",
  "sidebar.resize": "Resize the control panel",

  "viewport.label": "3D viewport",
  "viewport.cameraMode": "Camera mode",
  "viewport.orbit": "Orbit",
  "viewport.creative": "Creative",
  "viewport.orbitHint": "Orbit around the structure, and click to select",
  "viewport.creativeHint": "Fly through it — WASD, Space and Shift",
  "viewport.hudOrbit":
    "Left: pan · Right: rotate · Wheel: zoom · Click: select · Drag a face: resize · R: reset",
  "viewport.hudFlying":
    "WASD: move · Space/Shift: up, down · Ctrl: faster · Left: break · Right: place · Esc: release",
  "viewport.hudClickToFly": "Click the viewport to fly",
  "viewport.unavailable": "Preview unavailable.",
  "viewport.noAtlas": "The mesh arrived without a texture atlas and none is held.",
  "viewport.bounds": "Preview bounds center: ({center}) · size: ({size})",
  "viewport.dropTitle": "Drop to open",
  "viewport.dropTypes": ".schem or .schematic",

  "doc.new": "New…",
  "doc.open": "Open…",
  "doc.undo": "Undo",
  "doc.redo": "Redo",
  "doc.nothingToUndo": "Nothing to undo",
  "doc.nothingToRedo": "Nothing to redo",
  "doc.recent": "Recent",
  "start.title": "Nothing open",
  "start.lead": "Create a schematic to build in, or open one you already have.",
  "start.dropHint": "You can also drop a .schem or .schematic file anywhere on this view.",
  "start.chatHint": "Or describe what you want in the chat: with nothing open, a message builds the schematic instead of editing one.",
  "doc.openedJustNow": "just now",
  "doc.openedMinutes": "{count}m ago",
  "doc.openedHours": "{count}h ago",
  "doc.openedDays": "{count}d ago",
  "bar.blocks": "{count} blocks",
  "bar.editing": "Editing",
  "doc.untitled": "Untitled",
  "doc.notSaved": "Not saved yet",
  "doc.materials": "Materials",
  "doc.useAsBlock": "Make {block} the current block",
  "doc.moreMaterials": "…and {count} more",

  // The New / Save As dialog. `doc.version` comes before `doc.format` on
  // screen for the reason the component explains: the version decides which
  // containers exist, not the other way round.
  "doc.newTitle": "New schematic",
  "doc.saveAsTitle": "Save as",
  "doc.size": "Size",
  "doc.width": "Width (x)",
  "doc.height": "Height (y)",
  "doc.length": "Length (z)",
  "doc.volume": "{count} blocks",
  "doc.savingSize": "Saving {size} as it stands. Empty space around the build is trimmed on the way out.",
  "doc.version": "Minecraft",
  "doc.format": "Container",
  "doc.legacyEra": "legacy",
  "doc.legacyNote":
    "Before 1.13 blocks were numeric ids rather than names, so MCEdit is the only container that fits.",
  "doc.willBeNamed": "Suggested name: {name}",
  "doc.create": "Create",
  "doc.chooseLocation": "Choose location…",

  // The creative hotbar. Right-click a slot to put the picker's current
  // block in it, which is why the hint names both gestures.
  "inventory.title": "Blocks",
  "inventory.search": "Search blocks",
  "inventory.count": "{count} blocks",

  "hotbar.label": "Hotbar",
  "hotbar.slotHint": "Press {key} to hold this, right-click to replace it",

  "selection.legend": "Selection",
  "selection.size": "{width}×{height}×{length}",
  "selection.hint":
    "Click a block in the viewport to select it, Shift-click another to extend the box.",
  "selection.range":
    "({minX}, {minY}, {minZ}) → ({maxX}, {maxY}, {maxZ}) · {volume} blocks",
  "selection.all": "Select all",
  "selection.clear": "Clear",
  "selection.copy": "Copy",
  "selection.cut": "Cut",
  "selection.paste": "Paste",
  "selection.pasteNoClipboard": "Copy something first",
  "selection.pasteNoSelection": "Select where it should go",
  "selection.pasteHint": "Paste {width}×{height}×{length} at the selection's corner",
  "selection.clipboard": "Clipboard: {width}×{height}×{length}, {blocks} blocks",
  "selection.rotate90": "⟳ 90°",
  "selection.rotate90Hint":
    "Turn the selection a quarter clockwise — needs a square footprint",
  "selection.rotate180": "180°",
  "selection.rotate180Hint": "Turn the selection halfway round",
  "selection.flipX": "Flip X",
  "selection.flipXHint": "Reflect the selection east to west",
  "selection.flipZ": "Flip Z",
  "selection.flipZHint": "Reflect the selection north to south",
  "selection.block": "Block",
  "selection.fill": "Fill",
  "selection.fillHint": "Fill the selection",
  "selection.selectFirst": "Select a region first",
  "selection.replace": "Replace",
  "selection.replaceButton": "Replace with the block above",
  "selection.replaceHint": "Replace within the selection",

  "inspector.empty": "Click a block in the viewport to see what it is.",
  "inspector.title": "Inspector",
  "inspector.at": "at ({x}, {y}, {z})",
  "inspector.blockStates": "Block states",
  "inspector.blockStatesHint":
    "Changing one places the block again — undoable like any edit.",
  "inspector.noBlockStates": "This block has no block states.",
  "inspector.entityData": "{id} data",
  "inspector.noEntityData": "This block entity carries no data.",
  "inspector.nbtHint": "Each value keeps its NBT type, and each change is its own undo step.",
  "inspector.showRaw": "Show the raw tree",
  "inspector.hideRaw": "Hide the raw tree",
  "inspector.emptyTree": "(empty)",
  "inspector.notEditable": "A {type} cannot be edited here",

  "chat.legend": "Ask the AI",
  "chat.you": "You",
  "chat.ai": "AI",
  "chat.failed": "Failed",
  "chat.stopped": "Stopped",
  "chat.actsOnSelection": "Acts on your selection unless you say otherwise",
  "chat.actsOnAll": "Acts on the whole schematic — select a region to narrow it",
  "chat.placeholder": "Replace the cobblestone with stone…",
  "chat.send": "Send",
  "chat.stop": "Stop",
  "chat.memoryStarts": "The agent remembers from here",
  "chat.historyHint": "Conversations about this schematic",
  "chat.noHistory": "No other conversations yet",
  "chat.deleteChat": "Delete this conversation",
  "chat.restore": "Go back to this version",
  "chat.copyCode": "Copy",
  "chat.copied": "Copied",
  "chat.stopHint": "Stop this request; nothing will be changed",
  "chat.newChat": "New chat",
  "chat.newChatHint": "Forget what has been said so far and start over",
  "chat.undoThis": "Undo this",
  "chat.blocksChanged": "{count} blocks changed",
  "chat.andMore": "and {count} more",
  "chat.emptyTitle": "Ask for a change to the schematic you have open.",
  "chat.emptyBuildTitle": "Describe something to build, and it will be generated and opened.",
  "chat.buildPlaceholder": "A small birch cottage with a porch…",
  "chat.actsAsBuild": "Nothing is open, so this describes a schematic to build",
  "chat.build1": "A small stone watchtower with a spiral staircase",
  "chat.build2": "A wooden bridge with lanterns along the rails",
  "chat.build3": "A round fountain in a cobblestone plaza",
  "chat.example1": "Replace every cobblestone block with stone bricks",
  "chat.example2": "Add a flat roof over the selection",
  "chat.example3": "What is this build made of?",
  "chat.toolsUsed.one": "1 tool used",
  "chat.toolsUsed.other": "{count} tools used",

  // The trace: what a turn did, in order. `trace.wrote` covers both the prose
  // an agent writes between tool calls and the build script a generation
  // produces — from the reader's side they are the same thing, the model
  // writing something rather than doing something.
  "trace.request": "Request sent",
  "trace.reasoning": "Thinking",
  "trace.tool": "Tool",
  "trace.note": "Step",
  "trace.wrote": "Wrote",
  "trace.arguments": "Arguments",
  "trace.result": "Result",
  "trace.stepCount.one": "1 step so far",
  "trace.stepCount.other": "{count} steps so far",
  "chat.modelPickerHint": "Which model answers",
  "chat.modelSharedHint":
    "Generate uses this model too — there is one LLM configuration for the whole app.",
  "chat.remembered.one": "Follow-ups can refer back — the AI remembers this exchange.",
  "chat.remembered.other":
    "Follow-ups can refer back — the AI remembers the last {count} exchanges.",

  "provider.provider": "Provider",
  "provider.model": "Model name",
  "provider.baseUrl": "Base URL",
  "provider.baseUrlHint":
    "Only needed for a custom OpenAI-compatible endpoint. Leave it empty to use the provider's own.",
  "provider.apiKeyOptional": "API key (only for paid models)",
  "provider.keyStoredPlaceholder": "•••••••• stored",
  "provider.keyPlaceholder": "Paste your key",
  "provider.free": "Free ({count}) — no API key needed",
  "provider.paid": "Paid ({count}) — API key required",
  "provider.unknownPricing": "Pricing unknown ({count})",
  "provider.modelSummary": "{id} · {count} models available",
  "provider.textOnly": "· text only, no reference image",
  "provider.imageUnknown": "· image support unknown",
  "provider.fetchFailed": "Model list fetch failed — type the model id manually.",
  "provider.needsKey":
    "{model} is billed per token, so it needs a key. The free models in the list above do not.",
  "provider.keyStored": "A key is stored for {provider}. It is never sent back to this window.",
  "provider.addKey": "Add one in Settings",
  "provider.noEncryption":
    "OS-backed encryption is unavailable on this system, so keys are kept in memory for this " +
    "session only and are never written to disk.",
  "provider.contextTokens": "{count}k ctx",
  "provider.images": "images",
  "provider.cost": "${input}/${output} per M",

  "structure.legend": "Structure",
  "structure.version": "Game version",
  "structure.exportType": "Export type",
  "structure.description": "Description",
  "structure.descriptionPlaceholder": "Describe the structure you want to build...",
  "structure.image": "Optional reference image",
  "structure.noImage": "No image chosen",
  "structure.imageUnsupported": "Not supported by this model",
  "structure.imageHint":
    "{model} takes text only. Pick a model marked “images” to use a reference picture.",
  "structure.outputDir": "Output folder",
  "structure.outputHint":
    "A file of the same name is renamed with a timestamp before being replaced, never " +
    "overwritten.",
  "structure.default": "Default",
  "structure.generate": "Generate",
  "structure.usesModel": "Uses {model}, the model chosen in the chat.",
  "structure.rerender": "Re-render",
  "structure.rerenderHint": "Refresh the preview using the last schematic without regenerating",

  "preview.resourcePack": "Resource pack (.zip)",
  "preview.resourcePackPlaceholder": "Faithful 64x (bundled)",
  "preview.resourcePackHint":
    "A pack ships with the app and is used by default. Choosing your own takes priority, with " +
    "the bundled one filling in any textures it does not provide. Affects the preview only, " +
    "never the generated file.",
  "preview.biomeColors": "Biome colours",
  "preview.foliage": "Grass, leaves, vines",
  "preview.water": "Water",
  "preview.plains": "Plains",
  "preview.biomeHint":
    "Foliage (left) and water (right) ship greyscale and are tinted per biome — they are " +
    "separate colours in Minecraft, so they are separate here. Changing either rebuilds the " +
    "preview.",
  "preview.sunAzimuth": "Sun azimuth — {value}°",
  "preview.sunElevation": "Sun elevation — {value}°",
  "preview.maxDpr": "Max device pixel ratio — {value}",
  "preview.renderScale": "Render scale — {value}",
  "preview.maxDrawDistance": "Max draw distance — {value}",
  "preview.flySpeed": "Flight speed — {value} blocks/s",
  "preview.showGrid": "Show grid",
  "preview.wireframe": "Wireframe",
  "preview.ambientOcclusion": "Ambient occlusion",

  "artifacts.legend": "Generated files",
  "artifacts.empty": "Nothing generated yet.",
  "artifacts.preview": "Preview",
  "artifacts.reveal": "Reveal",

  "palette.label": "Commands",
  "palette.placeholder": "Type a command…",
  "palette.noMatch": "Nothing matches “{query}”.",

  "blocks.all": "all {count} blocks",
  "blocks.matches": "{count} of {total}",

  "recovery.title": "Unsaved work was found",
  "recovery.unnamed": "An unsaved schematic",
  "recovery.body":
    "{name} — {blocks} blocks, from {when}. The last session ended before it was saved.",
  "recovery.notOnDisk": "It has not been written to disk yet — save when you are happy with it.",
  "recovery.restore": "Restore it",
  "recovery.discard": "Discard",

  "tabs.label": "Sidebar panels",
  "tabs.chat": "Chat",
  "tabs.generate": "Generate",

  "group.file": "File",
  "group.recent": "Recent",
  "group.edit": "Edit",
  "group.view": "View",
  "group.ai": "AI",

  "command.new": "New schematic…",
  "command.new.keywords": "create blank empty start",
  "command.open": "Open schematic…",
  "command.open.keywords": "load import schem",
  "command.openRecent": "Open {name}",
  "command.save": "Save",
  "command.saveAs": "Save as…",
  "command.saveAs.keywords": "export format sponge mcedit",
  "command.close": "Close schematic",
  "command.close.keywords": "shut done finish put away",
  "command.undo": "Undo",
  "command.redo": "Redo",
  "command.selectAll": "Select the whole schematic",
  "command.selectAll.keywords": "selection everything",
  "command.copy": "Copy the selection",
  "command.cut": "Cut the selection",
  "command.paste": "Paste at the selection",
  "command.rotate90": "Rotate the selection 90°",
  "command.rotate90.keywords": "turn quarter clockwise",
  "command.rotate180": "Rotate the selection 180°",
  "command.rotate180.keywords": "turn half",
  "command.mirrorX": "Mirror the selection east to west",
  "command.mirrorX.keywords": "flip reflect x",
  "command.mirrorZ": "Mirror the selection north to south",
  "command.mirrorZ.keywords": "flip reflect z",
  "command.clearSelection": "Clear the selection",
  "command.cameraOrbit": "Camera: orbit",
  "command.cameraOrbit.keywords": "turntable rotate",
  "command.cameraFly": "Camera: Creative flight",
  "command.cameraFly.keywords": "wasd walk fly first person",
  "command.showTools": "Show the selection tools",
  "command.showTools.keywords": "panel palette fill replace floating window",
  "command.hideInspector": "Hide the inspector",
  "command.showInspector": "Show the inspector",
  "command.showInspector.keywords": "inspector block state nbt properties floating window",
  "command.hideTools": "Hide the selection tools",
  "command.hideGrid": "Hide the grid",
  "command.showGrid": "Show the grid",
  "command.wireframeOff": "Turn off wireframe",
  "command.wireframeOn": "Turn on wireframe",
  "command.newChat": "Start a new chat",
  "command.newChat.keywords": "forget conversation reset clear",
  "command.stopAgent": "Stop the AI",
  "command.stopAgent.keywords": "cancel abort",

  "task.restoring": "Going back",
  "task.undoing": "Undoing",
  "task.redoing": "Redoing",
  "task.placingBlock": "Placing a block",
  "task.breakingBlock": "Breaking a block",
  "task.changingBlockState": "Changing a block state",
  "task.editingNbt": "Editing block entity data",
  "task.pasting": "Pasting",
  "task.transforming": "Transforming the selection",
  "task.filling": "Filling the selection",
  "task.replacing": "Replacing blocks",
  "task.copying": "Copying the selection",
  "task.cutting": "Cutting the selection",
  "task.savingLayout": "Saving the panel layout",
  "task.rendering": "Rendering the schematic",
  "task.openingChooser": "Opening the schematic chooser",
  "task.openingPicker": "Opening the file chooser",
  "task.opening": "Opening the schematic",
  "task.saving": "Saving the schematic",
  "task.creating": "Creating the schematic",
  "task.choosingSaveLocation": "Choosing where to save",
  "task.generating": "Generating the structure",
  "task.recovering": "Recovering unsaved work",
  "task.confirming": "Asking about unsaved changes",
  "task.closing": "Closing the schematic",
  "task.pickingBlock": "Picking up the block",

  "status.failed": "{doing}: {message}",
  "status.notOnDisk": "{name} does not come from a file on disk.",
  "status.notASchematic": "{name} is not a schematic — open a .schem or .schematic.",
  "status.recovered": "Recovered your unsaved work.",
  "status.recoveredNamed": "Recovered your unsaved work on {name}.",
  "status.copied": "Copied {count} blocks.",
  "status.cut": "Cut {count} blocks.",
  "status.nothingMatched": "No blocks matched, so nothing changed.",
  "status.restored.one": "Went back 1 edit. The conversation before it was kept.",
  "status.restored.other": "Went back {count} edits. The conversation before it was kept.",
  "status.created": "New schematic created.",
  "status.saved": "Saved {name}",
  "status.cropped": "Trimmed to fit the build: {from} → {to}",
  "status.degraded":
    "{count} block type(s) cannot keep their block state in this format and will come back " +
    "changed: {blocks}",
  "status.backedUp": "The previous file of that name was kept as {name}",
  "status.droppedBlocks":
    "{count} block type(s) were left out because they are not in block_id_list.txt: {blocks}",
  "status.droppedAndMore": ", and {count} more",
  "status.emptyBlock": "(empty)",
} as const satisfies Catalog;
