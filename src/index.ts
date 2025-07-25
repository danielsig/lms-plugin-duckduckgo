import { PluginContext } from "@lmstudio/sdk";
import { toolsProvider } from "./toolsProvider";
import { configSchematics } from "./config";

export async function main(context:PluginContext) {
	// Register the tools provider
	context.withConfigSchematics(configSchematics);
	context.withToolsProvider(toolsProvider);
}