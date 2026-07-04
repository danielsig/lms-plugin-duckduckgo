import { tool, Tool, ToolsProviderController } from "@lmstudio/sdk";
import { z } from "zod";
import { configSchematics } from "./config";
import {
	altFromImageUrl,
	analyzeImages,
	buildAnalysisPrompt,
	computeMaxTokens,
	downloadImages,
	resolveImageAnalysisSystem,
	resolveVisionModel,
} from "./imageVision";


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
	};

	const duckDuckGoWebSearchTool = tool({
		name: "Web Search",
		description: "Search DuckDuckGo for web pages. Returns `links` as `[label, url]` pairs plus `count` and `page`. Write links into your reply as `[label](url)` markdown (not in a code block) when sharing results with the user.",
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
				const links:[string, string][] = [];
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
			}
			catch (error:unknown) {
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
		description: "Search DuckDuckGo for images and download matches into the chat working directory. Returns `![alt](filename)` markdown strings (paths are relative to the working directory) with alt text from the result title or image filename, to be written directly into your reply for display (not in a code block).",
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
					const data = await res.json() as { results:{ image:string; title?:string }[] };
					return (data.results || [])
						.filter(r => r.image && /\.(jpg|jpeg|png|gif|webp|avif)$/i.test(r.image))
						.map((r, i) => ({
							src: r.image,
							alt: r.title?.trim() || altFromImageUrl(r.image, `Image ${i + 1}`),
						}));
				};

				const offset = pageSize * (page - 1);
				const batch1 = await fetchImgBatch();
				let allImages = batch1;
				if (offset + pageSize > batch1.length) {
					await new Promise(resolve => setTimeout(resolve, 2000));
					allImages = [...batch1, ...await fetchImgBatch(batch1.length)];
				}
				const imageItems = allImages.slice(offset, offset + pageSize);

				if (imageItems.length === 0)
					return "No images found for the query.";

				status(`Found ${imageItems.length} images. Fetching...`);

				const result = await downloadImages(
					ctl,
					imageItems,
					status,
					warn,
					signal,
					() => spoofHeadersImage(),
				);
				if (result.length === 0) {
					warn("Error fetching images");
					return imageItems.map(({ src }) => src);
				}
				status(`Downloaded ${result.length} images successfully.`);
				return result;
			}
			catch (error:unknown) {
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


	const getImageAnalysisSystem = () =>
		resolveImageAnalysisSystem(
			ctl.getPluginConfig(configSchematics).get("imageAnalysisSystemPrompt"),
		);

	const imageAnalysisTool = tool({
		name: "Image Analysis",
		description: "Analyze locally downloaded images with a vision-capable model. Pass paths from Image Search and receive a list of objects with:\n- `image` markdown to write directly into the reply (not in a code block) for displaying the image\n- `analysis` of the image, powered by a local vision model. Can take time when analyzing many images or long descriptions.",
		parameters: {
			images: z.array(z.string()).min(1).describe("Image markdown or paths as returned by Image Search (e.g. ![alt](k1.webp))"),
			wordsPerImage: z.number().int().min(0).max(1000).optional().describe("How long each image's analysis should be, in words. Affects analysis time. When in doubt, a good target is about 100 / imageCount e.g. 30 for 3 images, 20 for 5 images."),
			focus: z.string().optional().describe("What to focus on when analyzing. Defaults to a detailed general description."),
		},
		implementation: async ({ images, wordsPerImage, focus }, { status, warn }) => {
			try {
				const model = await resolveVisionModel(ctl);
				if (!model)
					return "Error: No vision-capable model loaded. Load a vision model in LM Studio.";
				const prompt = buildAnalysisPrompt(focus, wordsPerImage);
				const maxTokens = computeMaxTokens(wordsPerImage);
				const result = await analyzeImages(
					ctl, model, images, getImageAnalysisSystem(), prompt, maxTokens, status, warn,
				);
				return typeof result === "string" ? result : result;
			}
			catch (error:unknown) {
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
];

function spoofHeaders() {
	return {
		'User-Agent': spoofedUserAgents[Math.floor(Math.random() * spoofedUserAgents.length)],
	};
}

function spoofHeadersImage() {
	return {
		...spoofHeaders(),
		'Referer': 'https://duckduckgo.com/',
		'Sec-Fetch-Mode': 'cors'
	};
}
