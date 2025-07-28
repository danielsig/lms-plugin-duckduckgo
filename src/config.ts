import { createConfigSchematics } from "@lmstudio/sdk";

export const configSchematics = createConfigSchematics()
	.field(
		"pageSize",
		"numeric",
		{
			displayName: "Search Results Per Page",
			subtitle: "Between 1 and 10, 0 = auto",
			min: 0,
			max: 10,
			int: true,
			slider: {
				step: 1,
				min: 1,
				max: 10,
			},
		},
		0
	)
	.field(
		"safeSearch",
		"select",
		{
			options: [
				{ value: "strict", displayName: "Strict" },
				{ value: "moderate", displayName: "Moderate" },
				{ value: "off", displayName: "Off" },
				{ value: "auto", displayName: "Auto" },
			],
			displayName: "Safe Search",
		},
		"auto"
	)
	.build();