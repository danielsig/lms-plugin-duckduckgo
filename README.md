# DuckDuckGo Search Tool Plugin for LM Studio

An LM Studio plugin that provides access to DuckDuckGo web search and image search.

## Installation

The plugin is available for download on the
[LM Studio Hub](https://lmstudio.ai/danielsig/duckduckgo/files/src/toolsProvider.ts)

![click the "Run in LM Studio" button](/docs/assets/how_to_install_on_lm_studio_hub.png)

## Configuration

![DuckDuckGo Search Tool Configuration](/docs/assets/configuration.png)

The search tool has the following configurations:

- **Search Results Per Page** - The maximum number of search results per page. Leave this at 0 to let the assistant decide how many results to return.
- **Safe Search** - The level of safe search to apply (off, moderate, strict). Leave this at `Auto` to let the assistant decide if safe search should be applied.
  
## How to use

With the plugin enabled, you can explicitly instruct the assistant to search the web or show you images but you can also ask a question to which one would normally need to search the web to give a proper answer and the assistant will use the tool accordingly.

Pagination is also supported which allows the assistant to provide more results if needed.

This plugin works well in combination with the [Visit Website Tool](https://github.com/danielsig/lms-plugin-visit-website) which can be used to extract basic content from URLs.
