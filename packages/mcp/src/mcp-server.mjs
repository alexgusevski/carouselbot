import { mkdir, readFile, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import { GUIDANCE_PATH, PACKAGE_NAME, PACKAGE_VERSION, TEST_EDITOR_URL } from "./config.mjs";

const id = z.string().min(1).max(160);
const optionalId = id.optional();
const color = z.string().regex(/^#?[0-9a-f]{3}(?:[0-9a-f]{3})?$/i, "Use a 3- or 6-digit hex color.");
const unit = z.number().min(-0.5).max(1.5);
const positiveUnit = z.number().min(0.01).max(2.4);
const expectedRevision = z.number().int().min(0).optional().describe("Optional optimistic-concurrency guard from inspect_editor.");
const targetProject = { projectId: optionalId, expectedRevision };
const targetSlide = { projectId: optionalId, slideId: optionalId, expectedRevision };
const textFields = {
  text: z.string().max(4000).optional(), x: unit.optional(), y: unit.optional(), width: positiveUnit.optional(), height: positiveUnit.optional(),
  size: z.number().min(20).max(180).optional(), style: z.enum(["plain", "outline", "boxed"]).optional(),
  outlineWidth: z.number().min(0).max(40).optional(), color: color.optional(), background: z.enum(["white", "black"]).optional(),
  backgroundShape: z.enum(["lines", "full"]).optional(), align: z.enum(["left", "center", "right"]).optional(),
  rotation: z.number().min(-720).max(720).optional(), z: z.number().optional(),
};
const imageFields = {
  x: unit.optional(), y: unit.optional(), width: positiveUnit.optional(), height: positiveUnit.optional(),
  rotation: z.number().min(-720).max(720).optional(), z: z.number().optional(),
  cropX: z.number().min(0).max(0.95).optional(), cropY: z.number().min(0).max(0.95).optional(),
  cropW: z.number().min(0.05).max(1).optional(), cropH: z.number().min(0.05).max(1).optional(),
};

const definitions = new Map();

function textResult(value, summary = value) {
  return { content: [{ type: "text", text: typeof summary === "string" ? summary : JSON.stringify(summary) }], structuredContent: value };
}

function compactMutation(value) {
  const keys = ["projectId", "slideId", "revision", "opened", "createdSlideId", "createdTextId", "createdImageId", "assetId", "deletedProjectId", "deletedSlideId", "deletedLayerIds", "updatedTextIds", "updatedImageIds", "applied", "path", "bytes"];
  return Object.fromEntries(keys.flatMap((key) => value?.[key] == null ? [] : [[key, value[key]]]));
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
    create_project: "Creating a project…", update_project: "Updating the project…", delete_project: "Deleting a project…",
    open_project: "Opening a project…", add_slide: "Adding a slide…", update_slide: "Updating a slide…",
    duplicate_slide: "Duplicating a slide…", reorder_slides: "Reordering slides…", delete_slide: "Deleting a slide…",
    add_text: "Adding text…", update_text: "Updating text…", import_asset: "Importing a local image…",
    update_asset: "Updating an image asset…", delete_asset: "Deleting an image asset…", add_image: "Placing an image…",
    update_image: "Updating an image…", delete_layers: "Deleting layers…", duplicate_layers: "Duplicating layers…",
    reorder_layers: "Reordering layers…", undo: "Undoing the last edit…", redo: "Redoing the last edit…",
    set_view: "Updating the editor view…", render_slide: "Rendering the slide…",
  })[toolName] || "Editing in Slide Studio…";
}

async function browserOperation(companion, toolName, args) {
  const operation = await prepareOperation(companion, toolName, args);
  return companion.call("browser", { toolName, operation, label: operationLabel(toolName) });
}

async function prepareOperation(companion, toolName, args) {
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
  const type = ({
    create_project: "project.create", open_project: "project.open", update_project: "project.update", delete_project: "project.delete",
    add_slide: "slide.add", update_slide: "slide.update", duplicate_slide: "slide.duplicate", reorder_slides: "slide.reorder", delete_slide: "slide.delete",
    add_text: "text.add", update_text: "text.update", import_asset: "asset.import", update_asset: "asset.update", delete_asset: "asset.delete",
    add_image: "image.add", update_image: "image.update", delete_layers: "layer.delete", duplicate_layers: "layer.duplicate", reorder_layers: "layer.reorder",
    undo: "history.undo", redo: "history.redo", set_view: "view.update", render_slide: "slide.render", inspect_editor: "editor.inspect",
  })[toolName];
  if (!type) throw new Error(`Unsupported operation tool: ${toolName}`);
  return { type, ...operation };
}

