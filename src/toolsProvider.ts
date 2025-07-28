import { tool, Tool, ToolsProviderController } from "@lmstudio/sdk";
import { z } from "zod";
import { join } from "path";
import { writeFile } from "fs/promises";
import { configSchematics } from "./config";
// import { search, searchImages, SafeSearchType } from "duck-duck-scrape";



export async function toolsProvider(ctl:ToolsProviderController):Promise<Tool[]> {
	const tools: Tool[] = [];

	let lastRequestTimestamp = 0;
	const TIME_BETWEEN_REQUESTS = 2000; // 2 seconds
	const waitIfNeeded = () => {
		const timestamp = Date.now();
		const difference = timestamp - lastRequestTimestamp;
		lastRequestTimestamp = timestamp;
		if (difference < TIME_BETWEEN_REQUESTS)
			return new Promise(resolve => setTimeout(resolve, TIME_BETWEEN_REQUESTS - difference));
		return Promise.resolve();
	}
	
	const duckDuckGoWebSearchTool = tool({
		name: "Web Search",
		description: "Search for web pages on DuckDuckGo using a query string and return a list of URLs.",
		parameters: {
			query: z.string().describe("The search query for finding web pages"),
			pageSize: z.number().int().min(1).max(10).optional().describe("Number of web results per page"),
			safeSearch: z.enum(["strict", "moderate", "off"]).optional().describe("Safe Search"),
			page: z.number().int().min(1).max(100).optional().default(1).describe("Page number for pagination"),
		},
		implementation: async ({ query, pageSize, safeSearch, page }, { status, warn, signal }) => {
			status("Initiating DuckDuckGo web search...");
			await waitIfNeeded(); // Wait if needed to avoid rate limiting
			try {
				pageSize = undefinedIfAuto(ctl.getPluginConfig(configSchematics).get("pageSize"), 0)
					?? pageSize
					?? 5;
				safeSearch = undefinedIfAuto(ctl.getPluginConfig(configSchematics).get("safeSearch"), "auto")
					?? safeSearch
					?? "moderate";
				
				// Construct the DuckDuckGo API URL
				const headers = spoofHeaders();
				const url = new URL("https://duckduckgo.com/html/");
				url.searchParams.append("q", query);
				if (safeSearch !== "moderate")
					url.searchParams.append("p", safeSearch === "strict" ? "-1" : "1");
				if (page > 1)
					url.searchParams.append("s", ((pageSize * (page - 1)) || 0).toString()); // Start at the appropriate index
				// Perform the fetch request with abort signal
				console.log(`Fetching DuckDuckGo search results for query: ${url.toString() }`);
				const response = await fetch(url.toString(), {
					method: "GET",
					signal,
					headers,
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
				while (links.length < pageSize && (match = regex.exec(html))) {
					const label = match[2].replace(/\s+/g, " ").trim();
					const url = decodeURIComponent(match[1]);
					if(!links.some(([,existingUrl]) => existingUrl === url))
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
				console.error(error);
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
			pageSize: z.number().int().min(1).max(10).optional().default(10).describe("Number of image results per page"),
			safeSearch: z.enum(["strict", "moderate", "off"]).optional().default("moderate").describe("Safe Search"),
			page: z.number().int().min(1).max(100).optional().default(1).describe("Page number for pagination"),
		},
		implementation: async ({ query, pageSize, safeSearch, page }, { status, warn, signal }) => {
			status("Initiating DuckDuckGo image search...");
			await waitIfNeeded(); // Wait if needed to avoid rate limiting
			try {
				pageSize = undefinedIfAuto(ctl.getPluginConfig(configSchematics).get("pageSize"), 0)
					?? pageSize
					?? 5;
				safeSearch = undefinedIfAuto(ctl.getPluginConfig(configSchematics).get("safeSearch"), "auto")
					?? safeSearch
					?? "moderate";
					
				// // Step 1: Fetch the vqd token
				const headers = spoofHeaders();
				const initialUrl = new URL("https://duckduckgo.com/");
				initialUrl.searchParams.append("q", query);
				initialUrl.searchParams.append("iax", "images");
				initialUrl.searchParams.append("ia", "images");

				const initialResponse = await fetch(initialUrl.toString(), {
					method: "GET",
					signal,
					headers,
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
				if(safeSearch !== "moderate")
					searchUrl.searchParams.append("p", safeSearch === "strict" ? "-1" : "1");
				if (page > 1)
					searchUrl.searchParams.append("s", ((pageSize * (page - 1)) || 0).toString()); // Start at the appropriate index

				const searchResponse = await fetch(searchUrl.toString(), {
					method: "GET",
					signal,
					headers,
				});

				if (!searchResponse.ok) {
					warn(`Failed to fetch image results: ${searchResponse.statusText}`);
					return `Error: Failed to fetch image results: ${searchResponse.statusText}`;
				}

				const data = await searchResponse.json();
				const imageResults = data.results || [];
				const imageURLs = imageResults
					.slice(0, pageSize)
					.map((result: any) => result.image)
					.filter((url: string) => url && url.match(/\.(jpg|png|gif|jpeg)$/i));

				if (imageURLs.length === 0)
					return "No images found for the query.";

				status(`Found ${imageURLs.length} images. Fetching...`);

				// const ddgSafeSearch =
				// 	{
				// 		strict: SafeSearchType.STRICT,
				// 		moderate: SafeSearchType.MODERATE,
				// 		off: SafeSearchType.OFF,
				// 	}[safeSearch] || SafeSearchType.MODERATE;
				// const offset = pageSize * (page - 1);

				// const results = await searchImages(query, {
				// 	offset,
				// 	safeSearch: ddgSafeSearch,
				// });
				// const imageURLs = results.results.map(img => img.image);

				// Download images to ensure they are accessible
				const workingDirectory = ctl.getWorkingDirectory();
				const timestamp = Date.now();
				const downloadPromises = imageURLs.map(async (url: string, i: number) => {
					const index = i + 1;
					try {
						const imageResponse = await fetch(url, {
							method: "GET",
							signal,
						});
						if (!imageResponse.ok) {
							warn(`Failed to fetch image ${index}: ${imageResponse.statusText}`);
							return null; // Skip this image if download fails
						}
						const bytes = await imageResponse.bytes();
						if (bytes.length === 0) {
							warn(`Image ${index} is empty: ${url}`);
							return null; // Skip empty images
						}
						// save the image to a file in the working directory
						const fileExtension = /image\/([\w]+)/.exec(imageResponse.headers.get('content-type') || '')?.[1]
							|| /\.([\w]+)(?:\?.*)$/.exec(url)?.[1] // Extract extension from URL if content type is not available
							|| 'jpg'; // Default to jpg if no content type
						const fileName = `${timestamp}-${index}.${fileExtension}`;
						const filePath = join(workingDirectory, fileName);
						const localPath = filePath.replace(/\\/g, '/').replace(/^C:/, '') // Normalize path for web compatibility
						await writeFile(filePath, bytes, 'binary');
						return localPath;
					} catch (error: any) {
						if (error instanceof DOMException && error.name === "AbortError")
							return null; // Skip if download was aborted
						warn(`Error fetching image ${index}: ${error.message}`);
						return null; // Skip this image on error
					}
				});
				const downloadedImageURLs = (await Promise.all(downloadPromises)).map(x => x || 'Error downloading image');
				if (downloadedImageURLs.length === 0) {
					warn('Error fetching images');
					return imageURLs;
				}

				status(`Downloaded ${downloadedImageURLs.length} images successfully.`);

				return downloadedImageURLs;
			} catch (error: any) {
				if (error instanceof DOMException && error.name === "AbortError") {
					return "Search aborted by user.";
				}
				console.error(error);
				warn(`Error during search: ${error.message}`);
				return `Error: ${error.message}`;
			}
		},
	});


	tools.push(duckDuckGoWebSearchTool);
	tools.push(duckDuckGoImageSearchTool);
	return tools;
}

const undefinedIfAuto = (value: unknown, autoValue: unknown) =>
	value === autoValue ? undefined : value as undefined;

const spoofedUserAgents = [
	// Random spoofed realistic user agents for DuckDuckGo
	"Mozilla/5.0 (Linux; Android 10; SM-M515F) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/87.0.4280.141 Mobile Safari/537.36",
	"Mozilla/5.0 (Linux; Android 6.0; E5533) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/83.0.4103.101 Mobile Safari/537.36",
	"Mozilla/5.0 (Linux; Android 8.1.0; AX1082) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/83.0.4103.83 Mobile Safari/537.36",
	"Mozilla/5.0 (Linux; Android 8.1.0; TM-MID1020A) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/83.0.4103.96 Safari/537.36",
	"Mozilla/5.0 (Linux; Android 9; POT-LX1) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/96.0.4664.45 Mobile Safari/537.36",
	"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/97.0.4692.71 Safari/537.36",
	"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/98.0.4758.80 Safari/537.36",
	"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/14.0.3 Safari/605.1.15",
	"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.3.1 Safari/605.1.15",
	"Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:97.0) Gecko/20100101 Firefox/97.0",
	"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36 Edg/134.0.0.0",
	"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/97.0.4692.71 Safari/537.36 Edg/97.0.1072.71",
	"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/97.0.4692.71 Safari/537.36",
	"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/98.0.4758.80 Safari/537.36 Edg/98.0.1108.62",
	"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/98.0.4758.80 Safari/537.36",
	"Mozilla/5.0 (X11; CrOS x86_64 14541.0.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36",
	"Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/97.0.4692.71 Safari/537.36",
	"Mozilla/5.0 (X11; Ubuntu; Linux x86_64; rv:97.0) Gecko/20100101 Firefox/97.0",
	"Opera/9.80 (Android 7.0; Opera Mini/36.2.2254/119.132; U; id) Presto/2.12.423 Version/12.16",
]

function spoofHeaders(){
	return {
		'User-Agent': spoofedUserAgents[Math.floor(Math.random() * spoofedUserAgents.length)],
		'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,image/apng,*/*;q=0.8',
		'Accept-Language': 'en-US,en;q=0.9',
		'Accept-Encoding': 'gzip, deflate, br',
		'Connection': 'keep-alive',
		'Referer': 'https://duckduckgo.com/',
		'Origin': 'https://duckduckgo.com',
		'Upgrade-Insecure-Requests': '1',
		'Sec-Fetch-Dest': 'document',
		'Sec-Fetch-Mode': 'navigate',
		'Sec-Fetch-Site': 'same-origin',
		'Sec-Fetch-User': '?1',
		'Cache-Control': 'max-age=0',
	};
}