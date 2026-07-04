import { LLM, LLMDynamicHandle, ToolsProviderController } from "@lmstudio/sdk";
import { writeFile } from "fs/promises";
import { join } from "path";

export const IMAGE_ANALYSIS_SYSTEM_DEFAULT =
	"You're an expert image analyzer. Be direct—no preamble, no thinking, unless otherwise specified.";

export const resolveImageAnalysisSystem = (configuredPrompt?:string):string =>
	configuredPrompt?.trim() || IMAGE_ANALYSIS_SYSTEM_DEFAULT;

const thinkingTag = "redacted_thinking";
export const IMAGE_ANALYSIS_ASSISTANT_PREFILL = `<${thinkingTag}></${thinkingTag}>`;

export const DEFAULT_IMAGE_FOCUS =
	"Describe this image. Start with its type (photo, illustration, screenshot, texture, icon, diagram, etc.), describe the style, setting, composition, function, viewing angle, and surroundings, then focus on the main subject in great detail followed by any other notable details. No introductory phrases. If in doubt about the type, name all that apply with the most likely option first.";

export type ImageAnalysisRow = { image:string; analysis:string | null };

export type FetchHeadersFn = (url:string) => Record<string, string>;

const mimeToExtension:Record<string, string> = {
	"image/jpeg": "jpg",
	"image/jpg": "jpg",
	"image/png": "png",
	"image/gif": "gif",
	"image/webp": "webp",
	"application/webp": "webp",
	"image/svg+xml": "svg",
	"image/avif": "avif",
	"image/bmp": "bmp",
	"image/tiff": "tiff",
};

const IMAGE_URL_EXTENSIONS = new Set([
	"jpg", "jpeg", "png", "gif", "webp", "avif", "svg", "bmp", "tiff", "ico",
]);

const parseContentType = (header:string | null):string =>
	(header || "").split(";")[0].trim().toLowerCase();

const isGenericContentType = (contentType:string):boolean =>
	!contentType
	|| contentType === "application/octet-stream"
	|| contentType === "binary/octet-stream";

const extensionFromUrl = (src:string):string | undefined =>
	/\.([a-z0-9]+)$/i.exec(src.split("?")[0])?.[1]?.toLowerCase();

const sniffImageMime = (bytes:Uint8Array):string | null => {
	if (bytes.length >= 12
		&& bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46
		&& bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50)
		return "image/webp";
	if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff)
		return "image/jpeg";
	if (bytes.length >= 8
		&& bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47)
		return "image/png";
	if (bytes.length >= 6 && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46)
		return "image/gif";
	if (bytes.length >= 12
		&& bytes[4] === 0x66 && bytes[5] === 0x74 && bytes[6] === 0x79 && bytes[7] === 0x70) {
		const brand = String.fromCharCode(bytes[8], bytes[9], bytes[10], bytes[11]);
		if (brand === "avif" || brand.startsWith("avis"))
			return "image/avif";
	}
	return null;
};

const resolveImageMime = (
	contentTypeHeader:string | null,
	bytes:Uint8Array,
	src:string,
):string | null => {
	const contentType = parseContentType(contentTypeHeader);
	if (contentType.startsWith("image/"))
		return contentType;
	if (contentType === "application/webp")
		return "image/webp";

	const sniffed = sniffImageMime(bytes);
	if (sniffed)
		return sniffed;

	if (isGenericContentType(contentType)) {
		const urlExt = extensionFromUrl(src);
		if (urlExt && IMAGE_URL_EXTENSIONS.has(urlExt)) {
			if (urlExt === "jpg" || urlExt === "jpeg")
				return "image/jpeg";
			if (urlExt === "svg")
				return "image/svg+xml";
			return `image/${urlExt}`;
		}
	}

	return null;
};

export const MAX_ALT_LENGTH = 50;

export const limitAltText = (alt:string):string =>
	alt.trim().slice(0, MAX_ALT_LENGTH);

