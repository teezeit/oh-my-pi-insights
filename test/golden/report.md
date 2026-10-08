# omp Insights
> 2026-09-01 to 2026-09-02 | 2 sessions | Generated <date>

## 📊 By the Numbers
| Metric | Value |
|--------|-------|
| Sessions | 2 (2 active days) |
| User Messages | 17 |
| Total Cost | $10.00 |
| Tokens In | 2.0M |
| Tokens Out | 330k |
| Cache Read | 40.0M |
| Cache Write | 2.0M |
| Lines Added | 400 |
| Lines Removed | 120 |
| Files Touched | 9 |
| Git Commits | 3 |
| Git Pushes | 2 |
| Tool Errors | 5 |
| Steering / Interruptions | 2 |
| Thinking Escalations | 3 |
| Model Switches | 1 |
| Compactions | 1 |
| Median TTFT | 2.1s |
| Median Reply Wait | 60s |
| Parallel Sessions | 0 overlap events across 0 sessions |

## 🚦 Interruptions and Failures
| Metric | Value |
|--------|-------|
| Interruption rate | 11.8% of human messages |
| Aborted generations | 0 (0 ended the session there) |
| Steering messages | 2 |
| Provider errors | 0 |
| TTSR rule injections | 0 |
| Context reset boundaries | 0 |

## 💰 Where the Money Went
| Bucket | Cost | Share |
|--------|------|-------|
| Primary sessions | $7.00 | 70.0% |
| Advisor sidecars (1 log) | $1.00 | 10.0% |
| Subagent sidecars (2 logs) | $2.00 | 20.0% |
| **Total** | **$10.00** | 100% |

Out-of-band model calls (titles, auto-thinking, advisor prompts) inside that total: $0.50. 1 of 2 sessions had at least one sidecar.

**Cache efficiency:** 95.2% overall hit ratio (cacheRead / (input + cacheRead)). A low ratio on a large prompt is the resumed-stale-session tax: context re-read from scratch instead of hitting cache, burning money and latency.

**Worst sessions by cache hit ratio** (>=50k input+cacheRead tokens):
| Project | Ratio | Tokens | Cost |
|---------|-------|--------|------|
| jar | 0.0% | 500k | $4.00 |
| webapp | 96.4% | 41.5M | $6.00 |

## 🔧 Tools
| Tool | Calls |
|------|-------|
| bash | 50 |
| read | 25 |
| edit | 10 |
| grep | 6 |
| xd://mcp__posthog_exec | 3 |

**Failures by tool** (from `toolResult.isError`, not text matching):
- Shell Failed: 3
- Edit Failed: 1
- Read Failed: 1

## 📁 Languages and Projects
Languages: TypeScript (12), Go (5), Markdown (4)

| Project | Sessions |
|---------|----------|
| webapp | 1 |
| jar | 1 |

## 🔍 Corpus
Scanned `/fixture/sessions`: 4 distinct sessions, 1 advisor sidecars, 2 subagent sidecars, 1 duplicate log(s) dropped.

| Excluded | Sessions |
|----------|----------|
| Current session | 1 |
| Insights meta-sessions | 1 |
| Unparseable | 0 |
| Below substance floor (<2 user messages or <1 min) | 1 |
| Outside --since window | 0 |
| **Included** | **2** |

Facet coverage: 1 of 2 sessions analysed, 1 extraction(s) failed. Sessions without facets still count in every deterministic number above; they are absent only from the LLM-derived sections.

Session set and per-session cost: `<data-dir>/session-set.json`

## ⚙️ Your Setup
- Default model: `anthropic/claude-opus-5`
- Model roles: default=`anthropic/claude-opus-5`, smol=`anthropic/claude-haiku-4-5`
- Fallback chains: default: anthropic/claude-opus-5 → github-copilot/gpt-5.6-terra
- Skills: 1 user + 2 managed
- Extensions: orca-agent-status
- Hooks: pre/eval.ts
- MCP servers: atlassian, outline
- Global instruction rules read: 1

## 💸 Model Spend
| Model | Cost | Messages | List $/Mtok in / out |
|-------|------|----------|----------------------|
| claude-opus-5 | $9.50 | 60 | unknown |
| gpt-5.5 | $0.50 | 6 | unknown |
