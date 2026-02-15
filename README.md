# qai

Multi-provider launcher for Claude Code with unified configuration management.

## Overview

QAI transparently routes Claude Code to different AI providers by intercepting API calls and translating between provider-specific formats. It supports both direct Anthropic-compatible endpoints and NVIDIA NIM endpoints that require protocol translation.

## Key Features

- **Multi-provider support**: Switch between different AI providers via command-line
- **Automatic proxy**: NVIDIA NIM endpoints automatically go through a translation proxy
- **Unified configuration**: Single YAML file manages all provider credentials
- **Clean process management**: Proper cleanup of proxy and Claude processes
- **Environment injection**: Provider-specific environment variables for Claude Code

## Architecture

```
┌─────────────────┐        ┌─────────────────┐        ┌──────────────┐
│   Claude Code   │───────▶ │      QAI        │───────▶ │   Provider   │
│                 │  STDIO  │                 │  HTTP   │              │
└─────────────────┘         └─────────────────┘         └──────────────┘
                            │  ↑                         ↑
                            │  │ Proxy (NVIDIA only)     │
                            └──┴─────────────────────────┘
```

Two modes:

- **Direct mode**: Claude Code connects directly to provider (Anthropic-compatible)
- **Proxy mode**: QAI starts an HTTP proxy that translates between Claude Code and NVIDIA NIM

## Setup

Create configuration file:

```bash
mkdir -p ~/.config/qai
touch ~/.config/qai/config.yaml
```

### Configuration Syntax

```yaml
# Optional: Set default provider
default: zai

# Provider definitions
providers:
  # Provider name (used with -p flag)
  zai:
    # Provider type: "zai" (default, Anthropic-compatible) or "nvidia"
    provider: "zai"
    # API authentication token
    token: "your-token-here"
    # Optional: Environment variables to pass to Claude Code
    env:
      ANTHROPIC_DEFAULT_OPUS_MODEL: "GLM-5"

  nim:
    provider: "nvidia"
    token: "nvapi-xxxxxxxxxxxxxxxxxxxxxxxxxx"
    # Optional: Custom base URL (defaults to NVIDIA endpoint)
    # base_url: "https://custom-nvidia-endpoint/v1"

  # Custom Anthropic-compatible endpoint
  custom:
    provider: "zai"
    token: "sk-ant-xxxxxxxx"
    base_url: "https://api.custom-provider.com/v1"
```

### Provider Types

| Type     | Description                              | Needs Proxy | Base URL Default                                       |
| -------- | ---------------------------------------- | ----------- | ------------------------------------------------------ |
| `zai`    | Anthropic-compatible (Claude API format) | No          | `https://api.z.ai/api/anthropic`                       |
| `nvidia` | NVIDIA NIM (requires translation)        | Yes         | `https://integrate.api.nvidia.com/v1/chat/completions` |

## Usage

### Launch Claude Code

```bash
# Use default provider
qai claude

# Specify provider by name
qai -p zai claude
qai -p nim claude

# Pass arguments to Claude Code
qai claude --help
qai -p zai claude /path/to/repo
```

### Debug Proxy

Start the translation proxy without launching Claude:

```bash
qai -p nim proxy
```

Output will show the local proxy port (e.g., `:58473`):

```
nim proxy on :58473
```

You can then test the proxy:

```bash
curl http://127.0.0.1:58473/v1/messages \
  -H "X-Api-Key: test" \
  -H "Content-Type: application/json" \
  -d '{"model":"claude-3-5-sonnet","messages":[]}'
```

## Configuration Details

### Required Fields

| Field      | Required When    | Description                        |
| ---------- | ---------------- | ---------------------------------- |
| `token`    | Always           | API authentication token           |
| `base_url` | Custom endpoints | Override default provider endpoint |

### Optional Fields

| Field      | Description                                      |
| ---------- | ------------------------------------------------ |
| `provider` | Provider type or `"zai"` (default)               |
| `env`      | Additional environment variables for Claude Code |
| `model`    | Model name to pass to Claude Code                |

### Environment Variables

The following environment variables are automatically set:

- `ANTHROPIC_AUTH_TOKEN`: Set to provider token
- `ANTHROPIC_BASE_URL`: Set to proxy URL (for NVIDIA) or custom base URL
- `ANTHROPIC_MODEL`: Set to provider's model if specified

Additional variables from the provider's `env` field are merged into Claude Code's environment.

## Troubleshooting

### "No provider" error

Create the configuration file or specify a provider with `-p`:

```bash
qai -p zai claude
```

### "Unknown provider" error

Check that the provider name in your config matches what you're using with `-p`.

### "No token" error

Add a `token` field to the provider configuration in `~/.config/qai/config.yaml`.

### Proxy not available

The `proxy` command only works with providers that require a proxy (currently only `nvidia` type).

### Process cleanup issues

QAI registers signal handlers for SIGINT, SIGTERM, and others to ensure proper cleanup. If processes remain, manually kill them:

```bash
# Find proxy processes
ps aux | grep nvidia-claude-proxy

# Kill process tree
kill -9 -<PID>
```