/** Derive display alt text from an image URL filename when none is provided. */
export const altFromImageUrl = (src:string, fallback = "Image"):string => {
	try {
		const name = decodeURIComponent(new URL(src).pathname.split("/").pop() || "");
		const base = name.replace(/\.[a-z0-9]+$/i, "").replace(/[-_.+]+/g, " ").trim();
		if (base) return limitAltText(base);
	}
	catch { /* invalid URL */ }
	return limitAltText(fallback);
};

/** Short unique basename for a downloaded image (relative to the working directory). */
const shortImageFileName = (batchKey:string, index:number, fileExtension:string):string =>
	`${batchKey}${index}.${fileExtension}`;

/** Build a markdown link with text/URL escaped. Prefix "!" for an image reference. */
export const toMarkdownLink = (text:string, url:string):string => {
	const safeText = text
		.replace(/\\/g, "\\\\")
		.replace(/[[\]]/g, "\\$&")
		.replace(/\s+/g, " ")
		.trim();
	const safeUrl = url.trim().replace(/[()\s]/g, encodeURIComponent);
	return `[${safeText}](${safeUrl})`;
};

export const parseImageRef = (ref:string, fallbackAlt:string) => ({
	alt: ref.match(/^!\[([^\]]*)\]/)?.[1] || fallbackAlt,
	src: ref.replace(/^!\[[^\]]*\]\(/, "").replace(/\)$/, "").trim(),
});

/** Absolute local paths are used as-is; short names resolve against the working directory. */
export const resolveImagePath = (src:string, workingDirectory:string):string => {
	if (src.startsWith("/") || /^[a-z]:[/\\]/i.test(src))
		return src;
	const filename = src.split(/[/\\]/).pop()!;
	return join(workingDirectory, filename);
};

export const buildAnalysisPrompt = (
	focus:string | undefined,
	wordsPerImage:number | undefined,
	defaultFocus = DEFAULT_IMAGE_FOCUS,
):string => {
	let prompt = focus ?? defaultFocus;
	if (wordsPerImage && !/\d+\s*(word|token|sentence)s?/i.test(prompt))
		prompt += ` Keep the response to roughly ${wordsPerImage} words.`;
	return prompt;
};

export const computeMaxTokens = (wordsPerImage:number | undefined):number =>
	wordsPerImage ? Math.round(wordsPerImage / 0.75 * 2) : 1024;

/** Target word count per image when analysis is enabled but wordsPerImage is omitted. */
export const resolveTargetWords = (
	imageCount:number,
	wordsPerImage?:number,
	focus?:string,
):number => {
	if (wordsPerImage !== undefined && wordsPerImage > 0) return wordsPerImage;
	if (focus) return Math.round(Math.max(100 / imageCount, 5));
	return 0;
};

const smallestVisionModel = (models:LLM[]):LLM | null => {
	const visionModels = models.filter(m => m.vision);
	if (!visionModels.length) return null;
	return visionModels.reduce((smallest, m) =>
		m.sizeBytes < smallest.sizeBytes ? m : smallest
	);
};

/** Chat model if vision-capable, else smallest loaded vision model. */
export const resolveVisionModel = async (
	ctl:ToolsProviderController,
):Promise<LLM | LLMDynamicHandle | null> => {
	const current = await ctl.client.llm.model();
	if (current.vision) return current;
	return smallestVisionModel(await ctl.client.llm.listLoaded());
};

/** Prefer SDK-parsed answer; strip thinking noise from raw content when parsing yields nothing. */
export const extractAnalysis = (result:{
	nonReasoningContent:string;
	content:string;
}):string | null => {
	const parsed = result.nonReasoningContent.trim();
	if (parsed) return parsed;
	return stripReasoningNoise(result.content);
};

/** Remove complete or truncated thinking blocks/tags from model output. */
const stripReasoningNoise = (text:string):string | null => {
	text = text.trim();
	if (!text) return null;

	text = text
		.replace(/<(?:redacted_)?think(?:ing)?>[\s\S]*?<\/(?:redacted_)?think(?:ing)?>/gi, "")
		.replace(/<\|channel\|>[\s\S]*?<\|channel\|>/gi, "")
		.trim();

	text = text
		.replace(/<(?:redacted_)?think(?:ing)?>[\s\S]*/gi, "")
		.replace(/<\|channel\|>[\s\S]*/gi, "")
		.trim();

	text = text
		.replace(/^<(?:redacted_)?think(?:ing)?>/i, "")
		.replace(/^<\|channel\|>/i, "")
		.replace(/^\w+\n/, "")
		.trim();

	return text || null;
};

