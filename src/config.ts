import { createConfigSchematics } from "@lmstudio/sdk";

export const configSchematics = createConfigSchematics()
	.field(
		"page_size",
		"numeric",
		{
			displayName: "Search Results Per Page",
			min: 1,
			max: 10,
		},
		5
	)
	.field(
		"safe_search",
		"select",
		{
			options: [
				{ value: "strict", displayName: "Strict" },
				{ value: "moderate", displayName: "Moderate" },
				{ value: "off", displayName: "Off" },
			],
			displayName: "Safe Search",
		},
		"moderate"
	)
	.build();