export async function createSlideStudioMcpServer(companion) {
  const guidance = await readFile(GUIDANCE_PATH, "utf8");
  let guidanceRead = false;
  let identifiedAs = null;
  const server = new McpServer({ name: PACKAGE_NAME, version: PACKAGE_VERSION }, {
    instructions: `First call list_editors and use the registered local browser tab. Never open or connect Slide Studio through a sandboxed agent browser. If no editor is listed, ask the user to open ${TEST_EDITOR_URL} in their normal browser and click Connect AI. Call get_design_guidance before editing and use render_slide to inspect actual pixels.`,
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
    const guidanceExempt = new Set(["select_editor", "open_project", "set_view", "show_notification"]);
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

  server.registerResource("slide-studio-design-guidance", "slide-studio://guidance/design", {
    title: "Slide Studio design guidance", description: "Required visual-quality and text-box safety guidance.", mimeType: "text/markdown",
  }, async (uri) => {
    guidanceRead = true;
    return { contents: [{ uri: uri.href, mimeType: "text/markdown", text: guidance }] };
  });

  register("get_design_guidance", "Read the required compact design and clipping guidance. Call once before any mutation.", z.object({}).strict(), async () => {
    guidanceRead = true;
    return { __rawMcpResult: true, content: [{ type: "text", text: guidance }], structuredContent: { read: true } };
  }, { readOnlyHint: true, idempotentHint: true });

  register("list_editors", "Check the user's real local browser connection and show which registered Slide Studio tab this session targets. Call this instead of opening a sandboxed browser.", z.object({}).strict(), () => companion.call("list_editors"), { readOnlyHint: true });
  register("select_editor", "Select a connected browser tab for this MCP session.", z.object({ editorId: id }).strict(), ({ editorId }) => companion.call("select_editor", { editorId }), { destructiveHint: false, idempotentHint: true });
  register("inspect_editor", "Inspect projects, slides, assets, and every text/image layer without returning image bytes.", z.object({ ...targetSlide, includeAllProjects: z.boolean().default(true) }).strict(), (args) => browserOperation(companion, "inspect_editor", args), { readOnlyHint: true });
  register("show_notification", "Show a short visual notification in the connected editor for status or marketing demos.", z.object({ message: z.string().min(1).max(240), tone: z.enum(["agent", "success", "info", "error"]).default("agent") }).strict(), (args) => companion.call("notify", args), { destructiveHint: false, idempotentHint: false });

  register("create_project", "Create an empty project. If the dashboard is visible, its card appears live; adding the first slide opens the editor.", z.object({ name: z.string().min(1).max(160) }).strict(), (args) => browserOperation(companion, "create_project", args), { destructiveHint: false });
  register("open_project", "Open a project and optionally a specific slide without changing content.", z.object({ projectId: id, slideId: optionalId }).strict(), (args) => browserOperation(companion, "open_project", args), { destructiveHint: false, idempotentHint: true });
  register("update_project", "Rename a project.", z.object({ ...targetProject, name: z.string().min(1).max(160) }).strict(), (args) => browserOperation(companion, "update_project", args), { destructiveHint: true });
  register("delete_project", "Delete a project from browser storage.", z.object({ ...targetProject, projectId: id }).strict(), (args) => browserOperation(companion, "delete_project", args), { destructiveHint: true });

  register("add_slide", "Add and open a slide using a solid color or local background image path.", z.object({ ...targetProject, name: z.string().max(160).optional(), index: z.number().int().min(0).optional(), backgroundColor: color.optional(), backgroundPath: z.string().min(1).optional() }).strict(), (args) => browserOperation(companion, "add_slide", args), { destructiveHint: false });
  register("update_slide", "Rename a slide, replace its background, or change background pan/zoom. The browser opens this slide.", z.object({ ...targetSlide, name: z.string().max(160).optional(), backgroundColor: color.optional(), backgroundPath: z.string().min(1).optional(), imageScale: z.number().min(1).max(3).optional(), imageX: unit.optional(), imageY: unit.optional() }).strict(), (args) => browserOperation(companion, "update_slide", args), { destructiveHint: true });
  register("duplicate_slide", "Duplicate a slide with all layers and open the copy.", z.object({ ...targetSlide, name: z.string().max(160).optional() }).strict(), (args) => browserOperation(companion, "duplicate_slide", args), { destructiveHint: false });
  register("reorder_slides", "Set the complete slide order using every slide ID exactly once.", z.object({ ...targetProject, slideIds: z.array(id).min(1) }).strict(), (args) => browserOperation(companion, "reorder_slides", args), { destructiveHint: true });
  register("delete_slide", "Delete one slide.", z.object({ ...targetSlide, slideId: id }).strict(), (args) => browserOperation(companion, "delete_slide", args), { destructiveHint: true });

  register("add_text", "Add a text layer. Coordinates and dimensions are normalized to the 9:16 canvas; attractive defaults use generous bounds and per-line boxes.", z.object({ ...targetSlide, ...textFields, text: z.string().min(1).max(4000) }).strict(), (args) => browserOperation(companion, "add_text", args), { destructiveHint: false });
  register("update_text", "Update one or more text layers, including content, geometry, color, style, alignment, rotation, and stacking.", z.object({ ...targetSlide, updates: z.array(z.object({ id, ...textFields }).strict()).min(1).max(100) }).strict(), (args) => browserOperation(companion, "update_text", args), { destructiveHint: true });

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
  register("apply_operations", "Apply many ordered editing operations in one compact tool call. Each edit still appears live in the browser.", z.object({ operations: z.array(z.object({ tool: z.enum(batchTools), arguments: z.record(z.string(), z.unknown()).default({}) }).strict()).min(1).max(100) }).strict(), async ({ operations }) => {
    const items = [];
    for (const item of operations) {
      const definition = definitions.get(item.tool);
      if (!definition?.mutating) throw new Error(`Tool cannot be batched: ${item.tool}`);
      const args = definition.inputSchema.parse(item.arguments);
      items.push({ operation: await prepareOperation(companion, item.tool, args), label: operationLabel(item.tool) });
    }
    return companion.call("batch", { items });
  }, { destructiveHint: true });

  return server;
}