/** Download remote images to the working directory; pass through local paths as markdown image refs. */
export const downloadImages = async (
	ctl:ToolsProviderController,
	items:{ alt:string; src:string }[],
	status:(msg:string) => void,
	warn:(msg:string) => void,
	signal:AbortSignal,
	fetchHeaders:FetchHeadersFn,
):Promise<string[]> => {
	status("Downloading images...");
	const workingDirectory = ctl.getWorkingDirectory();
	const batchKey = (Date.now() % 1296).toString(36);
	const downloadPromises = items.map(async ({ alt: rawAlt, src }, i) => {
		const alt = limitAltText(rawAlt);
		if (!/^https?:\/\//i.test(src))
			return "!" + toMarkdownLink(alt, src);

		const index = i + 1;
		try {
			const imageResponse = await fetch(src, {
				method: "GET",
				signal,
				headers: fetchHeaders(src),
			});
			if (!imageResponse.ok) {
				warn(`Failed to fetch image ${index}: ${imageResponse.statusText}`);
				return null;
			}
			const bytes = await imageResponse.bytes();
			if (bytes.length === 0) {
				warn(`Image ${index} is empty: ${src}`);
				return null;
			}
			const mimeType = resolveImageMime(imageResponse.headers.get("content-type"), bytes, src);
			if (!mimeType) {
				warn(`Image ${index} is not an image: ${src}`);
				return null;
			}
			const fileExtension =
				mimeToExtension[mimeType]
				|| extensionFromUrl(src)
				|| "jpg";
			const fileName = shortImageFileName(batchKey, index, fileExtension);
			const filePath = join(workingDirectory, fileName);
			await writeFile(filePath, bytes, "binary");
			return "!" + toMarkdownLink(alt, fileName);
		}
		catch (error:unknown) {
			if (error instanceof DOMException && error.name === "AbortError")
				return null;
			warn(
				`Error fetching image ${index}: ${error instanceof Error ? error.message : String(error)}`,
			);
			return null;
		}
	});
	return (await Promise.all(downloadPromises)).filter((x):x is string => x !== null);
};

/** Vision analysis over working-directory images; one request per image. */
export const analyzeImages = async (
	ctl:ToolsProviderController,
	model:LLM | LLMDynamicHandle,
	imageRefs:string[],
	systemPrompt:string,
	prompt:string,
	maxTokens:number,
	status:(msg:string) => void,
	warn:(msg:string) => void,
):Promise<ImageAnalysisRow[] | string> => {
	try {
		const workingDirectory = ctl.getWorkingDirectory();
		status(`Analyzing ${imageRefs.length} image${imageRefs.length > 1 ? "s" : ""}...`);
		return await Promise.all(
			imageRefs.map(async (image, i):Promise<ImageAnalysisRow> => {
				const { src } = parseImageRef(image, `Image ${i + 1}`);
				const absolutePath = resolveImagePath(src, workingDirectory);
				try {
					const fileHandle = await ctl.client.files.prepareImage(absolutePath);
					const result = await model.respond(
						[
							{ role: "system", content: systemPrompt },
							{ role: "user", content: prompt, images: [fileHandle] },
							{ role: "assistant", content: IMAGE_ANALYSIS_ASSISTANT_PREFILL },
						],
						{ maxTokens },
					);
					return { image, analysis: extractAnalysis(result) };
				}
				catch (error:unknown) {
					if (error instanceof Error)
						warn(`Failed to analyze image ${i + 1}: ${error.message}`);
					return { image, analysis: null };
				}
			}),
		);
	}
	catch (error:unknown) {
		if (error instanceof DOMException && error.name === "AbortError")
			return "Analysis aborted by user.";
		if (error instanceof Error)
			return `Error: ${error.message}`;
		return "Unknown error occurred during analysis.";
	}
};
