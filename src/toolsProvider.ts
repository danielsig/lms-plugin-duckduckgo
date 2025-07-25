import { tool, Tool, ToolsProviderController } from "@lmstudio/sdk";
import { z } from "zod";

export async function toolsProvider(ctl:ToolsProviderController):Promise<Tool[]> {
	const tools: Tool[] = [];

	const duckDuckGoWebSearchTool = tool({
		name: "Web Search",
		description: "Search for web pages on DuckDuckGo using a query string and return a list of URLs.",
		parameters: {
			query: z.string().describe("The search query for finding web pages"),
			max_results: z.number().int().min(1).max(100).optional().default(10).describe("Maximum number of web results to return"),
			safe_search: z.enum(["on", "moderate", "off"]).optional().default("off").describe("Safe search setting"),
			page: z.number().int().min(1).max(100).optional().default(1).describe("Page number for pagination"),
		},
		implementation: async ({ query, max_results, safe_search, page }, { status, warn, signal }) => {
			status("Initiating DuckDuckGo web search...");
			try {
				// Construct the DuckDuckGo API URL
				const url = new URL("https://duckduckgo.com/html/");
				url.searchParams.append("q", query);
				if (safe_search !== "moderate")
					url.searchParams.append("p", safe_search === "on" ? "1" : "-1");
				if (page > 1)
					url.searchParams.append("s", ((max_results * (page - 1)) || 0).toString()); // Start at the appropriate index
				// Perform the fetch request with abort signal
				const response = await fetch(url.toString(), {
					method: "GET",
					signal,
				});
				if (!response.ok) {
					warn(`Failed to fetch search results: ${response.statusText}`);
					return `Error: Failed to fetch search results: ${response.statusText}`;
				}
				const html = await response.text();
				// Extract web results using regex (simplified parsing for demonstration)
				// Note: In production, consider using a proper HTML parser like jsdom
				const links: [string, string][] = [];
				const regex = /\shref="[^"]*(https?[^?&"]+)[^>]*>([^<]*)/gm;
				let match;
				while (links.length < max_results && (match = regex.exec(html))) {
					const label = match[1].replace(/\s+/g, " ").trim();
					const url = decodeURIComponent(match[1]);
					if(!links.some(([existingUrl]) => existingUrl === url))
						links.push([label, url]);
				}
				if (links.length === 0) {
					return "No web pages found for the query.";
				}
				status(`Found ${links.length} web pages.`);
				return {
					links,
					count: links.length,
				};
			} catch (error: any) {
				if (error instanceof DOMException && error.name === "AbortError") {
					return "Search aborted by user.";
				}
				warn(`Error during search: ${error.message}`);
				return `Error: ${error.message}`;
			}
		},
	});

	const duckDuckGoImageSearchTool = tool({
		name: "Image Search",
		description: "Search for images on DuckDuckGo using a query string and return a list of image URLs.",
		parameters: {
			query: z.string().describe("The search query for finding images"),
			max_results: z.number().int().min(1).max(100).optional().default(10).describe("Maximum number of image results to return"),
			safe_search: z.enum(["on", "moderate", "off"]).optional().default("off").describe("Safe search setting"),
			page: z.number().int().min(1).max(100).optional().default(1).describe("Page number for pagination"),
		},
		implementation: async ({ query, max_results, safe_search, page }, { status, warn, signal }) => {
			status("Initiating DuckDuckGo image search...");

			try {
				// Step 1: Fetch the vqd token
				const initialUrl = new URL("https://duckduckgo.com/");
				initialUrl.searchParams.append("q", query);
				initialUrl.searchParams.append("iax", "images");
				initialUrl.searchParams.append("ia", "images");

				const initialResponse = await fetch(initialUrl.toString(), {
					method: "GET",
					signal,
				});

				if (!initialResponse.ok) {
					warn(`Failed to fetch initial response: ${initialResponse.statusText}`);
					return `Error: Failed to fetch initial response: ${initialResponse.statusText}`;
				}

				const initialHtml = await initialResponse.text();
				const vqd = initialHtml.match(/vqd="([^"]+)"/)?.[1] as string;
				if (!vqd) {
					warn("Failed to extract vqd token.");
					return "Error: Unable to extract vqd token.";
				}

				// Step 2: sleep 1 second to avoid rate limiting
				await new Promise(resolve => setTimeout(resolve, 1000));

				// Step 3: Fetch image results using the i.js endpoint
				const searchUrl = new URL("https://duckduckgo.com/i.js");
				searchUrl.searchParams.append("q", query);
				searchUrl.searchParams.append("o", "json");
				searchUrl.searchParams.append("l", "us-en"); // Global region
				searchUrl.searchParams.append("vqd", vqd);
				searchUrl.searchParams.append("f", ",,,,,");
				if(safe_search !== "moderate")
					searchUrl.searchParams.append("p", safe_search === "on" ? "1" : "-1");
				if (page > 1)
					searchUrl.searchParams.append("s", ((max_results * (page - 1)) || 0).toString()); // Start at the appropriate index

				const searchResponse = await fetch(searchUrl.toString(), {
					method: "GET",
					signal,
					headers: {
						'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/58.0.3029.110 Safari/537.3',
					},
				});

				if (!searchResponse.ok) {
					warn(`Failed to fetch image results: ${searchResponse.statusText}`);
					return `Error: Failed to fetch image results: ${searchResponse.statusText}`;
				}

				const data = await searchResponse.json();
				const imageResults = data.results || [];
				const imageUrls = imageResults
					.slice(0, max_results)
					.map((result: any) => result.image)
					.filter((url: string) => url && url.match(/\.(jpg|png|gif|jpeg)$/i));

				if (imageUrls.length === 0) {
					return "No images found for the query.";
				}

				status(`Found ${imageUrls.length} images.`);
				return {
					images: imageUrls,
					count: imageUrls.length,
				};
			} catch (error: any) {
				if (error instanceof DOMException && error.name === "AbortError") {
					return "Search aborted by user.";
				}
				warn(`Error during search: ${error.message}`);
				return `Error: ${error.message}`;
			}
		},
	});

	tools.push(duckDuckGoWebSearchTool);
	tools.push(duckDuckGoImageSearchTool);
	return tools;
}
