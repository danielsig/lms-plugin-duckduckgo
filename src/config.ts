import { createConfigSchematics } from "@lmstudio/sdk";

export const configSchematics = createConfigSchematics()
	.field(
		"max_results",
		"numeric",
		{
			displayName: "Maximum Search Results",
			min: 1,
			max: 100,
		},
		10
	)
	.field(
		"safe_search",
		"select",
		{
			options: [
				{ value: "on", displayName: "On" },
				{ value: "moderate", displayName: "Moderate" },
				{ value: "off", displayName: "Off" },
			],
			displayName: "Safe Search Setting",
		},
		"off"
	)
	.build();