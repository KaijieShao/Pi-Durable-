import { defineExtension, type Extension, type ToolRegistration } from "@earendil-works/pi-durable";
import { createEditTool, createWriteTool } from "@earendil-works/pi-durable/tools";
import { createSafeBashTool } from "./bash.ts";
import { createImageReadTool, createImageRequestHook } from "./image-read.ts";

export type WorkspaceToolsOptions = {
	/** Variables the agent's bash sees; nothing else from the service environment is inherited. */
	readonly env: Readonly<Record<string, string>>;
};

/** `read` (with images), `write`, `edit` and a `bash` without inherited secrets; replaces pi-durable's CodingTools. */
export function createWorkspaceTools(options: WorkspaceToolsOptions): Extension {
	return defineExtension({
		name: "workspace",
		tools: [
			createImageReadTool(),
			eraseTool(createWriteTool()),
			eraseTool(createEditTool()),
			createSafeBashTool(options.env),
		],
		hooks: [createImageRequestHook()],
	});
}

/** Stock tools are typed by their own schemas; a registry holds them erased. */
function eraseTool(tool: object): ToolRegistration {
	return tool as ToolRegistration;
}
