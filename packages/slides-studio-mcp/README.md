# slides-studio-mcp compatibility package

Slide Studio is now **CarouselBot**. This package remains available so existing MCP client configurations continue to work without interruption.

New installations should use:

```bash
npx carouselbot@latest setup
```

Running any command through `slides-studio-mcp` delegates to the maintained `carouselbot` package. No project files, images, or prompts are sent to a hosted relay.
