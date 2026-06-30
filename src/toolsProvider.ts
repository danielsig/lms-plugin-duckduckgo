import { tool, Tool, ToolsProviderController } from "@lmstudio/sdk";
import { z } from "zod";
import { join } from "path";
import { writeFile } from "fs/promises";
import { configSchematics } from "./config";


export async function toolsProvider(ctl:ToolsProviderController):Promise<Tool[]> {
	const tools:Tool[] = [];

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
				const url = "https://html.duckduckgo.com/html/";
				const headers = { ...spoofHeaders(), "Content-Type": "application/x-www-form-urlencoded", "Referer": url };
				const post = (body:URLSearchParams) => fetch(url, { method: "POST", signal, headers, body });
				const safeSearchParam = safeSearch !== "moderate" ? safeSearch === "strict" ? "-1" : "1" : undefined;
				const body = new URLSearchParams({ q: query, kl: "wt-wt", b: "" });
				if (safeSearchParam) body.set("p", safeSearchParam);

				const response = await post(body);
				if (!response.ok) {
					warn(`Failed to fetch search results: ${response.statusText}`);
					return `Error: Failed to fetch search results: ${response.statusText}`;
				}
				let html = await response.text();
				if (html.includes('id="challenge-form"')) {
					// CAPTCHA detected, wait 4 seconds and retry
					await new Promise(resolve => setTimeout(resolve, 4000));
					const retry = await post(body);
					if (!retry.ok) return `Error: Failed to fetch search results: ${retry.statusText}`;
					html = await retry.text();
					if (html.includes('id="challenge-form"'))
						return "Error: DuckDuckGo CAPTCHA blocked the search. Try again later.";
				}

				if (page > 1) {
					const vqd = extractVqd(html);
					if (!vqd) return "Error: Unable to paginate search results.";
					await new Promise(resolve => setTimeout(resolve, 2000));
					const offset = parseInt(html.match(/name="s"[^>]*value="(\d+)"/)?.[1] ?? "10") + (page - 2) * 15;
					const pageBody = new URLSearchParams({ q: query, kl: "wt-wt", vqd, nextParams: "", api: "d.js", o: "json", v: "l", s: offset.toString(), dc: (offset + 1).toString() });
					if (safeSearchParam) pageBody.set("p", safeSearchParam);
					const pageResponse = await post(pageBody);
					if (!pageResponse.ok) {
						warn(`Failed to fetch page ${page}: ${pageResponse.statusText}`);
						return `Error: Failed to fetch page ${page}: ${pageResponse.statusText}`;
					}
					html = await pageResponse.text();
					if (html.includes('id="challenge-form"'))
						return "Error: DuckDuckGo CAPTCHA blocked pagination. Try again later.";
				}

				// Extract web results using regex
				const links: [string, string][] = [];
				const regex = /\shref="[^"]*(https?[^?&"]+)[^>]*>([\s\S]*?)<\/a>/gm;
				let match;
				while (links.length < pageSize && (match = regex.exec(html))) {
					const label = match[2].replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
					const url = decodeURIComponent(match[1]);
					if (new URL(url).hostname.endsWith('duckduckgo.com')) continue;
					if (!links.some(([, existingUrl]) => existingUrl === url))
						links.push([label, url]);
				}
				if (links.length === 0)
					return "No web pages found for the query.";
				status(`Found ${links.length} web pages.`);
				return { links, count: links.length, page };
			} catch (error:unknown) {
				if (error instanceof DOMException && error.name === "AbortError")
					return "Search aborted by user.";
				if (error instanceof Error) {
					warn(`Error during search: ${error.message}`);
					return `Error: ${error.message}`;
				}
				return "Unknown error occurred during search.";
			}
		},
	});

	const duckDuckGoImageSearchTool = tool({
		name: "Image Search",
		description: "Search for images on DuckDuckGo using a query string. Downloads matching images into the chat working directory and returns markdown image references (![alt](path)). Write each returned line directly into your reply as plain markdown (not in a code blocks) so the images display inline.",
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
				const initialUrl = new URL("https://duckduckgo.com/");
				initialUrl.searchParams.append("q", query);
				initialUrl.searchParams.append("iax", "images");
				initialUrl.searchParams.append("ia", "images");

				const initialResponse = await fetch(initialUrl.toString(), {
					method: "GET",
					signal,
					headers: spoofHeaders()
				});

				if (!initialResponse.ok) {
					warn(`Failed to fetch initial response: ${initialResponse.statusText}`);
					return `Error: Failed to fetch initial response: ${initialResponse.statusText}`;
				}

				const initialHtml = await initialResponse.text();
				const vqd = extractVqd(initialHtml);
				if (!vqd) {
					warn("Failed to extract vqd token.");
					return "Error: Unable to extract vqd token.";
				}

				// Step 2: sleep 1 second to avoid rate limiting
				await new Promise(resolve => setTimeout(resolve, 1000));

				// Step 3: Fetch image results using the i.js endpoint
				const fetchImgBatch = async (s?:number) => {
					const url = new URL("https://duckduckgo.com/i.js");
					url.searchParams.append("q", query);
					url.searchParams.append("o", "json");
					url.searchParams.append("l", "us-en"); // Global region
					url.searchParams.append("vqd", vqd);
					if (safeSearch !== "moderate")
						url.searchParams.append("p", safeSearch === "strict" ? "-1" : "1");
					if (s !== undefined)
						url.searchParams.append("s", s.toString()); // Start at the appropriate index
					const res = await fetch(url.toString(), { method: "GET", signal, headers: spoofHeadersImage() });
					if (!res.ok)
						throw new Error(`Failed to fetch image results: ${res.statusText}`);
					const data = await res.json() as { results: { image:string }[] };
					return (data.results || [])
						.map(r => r.image)
						.filter((url):url is string => !!url && /\.(jpg|jpeg|png|gif|webp|avif)$/i.test(url));
				};

				const offset = pageSize * (page - 1);
				const batch1 = await fetchImgBatch();
				let allImages = batch1;
				if (offset + pageSize > batch1.length) {
					await new Promise(resolve => setTimeout(resolve, 2000));
					allImages = [...batch1, ...await fetchImgBatch(batch1.length)];
				}
				const imageURLs = allImages.slice(offset, offset + pageSize);

				if (imageURLs.length === 0)
					return "No images found for the query.";

				status(`Found ${imageURLs.length} images. Fetching...`);

				// Download images to ensure they are accessible
				const workingDirectory = ctl.getWorkingDirectory();
				const timestamp = Date.now();
				const downloadPromises = imageURLs.map(async (url:string, i:number) => {
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
						if (!imageResponse.headers.get('content-type')?.startsWith('image/')) {
							warn(`Image ${index} is not an image: ${url}`);
							return null;
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
					} catch (error:unknown) {
						if (error instanceof DOMException && error.name === "AbortError")
							return null; // Skip if download was aborted
						if (error instanceof Error)
							warn(`Error fetching image ${index}: ${error.message}`);
						return null; // Skip this image on error
					}
				});
				const downloadedPaths = await Promise.all(downloadPromises);
				const result = downloadedPaths.filter(Boolean).map((p, i) => '!' + toMarkdownLink(`Image ${i + 1}`, p!));
				if (result.length === 0) {
					warn('Error fetching images');
					return imageURLs;
				}
				status(`Downloaded ${result.length} images successfully.`);
				return result;
			} catch (error:unknown) {
				if (error instanceof DOMException && error.name === "AbortError")
					return "Search aborted by user.";
				if (error instanceof Error) {
					warn(`Error during search: ${error.message}`);
					return `Error: ${error.message}`;
				}
				return "Unknown error occurred during search.";
			}
		},
	});


	const imageAnalysisTool = tool({
		name: "Image Analysis",
		description: "Analyze one or more locally downloaded images using the current vision model. Pass paths returned by Image Search. Returns an error if the current model does not support vision. Analysis takes time, use when relevant.",
		parameters: {
			paths: z.array(z.string()).min(1).describe("Image paths as returned by Image Search"),
			wordsPerImage: z.number().int().min(0).max(1000).optional().describe("How long each image's description should be, in words. About 100 divided by the number of images is a good target (e.g. ~10 words each for 10 images)."),
			focus: z.string().optional().describe("What to focus on when analyzing. Defaults to a detailed general description."),
		},
		implementation: async ({ paths, wordsPerImage, focus }, { status, warn }) => {
			try {
				const model = await ctl.client.llm.model();
				if (!model.vision)
					return "Error: The current model does not support vision. Load a vision-capable model to analyze images.";
				const workingDirectory = ctl.getWorkingDirectory();
				let prompt = focus ?? "Describe this image. Start with its type (photo, illustration, screenshot, texture, icon, diagram, etc.), describe the style, setting, function, and surroundings, then focus on the main subject in great detail followed by any other notable details. No introductory phrases. If in doubt about the type, name all that apply with the most likely option first.";
				if (wordsPerImage && !/\d+\s*(word|token|sentence)s?/i.test(prompt))
					prompt += ` Keep the response to roughly ${wordsPerImage} words.`;
				const maxTokens = wordsPerImage ? Math.round(wordsPerImage / 0.75 * 2) : 1024;
				// Some reasoning models leak their hidden thinking into the output; keep only the final answer.
				const stripReasoning = (text:string):string | null => {
					text = text.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
					const openIdx = text.indexOf('<|channel>');
					if (openIdx === -1) return text || null;
					const closeIdx = text.indexOf('<channel|>');
					const after = closeIdx !== -1 ? text.slice(closeIdx + '<channel|>'.length).trim() : '';
					if (after) return after;
					// Nothing after the closing tag (or none present) — fall back to the content inside the block
					const insideStart = openIdx + '<|channel>'.length;
					const insideEnd = closeIdx !== -1 ? closeIdx : text.length;
					return text.slice(insideStart, insideEnd).replace(/^\w+\n/, '').trim() || null;
				};
				status(`Analyzing ${paths.length} image${paths.length > 1 ? "s" : ""}...`);
				return await Promise.all(paths.map(async (imagePath, i) => {
					const src = imagePath.replace(/^!\[[^\]]*\]\(/, '').replace(/\)$/, '').trim();
					const filename = src.split('/').pop()!;
					const alt = imagePath.match(/^!\[([^\]]*)\]/)?.[1] ?? `Image ${i + 1}`;
					const absolutePath = join(workingDirectory, filename);
					try {
						const fileHandle = await ctl.client.files.prepareImage(absolutePath);
						const result = await model.respond([{
							role: "user",
							content: prompt,
							images: [fileHandle],
						}], { maxTokens });
						return { path: "!" + toMarkdownLink(alt, src), analysis: stripReasoning(result.content) };
					} catch (error: unknown) {
						if (error instanceof Error)
							warn(`Failed to analyze image ${i + 1}: ${error.message}`);
						return { path: "!" + toMarkdownLink(alt, src), analysis: null };
					}
				}));
			} catch (error: unknown) {
				if (error instanceof DOMException && error.name === "AbortError")
					return "Analysis aborted by user.";
				if (error instanceof Error)
					return `Error: ${error.message}`;
				return "Unknown error occurred during analysis.";
			}
		},
	});

	tools.push(duckDuckGoWebSearchTool);
	tools.push(duckDuckGoImageSearchTool);
	tools.push(imageAnalysisTool);
	return tools;
}

const undefinedIfAuto = (value:unknown, autoValue:unknown) =>
	value === autoValue ? undefined : value as undefined;

const toMarkdownLink = (text:string, url:string):string => {
	const safeText = text
		.replace(/\\/g, '\\\\')
		.replace(/[\[\]]/g, '\\$&')
		.replace(/\s+/g, ' ')
		.trim();
	const safeUrl = url.trim().replace(/[()\s]/g, encodeURIComponent);
	return `[${safeText}](${safeUrl})`;
};
function extractVqd(html:string) {
	return html.match(/name="vqd"[^>]*value="([^"]+)"/)?.[1]
		?? html.match(/vqd="([^"]+)"/)?.[1]
		?? html.match(/vqd=([\d-]+)/)?.[1];
}

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
	};
}

function spoofHeadersImage(){
	return {
		...spoofHeaders(),
		'Referer': 'https://duckduckgo.com/',
		'Sec-Fetch-Mode': 'cors'
	};
}
