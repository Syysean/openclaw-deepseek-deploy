# TOOLS.md — OpenClaw Infrastructure Reference
> **Scope**: Local infrastructure specifics — endpoints, paths, models, tools.  
> **Note**: This file is yours. Skills are shared; this is not. Update as your setup evolves.

---

## 🏗️ Infrastructure Overview

| Component | Value | Notes |
|---|---|---|
| **Proxy** | `siliconflow-proxy:13001` | Smart routing — 7-model dispatch |
| **Gateway** | `localhost:18789` | OpenClaw Web UI (acpx enabled) |
| **Docker Host** | `<YOUR_OS_VERSION>` | Host physical path: `<YOUR_HOST_OPENCLAW_PATH>` |
| **Config Dir** | `/home/node/.openclaw` | Mapped from host config |
| **Workspace Dir** | `/home/node/.openclaw/workspace` | Container root — whitelist files only |

### Workspace Directory Structure

```text
workspace/
├── AGENTS.md         ← Core behavior protocol
├── SOUL.md           ← Identity & tone
├── USER.md           ← User context
├── TOOLS.md          ← This file
├── HEARTBEAT.md      ← Heartbeat tasks
├── sandbox/          ← YOUR generated code, scripts, artifacts (R/W)
├── projects/         ← User's code — RESTRICTED
└── memory/
    ├── _meta/        ← aliases.md, templates.md
    ├── Tech/         ← Engineering, OpenClaw config, Project notes
    ├── Study/        ← Academic notes, Future plans/goals
    ├── Life/         ← Schedule, preferences
    ├── Inbox/        ← Quick captures, organize later
    └── Archive/      ← Outdated or deprecated notes
```

---

## 🔀 Model Routing Table

Handled by `proxy.js`. Routes are selected **automatically**. Do not manually select models.

| Route | Model | Trigger Condition |
|---|---|---|
| `text` | `Pro/deepseek-ai/DeepSeek-V3.2` | Default conversation |
| `tool` | `Pro/deepseek-ai/DeepSeek-V3.2` | Tool call execution |
| `vision` | `Qwen/Qwen3-VL-32B-Instruct` | Any message with an attached image |
| `reason` | `Pro/deepseek-ai/DeepSeek-R1` | Math, logic, multi-step reasoning |
| `code` | `Qwen/Qwen3-Coder-30B-A3B-Instruct` | Code generation, debugging, review |
| `embed` | `BAAI/bge-m3` | Memory encoding & vector search |
| `rerank` | `BAAI/bge-reranker-v2-m3` | Deep retrieval re-ranking |

---

## 🌐 Web Fetch Tool

**File**: `tools/web_fetch.cjs`  
**Purpose**: Fetches live web pages and search results as clean Markdown via Jina AI API (or Firecrawl).

```bash
node tools/web_fetch.cjs search "your query"
node tools/web_fetch.cjs read "[https://example.com](https://example.com)"
```

**Behavior Notes:**
- Output is Markdown, **truncated at 15,000 characters**.
- Use only at **Tier 3** of the retrieval strategy — after T1 and T2 have both been attempted.
- On failure (network error, API unavailable): report the error explicitly. Do not silently fall back to hallucination.

---

## 🤖 Multi-Agent Spawn (`sessions_spawn`)

The `acpx` plugin is enabled. `sessions_spawn` is available for delegating sub-tasks to child agents.

**Use for:** parallel independent research, simultaneous heavy code generation + retrieval, multi-topic analysis.  
**Do NOT use for:** single-step queries, direct `memory_search`, image analysis, or tasks under 30 seconds.  
**Failure fallback:** If `sessions_spawn` fails, execute sequentially in the main session and notify the user.

---

## 🚗 Example: User Project Integration

*(Note: Update this section with your own project specifics if you mount host directories into the container.)*

| Property | Value |
|---|---|
| **Host Repo Path** | `<YOUR_HOST_PROJECT_PATH>` (Host OS - INVISIBLE to Agent) |
| **Agent Repo Path**| `/home/node/projects/<YOUR_PROJECT_NAME>` (Requires volume mount to access) |
| **Startup** | **MANUAL (User's Task).** Agent CANNOT run host OS scripts (e.g., `.bat` or `.sh`). |
| **Main Service** | e.g., `main_app.py` (Port `3000` on host) |

---

## 📡 Channels

| Channel | Handle | Mode |
|---|---|---|
| Telegram | `@<YourTelegramBotHandle>` | DM only (pairing mode) |

---

## 🔧 Tool Failure Protocol

When any tool call fails:
1. **Report** the failure explicitly — do not silently proceed.
2. **State** which tool failed and the exact error message.
3. **Do not substitute** with hallucinated output.
4. **Offer** the user an alternative (retry, manual step, escalate tier).

> Example: "`deep_search` returned an error: [error]. I cannot retrieve this from local memory. Would you like me to search externally, or can you provide the information directly?"

---

## 🐳 Container Environment Limits

Running inside `openclaw:local` (node:24-bookworm). Hard limits apply:

| Command | Status | Rule |
|---|---|---|
| `python` | ❌ Not found | Use `python3` instead. |
| `pip` / `pip3` | ❌ Not available | Do not attempt. No variant of pip works in this container. |
| `python3 -m pip` | ❌ Not available | Same rule — no runtime package installation of any kind. |
| `apt-get` / `apk` / `sudo` | ❌ No root access | Forbidden. Tell the user if system dependencies are needed. |
| `node` / `curl` | ✅ Available | Standard usage. |

**If a third-party Python library is needed:** tell the user to add it to `docker-compose.override.yml` as a pre-installed dependency. Do not attempt to install it at runtime — it will vanish on restart anyway.

---

## 📌 Why TOOLS.md Exists Separately

Skills (`skills/*/SKILL.md`) define **how** work — they are shared and version-controlled.  
This file defines **your specific setup** — endpoints, paths, project states, personal channels.

- Skills can be updated or shared without exposing your infrastructure.
- Your infrastructure notes survive skill updates.

**Update this file whenever your setup changes.**