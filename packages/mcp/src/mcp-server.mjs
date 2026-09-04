import { mkdir, readFile, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import { EDITOR_URL, GUIDANCE_PATH, PACKAGE_NAME, PACKAGE_VERSION } from "./config.mjs";

const id = z.string().min(1).max(160);
const optionalId = id.optional();
const folderPath = z.string().min(2).max(160)
  .regex(/^\/(?!\/)\S(?:[\s\S]*\S)?$/, "Use a canonical folder path with one leading slash and no surrounding whitespace, for example /my-folder.")
  .refine((value) => value !== "/." && value !== "/..", "Folder paths cannot use the reserved names /. or /..");
const color = z.string().regex(/^#?[0-9a-f]{3}(?:[0-9a-f]{3})?$/i, "Use a 3- or 6-digit hex color.");
const ASPECT_RATIO_INPUT_MAX_LENGTH = 80;
const aspectRatio = z.string().max(ASPECT_RATIO_INPUT_MAX_LENGTH)
  .regex(/^\d{1,39}:\d{1,39}$/, "Use a positive width:height ratio such as 4:5 or 16:9.")
  .refine((value) => {
    try {
      if (value.length > ASPECT_RATIO_INPUT_MAX_LENGTH) return false;
      const [width, height] = value.split(":").map((part) => BigInt(part));
      if (width <= 0n || height <= 0n) return false;
      const canvasHeight = Number((1080n * height + width / 2n) / width);
      return canvasHeight >= 180 && canvasHeight <= 3840;
    } catch {
      return false;
    }
  }, "The ratio must produce a canvas height between 180 and 3840 pixels at 1080 pixels wide.")
  .describe("Canvas ratio. Presets: 9:16, 2:3, 3:4, 4:5, 1:1, 4:3, 16:9. Other positive W:H ratios are reduced to canonical form and must yield a 180–3840 px canvas height at 1080 px wide. A project ratio is the default for new slides; an add_slide or update_slide ratio applies to that slide only.");
const unit = z.number().min(-0.5).max(1.5);
const positiveUnit = z.number().min(0.01).max(2.4);
const expectedRevision = z.number().int().min(0).optional().describe("Optional optimistic-concurrency guard from inspect_editor.");
const editSessionId = optionalId.describe("Edit session from begin_edit_session. Required for coordinated parallel editing.");
const targetProject = { editSessionId, projectId: optionalId, expectedRevision };
const targetSlide = { editSessionId, projectId: optionalId, slideId: optionalId, expectedRevision };
const fontId = z.union([id, z.null()]).optional().describe("Project font ID returned by import_font. Use null to restore the built-in font.");
const textFields = {
  text: z.string().max(4000).optional(), x: unit.optional(), y: unit.optional(), width: positiveUnit.optional(), height: positiveUnit.optional(),
  role: z.enum(["title", "subtitle", "body", "caption"]).optional().describe("Semantic size role. Recommended ranges: title 92-124, subtitle 68-84, body 54-68, caption 44-52."),
  size: z.number().min(20).max(180).optional(), style: z.enum(["plain", "outline", "boxed"]).optional(),
  outlineWidth: z.number().min(0).max(40).optional()
    .describe("Relative outline thickness. The default 12 renders at 14.4% of the font size; all values scale proportionally with the font."),
  color: color.optional(), background: z.enum(["white", "black"]).optional(),
  backgroundShape: z.enum(["lines", "full"]).optional(), align: z.enum(["left", "center", "right"]).optional(),
  fontId,
  fontWeight: z.number().int().min(1).max(1000).optional(),
  fontStyle: z.enum(["normal", "italic"]).optional(),
  fontVariationSettings: z.record(z.string().regex(/^[A-Za-z0-9]{4}$/), z.number()).optional()
    .describe("Variable-font axis settings. Only wght currently has guaranteed DOM, fitting, and exported-canvas parity; preserve but do not newly apply other axes."),
  rotation: z.number().min(-720).max(720).optional(), z: z.number().optional(),
};
const imageFields = {
  x: unit.optional(), y: unit.optional(), width: positiveUnit.optional(), height: positiveUnit.optional(),
  rotation: z.number().min(-720).max(720).optional(), z: z.number().optional(),
  cropX: z.number().min(0).max(0.95).optional(), cropY: z.number().min(0).max(0.95).optional(),
  cropW: z.number().min(0.05).max(1).optional(), cropH: z.number().min(0.05).max(1).optional(),
};

function backgroundSourceSchema(shape) {
  return z.object(shape).strict().refine(
    ({ backgroundColor, backgroundPath }) => !(backgroundColor && backgroundPath),
    { message: "backgroundColor and backgroundPath are mutually exclusive; choose one background source." },
  );
}

const definitions = new Map();

function textResult(value, summary = value) {
  return { content: [{ type: "text", text: typeof summary === "string" ? summary : JSON.stringify(summary) }], structuredContent: value };
}

function compactMutation(value) {
  const keys = ["id", "editSessionId", "editorId", "projectId", "aspectRatio", "canvasWidth", "canvasHeight", "folderPath", "slideId", "revision", "leaseExpiresAt", "purpose", "released", "opened", "createdSlideId", "createdTextId", "fittedTextBox", "createdImageId", "createdLayers", "assetId", "fontId", "localFontId", "existing", "repaired", "deletedAssetId", "deletedProjectId", "deletedSlideId", "deletedLayerIds", "updatedTextIds", "fittedTextBoxes", "updatedImageIds", "applied", "path", "bytes"];
  return Object.fromEntries(keys.flatMap((key) => {
    if (key === "folderPath" && Object.hasOwn(value || {}, key)) return [[key, value[key] ?? null]];
    return value?.[key] == null ? [] : [[key, value[key]]];
  }));
}

function clientIdentity(context, server) {
  return context?.mcpReq?.envelope?.clientInfo || server.server.getClientVersion?.() || null;
}

function absolutePath(value) {
  return isAbsolute(value) ? value : resolve(process.cwd(), value);
}

async function pathExists(value) {
  try { await stat(value); return true; } catch (error) { if (error.code === "ENOENT") return false; throw error; }
}

function operationLabel(toolName) {
  return ({
    create_project: "Creating a project…", update_project: "Updating the project…", move_project: "Moving the project…", delete_project: "Deleting a project…",
    open_project: "Opening a project…", add_slide: "Adding a slide…", update_slide: "Updating a slide…",
    duplicate_slide: "Duplicating a slide…", reorder_slides: "Reordering slides…", delete_slide: "Deleting a slide…",
    add_text: "Adding text…", update_text: "Updating text…", fit_text_boxes: "Fitting text boxes…", import_font: "Adding a local font…", import_asset: "Importing a local image…",
    update_asset: "Updating an image asset…", delete_asset: "Deleting an image asset…", add_image: "Placing an image…",
    update_image: "Updating an image…", delete_layers: "Deleting layers…", duplicate_layers: "Duplicating layers…",
    reorder_layers: "Reordering layers…", undo: "Undoing the last edit…", redo: "Redoing the last edit…",
    set_view: "Updating the editor view…", render_slide: "Rendering the slide…",
  })[toolName] || "Editing in CarouselBot…";
}

async function browserOperation(companion, toolName, args) {
  const { editSessionId: sessionId, ...toolArgs } = args;
  const definition = definitions.get(toolName);
  const operation = await prepareOperation(companion, toolName, toolArgs, sessionId);
  return companion.call("browser", { toolName, operation, label: operationLabel(toolName), editSessionId: sessionId, mutating: Boolean(definition?.mutating) });
}

async function prepareOperation(companion, toolName, args, editSessionId = null) {
  const operation = { ...args };
  if (operation.backgroundPath) {
    const prepared = await companion.call("prepare_media", { path: absolutePath(operation.backgroundPath) });
    operation.mediaId = prepared.mediaId;
    delete operation.backgroundPath;
  }
  if (toolName === "import_asset") {
    const prepared = await companion.call("prepare_media", { path: absolutePath(operation.path) });
    operation.mediaId = prepared.mediaId;
    delete operation.path;
  }
  if (toolName === "import_font") {
    const prepared = await companion.call("prepare_font", { localFontId: operation.localFontId, editSessionId });
    operation.font = prepared.font;
    operation.fontMediaId = prepared.fontMediaId;
  }
  const type = ({
    create_project: "project.create", open_project: "project.open", update_project: "project.update", move_project: "project.move", delete_project: "project.delete",
    add_slide: "slide.add", update_slide: "slide.update", duplicate_slide: "slide.duplicate", reorder_slides: "slide.reorder", delete_slide: "slide.delete",
    add_text: "text.add", update_text: "text.update", fit_text_boxes: "text.fit", import_font: "font.import", list_project_fonts: "font.list", import_asset: "asset.import", update_asset: "asset.update", delete_asset: "asset.delete",
    add_image: "image.add", update_image: "image.update", delete_layers: "layer.delete", duplicate_layers: "layer.duplicate", reorder_layers: "layer.reorder",
    undo: "history.undo", redo: "history.redo", set_view: "view.update", render_slide: "slide.render", inspect_editor: "editor.inspect",
  })[toolName];
  if (!type) throw new Error(`Unsupported operation tool: ${toolName}`);
  return { type, ...operation };
}

export async function createCarouselBotMcpServer(companion) {
  const guidance = await readFile(GUIDANCE_PATH, "utf8");
  let guidanceRead = false;
  let identifiedAs = null;
  const server = new McpServer({ name: PACKAGE_NAME, version: PACKAGE_VERSION }, {
    instructions: `First call list_editors and use the registered local browser tab. Never open or connect CarouselBot through a sandboxed agent browser. If no editor is listed, retry briefly because browser reconnection is automatic, then ask the user to open ${EDITOR_URL} in their normal browser and click Connect AI. Companion compatibility and reconnects are automatic. Do not parallel-retry an action that reports an unsupported internal action; retry once after list_editors so automatic recovery can finish. Never restart a healthy companion for a transient editor disconnect. Before edits call get_design_guidance, then begin_edit_session; pass editSessionId to every edit and end it in cleanup. Parallel editing workers require distinct editor sessions. Use render_slide to inspect actual pixels.`,
    capabilities: { tools: {}, resources: {} },
  });

  async function identify(context) {
    const info = clientIdentity(context, server);
    const signature = info ? `${info.name || "MCP agent"}@${info.version || "unknown"}` : null;
    if (signature && signature !== identifiedAs) {
      identifiedAs = signature;
      await companion.identify(info.name, info.version);
    }
  }

  function register(name, description, inputSchema, handler, annotations = {}) {
    const normalizedAnnotations = { openWorldHint: false, ...annotations };
    const guidanceExempt = new Set(["select_editor", "begin_edit_session", "end_edit_session", "open_project", "set_view", "show_notification"]);
    definitions.set(name, { inputSchema, handler, mutating: !normalizedAnnotations.readOnlyHint && !guidanceExempt.has(name) });
    server.registerTool(name, { title: name.split("_").map((part) => part[0].toUpperCase() + part.slice(1)).join(" "), description, inputSchema, annotations: normalizedAnnotations }, async (args, context) => {
      await identify(context);
      if (definitions.get(name).mutating && !guidanceRead) throw new Error("Call get_design_guidance before changing slides. This one-time step prevents avoidable clipping and unattractive defaults.");
      const value = await handler(args, context);
      if (value?.__rawMcpResult) {
        const { __rawMcpResult, ...result } = value;
        return result;
      }
      return textResult(value, annotations.readOnlyHint ? value : compactMutation(value));
    });
  }

  const readGuidanceResource = async (uri) => {
    guidanceRead = true;
    return { contents: [{ uri: uri.href, mimeType: "text/markdown", text: guidance }] };
  };
  server.registerResource("carouselbot-design-guidance", "carouselbot://guidance/design", {
    title: "CarouselBot design guidance", description: "Required visual-quality and text-box safety guidance.", mimeType: "text/markdown",
  }, readGuidanceResource);
  server.registerResource("slide-studio-design-guidance", "slide-studio://guidance/design", {
    title: "CarouselBot design guidance (legacy URI)", description: "Backward-compatible alias for CarouselBot design guidance.", mimeType: "text/markdown",
  }, readGuidanceResource);

  register("get_design_guidance", "Read the required compact design and clipping guidance. Call once before any mutation.", z.object({}).strict(), async () => {
    guidanceRead = true;
    return { __rawMcpResult: true, content: [{ type: "text", text: guidance }], structuredContent: { read: true } };
  }, { readOnlyHint: true, idempotentHint: true });

  register("list_editors", "Check the user's real local browser connection and show which registered CarouselBot tab this session targets. Call this instead of opening a sandboxed browser.", z.object({}).strict(), () => companion.call("list_editors"), { readOnlyHint: true });
  register("select_editor", "Select a connected browser tab for this MCP session.", z.object({ editorId: id }).strict(), ({ editorId }) => companion.call("select_editor", { editorId }), { destructiveHint: false, idempotentHint: true });
  register("begin_edit_session", "Atomically reserve one browser tab and optionally one project for an editing agent. Use one session per parallel editing worker and pass editSessionId to every edit.", z.object({ editorId: optionalId, projectId: optionalId, purpose: z.string().min(1).max(160).optional() }).strict(), (args) => companion.call("begin_edit_session", args), { destructiveHint: false });
  register("end_edit_session", "Release a browser-tab/project reservation as soon as an editing task finishes or fails.", z.object({ editSessionId: id }).strict(), (args) => companion.call("end_edit_session", args), { destructiveHint: false, idempotentHint: true });
  register("list_edit_sessions", "List active edit reservations, their owners, projects, and lease expirations.", z.object({}).strict(), () => companion.call("list_edit_sessions"), { readOnlyHint: true });
  register("list_recent_operations", "Read the local sanitized operation audit. Text, prompts, paths, and image bytes are never logged.", z.object({ limit: z.number().int().min(1).max(200).default(50), projectId: optionalId, status: z.enum(["started", "ok", "error", "blocked"]).optional() }).strict(), (args) => companion.call("list_recent_operations", args), { readOnlyHint: true });
  register("inspect_editor", "Inspect projects, slides, assets, and every text/image layer without returning image bytes.", z.object({ ...targetSlide, includeAllProjects: z.boolean().default(true) }).strict(), (args) => browserOperation(companion, "inspect_editor", args), { readOnlyHint: true });
  register("list_local_fonts", "Search fonts installed on this computer. Returns opaque local font IDs and never filesystem paths. The user must enable local fonts in CarouselBot first.", z.object({ editSessionId, query: z.string().max(200).optional(), limit: z.number().int().min(1).max(200).default(80), cursor: z.string().max(2048).optional(), sort: z.enum(["recent_then_alphabetical", "alphabetical"]).default("recent_then_alphabetical") }).strict(), (args) => companion.call("list_local_fonts", args), { readOnlyHint: true });
  register("list_project_fonts", "List fonts already imported into one project, including whether each face is currently available.", z.object({ ...targetProject, projectId: id }).strict(), (args) => browserOperation(companion, "list_project_fonts", args), { readOnlyHint: true });
  register("show_notification", "Show a short visual notification in a connected editor for status or marketing demos.", z.object({ editSessionId, message: z.string().min(1).max(240), tone: z.enum(["agent", "success", "info", "error"]).default("agent") }).strict(), ({ editSessionId, ...args }) => companion.call("notify", { ...args, editSessionId }), { destructiveHint: false, idempotentHint: false });

  register("create_project", "Create an empty project without changing the user's current browser view. Choose an optional aspect ratio: use a documented preset or a positive integer W:H value; legacy/default projects use 9:16. Pass a canonical folderPath such as /my-folder to create it inside that folder; omit it or use null for the dashboard root.", z.object({ editSessionId, name: z.string().min(1).max(160), aspectRatio: aspectRatio.optional(), folderPath: folderPath.nullable().optional() }).strict(), (args) => browserOperation(companion, "create_project", args), { destructiveHint: false });
  register("open_project", "Explicitly navigate the browser to a project and optionally a specific slide without changing content. Use only when the user asks to show it.", z.object({ editSessionId, projectId: id, slideId: optionalId }).strict(), (args) => browserOperation(companion, "open_project", args), { destructiveHint: false, idempotentHint: true });
  register("update_project", "Rename a project.", z.object({ ...targetProject, name: z.string().min(1).max(160) }).strict(), (args) => browserOperation(companion, "update_project", args), { destructiveHint: true });
  register("move_project", "Move a project into a folder by canonical slash path, move it between folders, or move it back to the dashboard root with folderPath=null. Folder cards are derived from project membership, so empty folders disappear.", z.object({ ...targetProject, projectId: id, folderPath: folderPath.nullable() }).strict(), (args) => browserOperation(companion, "move_project", args), { destructiveHint: true });
  register("delete_project", "Delete a project from browser storage.", z.object({ ...targetProject, projectId: id }).strict(), (args) => browserOperation(companion, "delete_project", args), { destructiveHint: true });

  register("add_slide", "Add a slide using a solid backgroundColor or local backgroundPath. A backgroundPath with no aspectRatio adopts the source image's exact reduced ratio, scales it to the 1080-pixel canvas width, and exports only that canvas. A solid slide with no aspectRatio uses the project's default; omit both background sources to use #EEEDE7. Pass aspectRatio to override either default. The browser follows it only when that project is already visible.", backgroundSourceSchema({ ...targetProject, name: z.string().max(160).optional(), index: z.number().int().min(0).optional(), aspectRatio: aspectRatio.optional(), backgroundColor: color.optional(), backgroundPath: z.string().min(1).optional() }), (args) => browserOperation(companion, "add_slide", args), { destructiveHint: false });
  register("update_slide", "Rename a slide, change only that slide's optional aspectRatio, replace its background with either a solid backgroundColor or local backgroundPath, or change background pan/zoom. Ratio changes preserve layer proportions and centers. The two background sources are mutually exclusive. The browser follows it only when that project is already visible.", backgroundSourceSchema({ ...targetSlide, name: z.string().max(160).optional(), aspectRatio: aspectRatio.optional(), backgroundColor: color.optional(), backgroundPath: z.string().min(1).optional(), imageScale: z.number().min(1).max(3).optional(), imageX: unit.optional(), imageY: unit.optional() }), (args) => browserOperation(companion, "update_slide", args), { destructiveHint: true });
  register("duplicate_slide", "Duplicate a slide with all layers. The browser follows the copy only when that project is already visible.", z.object({ ...targetSlide, name: z.string().max(160).optional() }).strict(), (args) => browserOperation(companion, "duplicate_slide", args), { destructiveHint: false });
  register("reorder_slides", "Set the complete slide order using every slide ID exactly once.", z.object({ ...targetProject, slideIds: z.array(id).min(1) }).strict(), (args) => browserOperation(companion, "reorder_slides", args), { destructiveHint: true });
  register("delete_slide", "Delete one slide.", z.object({ ...targetSlide, slideId: id }).strict(), (args) => browserOperation(companion, "delete_slide", args), { destructiveHint: true });

  register("add_text", "Add a text layer. Choose a semantic role and a size within its readable range. Width is preserved while height is fitted automatically with safe padding; boxed text defaults to the preferred per-line background.", z.object({ ...targetSlide, ...textFields, text: z.string().min(1).max(4000) }).strict(), (args) => browserOperation(companion, "add_text", args), { destructiveHint: false });
  register("update_text", "Update one or more text layers. Every updated layer automatically keeps its width and refits its height with safe padding, so a render-fit-render loop is unnecessary.", z.object({ ...targetSlide, updates: z.array(z.object({ id, ...textFields }).strict()).min(1).max(100) }).strict(), (args) => browserOperation(companion, "update_text", args), { destructiveHint: true });
  register("fit_text_boxes", "Explicitly resize text boxes to their rendered content. add_text and update_text already fit height automatically; use mode=both only when you also want to shrink width.", z.object({ ...targetSlide, textIds: z.array(id).min(1).max(100), mode: z.enum(["height", "both"]).default("both") }).strict(), (args) => browserOperation(companion, "fit_text_boxes", args), { destructiveHint: true });
  register("import_font", "Add one installed font face to a project using a localFontId returned by list_local_fonts. Exact face bytes remain on this computer and duplicate imports are reused.", z.object({ ...targetProject, projectId: id, localFontId: id }).strict(), (args) => browserOperation(companion, "import_font", args), { destructiveHint: false });

  register("import_asset", "Import a local image file into the active project's reusable asset library. Image bytes stay local.", z.object({ ...targetSlide, path: z.string().min(1), name: z.string().max(160).optional() }).strict(), (args) => browserOperation(companion, "import_asset", args), { destructiveHint: false });
  register("update_asset", "Rename a reusable image asset.", z.object({ ...targetProject, assetId: id, name: z.string().min(1).max(160) }).strict(), (args) => browserOperation(companion, "update_asset", args), { destructiveHint: true });
  register("delete_asset", "Delete an asset and every placed instance that references it.", z.object({ ...targetProject, assetId: id }).strict(), (args) => browserOperation(companion, "delete_asset", args), { destructiveHint: true });
  register("add_image", "Place an imported asset as an image layer and optionally set geometry, crop, rotation, and stacking.", z.object({ ...targetSlide, assetId: id, ...imageFields }).strict(), (args) => browserOperation(companion, "add_image", args), { destructiveHint: false });
  register("update_image", "Update one or more placed image layers, including geometry, crop, rotation, and stacking.", z.object({ ...targetSlide, updates: z.array(z.object({ id, ...imageFields }).strict()).min(1).max(100) }).strict(), (args) => browserOperation(companion, "update_image", args), { destructiveHint: true });

  register("delete_layers", "Delete text and/or image layers by ID.", z.object({ ...targetSlide, layerIds: z.array(id).min(1).max(200) }).strict(), (args) => browserOperation(companion, "delete_layers", args), { destructiveHint: true });
  register("duplicate_layers", "Duplicate text and/or image layers with an optional normalized offset.", z.object({ ...targetSlide, layerIds: z.array(id).min(1).max(100), offsetX: z.number().min(-1).max(1).optional(), offsetY: z.number().min(-1).max(1).optional() }).strict(), (args) => browserOperation(companion, "duplicate_layers", args), { destructiveHint: false });
  register("reorder_layers", "Set the complete back-to-front layer order using every layer ID exactly once.", z.object({ ...targetSlide, layerIds: z.array(id).min(1).max(300) }).strict(), (args) => browserOperation(companion, "reorder_layers", args), { destructiveHint: true });
  register("undo", "Undo the latest project edit.", z.object(targetSlide).strict(), (args) => browserOperation(companion, "undo", args), { destructiveHint: true });
  register("redo", "Redo the latest undone project edit.", z.object(targetSlide).strict(), (args) => browserOperation(companion, "redo", args), { destructiveHint: true });
  register("set_view", "Open a project/slide and control editor-only canvas zoom or TikTok safe-area overlay.", z.object({ ...targetSlide, canvasZoom: z.number().min(0.2).max(3).optional(), showTikTokOverlay: z.boolean().optional() }).strict(), (args) => browserOperation(companion, "set_view", args), { destructiveHint: false, idempotentHint: true });

  register("render_slide", "Render and return the actual slide image for visual inspection. This does not persist the rendered file.", z.object({ ...targetSlide, width: z.number().int().min(180).max(1080).default(540), format: z.enum(["png", "jpeg"]).default("png"), quality: z.number().min(0.4).max(1).default(0.9) }).strict(), async (args) => {
    const rendered = await browserOperation(companion, "render_slide", args);
    return {
      content: [{ type: "image", data: rendered.data, mimeType: rendered.mimeType }, { type: "text", text: JSON.stringify({ slideId: args.slideId || null, width: rendered.width, height: rendered.height, temporary: true }) }],
      structuredContent: { slideId: args.slideId || null, width: rendered.width, height: rendered.height, mimeType: rendered.mimeType, temporary: true },
      __rawMcpResult: true,
    };
  }, { readOnlyHint: true });

  register("export_slide", "Render a full-resolution PNG and write it to a local path. Existing files are protected unless overwrite=true.", z.object({ ...targetSlide, outputPath: z.string().min(1), overwrite: z.boolean().default(false) }).strict(), async ({ outputPath, overwrite, ...target }) => {
    const rendered = await browserOperation(companion, "render_slide", { ...target, width: 1080, format: "png", quality: 1 });
    const path = absolutePath(outputPath);
    await mkdir(dirname(path), { recursive: true });
    return companion.call("write_export", { path, data: rendered.data, overwrite });
  }, { destructiveHint: true });

  register("export_project", "Render every slide at full resolution into a local directory. Existing files are protected unless overwrite=true.", z.object({ ...targetProject, outputDirectory: z.string().min(1), overwrite: z.boolean().default(false) }).strict(), async ({ outputDirectory, overwrite, ...target }) => {
    const inspected = await browserOperation(companion, "inspect_editor", { ...target, includeAllProjects: false });
    if (!inspected.project?.slides?.length) throw new Error("The project has no slides to export.");
    const directory = absolutePath(outputDirectory);
    await mkdir(directory, { recursive: true });
    const files = [];
    for (const slide of inspected.project.slides) {
      const rendered = await browserOperation(companion, "render_slide", { projectId: inspected.project.id, slideId: slide.id, width: 1080, format: "png", quality: 1 });
      const path = join(directory, `${String(slide.index + 1).padStart(2, "0")}-${rendered.filename}`);
      if (!overwrite && await pathExists(path)) throw new Error(`Export already exists: ${path}. Set overwrite=true only when intended.`);
      files.push(await companion.call("write_export", { path, data: rendered.data, overwrite }));
    }
    return { projectId: inspected.project.id, outputDirectory: directory, fileCount: files.length, files };
  }, { destructiveHint: true });

  const batchTools = [...definitions.entries()].filter(([, definition]) => definition.mutating).map(([name]) => name).filter((name) => !["export_slide", "export_project"].includes(name));
  register("apply_operations", "Apply many ordered editing operations in one compact tool call. Each edit still appears live in the browser.", z.object({ editSessionId, operations: z.array(z.object({ tool: z.enum(batchTools), arguments: z.record(z.string(), z.unknown()).default({}) }).strict()).min(1).max(100) }).strict(), async ({ editSessionId: sessionId, operations }) => {
    const items = [];
    for (const item of operations) {
      const definition = definitions.get(item.tool);
      if (!definition?.mutating) throw new Error(`Tool cannot be batched: ${item.tool}`);
      const args = definition.inputSchema.parse(item.arguments);
      const { editSessionId: _ignored, ...toolArgs } = args;
      items.push({ toolName: item.tool, operation: await prepareOperation(companion, item.tool, toolArgs, sessionId), label: operationLabel(item.tool) });
    }
    return companion.call("batch", { items, editSessionId: sessionId });
  }, { destructiveHint: true });

  return server;
}

export const createSlideStudioMcpServer = createCarouselBotMcpServer;
