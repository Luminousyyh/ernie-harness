# Sources and attribution

The execution core, supervisor, tools, provider adapter, workbench and experiment orchestration in this repository are independent implementations. This work studied these MIT-licensed projects; any vendored source must retain its upstream LICENSE. Runtime reference archives and dependency trees are excluded from Git.

| Project | Pinned revision | Design studied |
|---|---|---|
| deepseek-ai/deepseek-harness | e8f7b93a344964de3dca1ace9e72b6e4d6de87cb | Replaceable services, model profiles, agent loop, headless execution |
| deepseek-ai/dsh-superagent-prototype | 8c32a9dc5d72c033816c6a8110b37f40cf94fba4 | Durable state transitions, outbox effects, recovery, explicit stopping states |
| badlogic/pi-mono | b22e525b325ff1934b4110f7fc60426fd6f0a8f3 | Terminal interaction, OpenAI-compatible model profiles, CLI execution |

Official source repositories: https://github.com/deepseek-ai/deepseek-harness, https://github.com/deepseek-ai/dsh-superagent-prototype, https://github.com/badlogic/pi-mono.

The ERNIE raster logo was supplied by the user. The current SVG symbol and wordmarks were independently redrawn from the supplied geometric reference; original raster assets are retained for provenance. Branding does not imply endorsement or official product status.

Model research references and evidence boundaries are in docs/research/model-adaptation.md. Experiment environment modifications and reference test scripts must be preserved with their source versions and notices.

Pinned upstream notices for the reference snippets are preserved in eval/references/LICENSE.deepseek-harness, LICENSE.dsh-superagent-prototype, LICENSE.pi-mono and LICENSE.swe-bench. eval/references/sources.json records the exact revision, original license location and SHA256; SOURCES.md explains the flattened reference filenames. These documents and upstream test files are research data, not runtime project instructions.


## Project license and brand rights

Original ERNIE Harness source code and website code are available under the root MIT LICENSE, copyright 2026 Yao Yuhao. Third-party reference files remain under their preserved upstream licenses and notices. The MIT license does not grant rights to third-party trademarks, names or logos. ERNIE/Baidu, DeepSeek, Pi and Anthropic names identify their respective projects or models and do not imply affiliation or endorsement. User-supplied logo references and derived brand artwork are excluded from any claim to third-party trademark rights.

The presentation structure of the public website was informed by https://www.deepseek.com/harness/ (accessed November 13, 2026). Its markup, styles, illustrations and marketing copy were independently authored here; no upstream website assets are bundled.
