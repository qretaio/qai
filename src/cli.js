#!/usr/bin/env node
import { spawn, execSync } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, platform } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import yaml from "js-yaml";
import yargs from "yargs";
import { hideBin } from "yargs/helpers";

function isCommandAvailable(cmd) {
  try {
    execSync(platform() === "win32" ? `where ${cmd}` : `which ${cmd}`, {
      stdio: "ignore",
    });
    return true;
  } catch {
    return false;
  }
}

const proxyPath = fileURLToPath(import.meta.resolve("nvidia-claude-proxy"));
const configPath = join(homedir(), ".config", "qai", "config.yaml");

function killTree(pid) {
  try {
    if (platform() === "win32") {
      execSync(`taskkill /PID ${pid} /T /F`, { stdio: "ignore" });
    } else {
      execSync(`kill -9 -${pid}`, { stdio: "ignore" });
    }
  } catch {
    try {
      process.kill(pid);
    } catch {}
  }
}

const PROVIDERS = {
  zai: { baseUrl: "https://api.z.ai/api/anthropic" },
  nvidia: {
    needsProxy: true,
    baseUrl: "https://integrate.api.nvidia.com/v1/chat/completions",
  },
  ollama: {
    baseUrl: "http://localhost:11434",
  },
};

const DEFAULT_AGENT = "claude";

function loadConfig() {
  if (!existsSync(configPath)) return {};
  return yaml.load(readFileSync(configPath, "utf8"));
}

function findPort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.listen(0, () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
    server.on("error", reject);
  });
}

function spawnProxy(baseUrl, token, port, env, verbose) {
  return spawn("node", [proxyPath], {
    stdio: "inherit",
    env: {
      ...process.env,
      ...env,
      PROVIDER_API_KEY: token,
      UPSTREAM_URL: baseUrl,
      PORT: String(port),
      ...(verbose && { VERBOSE: "1" }),
    },
    detached: false,
    windowsHide: true,
    windowsVerbatimArguments: false,
  });
}

function exitWith(proc) {
  const cleanup = () => {
    if (proc && proc.pid) {
      killTree(proc.pid);
    }
    process.exit(0);
  };
  proc.on("exit", (code) => process.exit(code ?? 0));
  process.on("SIGINT", cleanup);
  process.on("SIGTERM", cleanup);
  process.on("SIGUSR1", cleanup);
  process.on("SIGUSR2", cleanup);
  process.on("exit", cleanup);
}

function getProvider(cfg, name) {
  const p = cfg.providers?.[name];
  if (!p) return null;

  const type = p.provider || "zai";
  const def = PROVIDERS[type];
  if (!def) return { error: `Unknown provider type '${type}'` };

  let base_url = p.base_url || p.endpoint || def.baseUrl;
  return {
    ...p,
    type,
    needsProxy: def.needsProxy,
    base_url,
    agent: p.agent || DEFAULT_AGENT,
    token: p.token ?? "",
  };
}

// Update pi's models.json to point to the specified ollama endpoint
function updatePiOllamaConfig(baseUrl, model) {
  const piConfigDir = join(homedir(), ".pi", "agent");
  const piModelsPath = join(piConfigDir, "models.json");

  if (!existsSync(piModelsPath)) return;

  try {
    const piConfig = JSON.parse(readFileSync(piModelsPath, "utf8"));

    if (piConfig.providers?.ollama) {
      // Update the ollama provider's baseUrl and model
      piConfig.providers.ollama.baseUrl = `${baseUrl}/v1`;
      if (model) {
        piConfig.providers.ollama.models = [
          {
            _launch: true,
            contextWindow: 262144,
            id: model,
            input: ["text"],
          },
        ];
      }

      writeFileSync(piModelsPath, JSON.stringify(piConfig, null, 2));
    }
  } catch {
    // Ignore errors - pi config is optional
  }
}

function runLs(cfg) {
  const providers = cfg.providers || {};
  const names = Object.keys(providers);
  const defaultName = cfg.provider?.default;

  if (names.length === 0) {
    console.log("No providers configured. Create", configPath);
    return;
  }

  console.log("Providers:");

  for (const name of names) {
    const p = providers[name];
    const marker = name === defaultName ? "*" : " ";
    const type = p.provider || "zai";
    const agent = p.agent || DEFAULT_AGENT;
    const hasToken = p.token ? "✓" : "-";
    console.log(
      ` ${marker} ${name.padEnd(10)} ${type.padEnd(8)} agent:${agent.padEnd(8)} token:${hasToken}`,
    );
  }
}

// Pre-process args to extract options before positional args confuse yargs
function preprocessArgs(rawArgs) {
  const options = {};
  const remaining = [];
  let i = 0;

  while (i < rawArgs.length) {
    const arg = rawArgs[i];

    if (arg === "-p" || arg === "--provider") {
      options.provider = rawArgs[++i];
    } else if (arg === "-m" || arg === "--model") {
      options.model = rawArgs[++i];
    } else if (arg.startsWith("--provider=")) {
      options.provider = arg.slice("--provider=".length);
    } else if (arg.startsWith("-p=")) {
      options.provider = arg.slice("-p=".length);
    } else if (arg.startsWith("--model=")) {
      options.model = arg.slice("--model=".length);
    } else if (arg.startsWith("-m=")) {
      options.model = arg.slice("-m=".length);
    } else {
      remaining.push(arg);
    }
    i++;
  }

  return { options, remaining };
}

async function main() {
  // Pre-process to extract provider/model before yargs
  const { options: preprocessedOptions, remaining: remainingArgs } =
    preprocessArgs(hideBin(process.argv));

  const parser = yargs(remainingArgs)
    .option("provider", {
      alias: "p",
      type: "string",
      description: "Provider name",
    })
    .option("model", {
      alias: "m",
      type: "string",
      description: "Model to use",
    })
    .command(
      "$0 [agent] [args..]",
      "Launch agent with configured provider",
      (yargs) => {
        yargs.positional("agent", {
          type: "string",
          describe: "Agent CLI to run",
          default: DEFAULT_AGENT,
        });
      },
    )
    .command("proxy", "Start proxy only")
    .command(
      "ls",
      "List available providers",
      () => {},
      (argv) => {
        const cfg = loadConfig();
        runLs(cfg);
        process.exit(0);
      },
    );

  const argv = await parser
    .demandCommand(1)
    .strict()
    .parserConfiguration({
      "unknown-options-as-args": true,
    })
    .help()
    .parse();

  // Merge preprocessed options with yargs options (preprocessed takes priority)
  const provider = preprocessedOptions.provider || argv.provider;
  const model = preprocessedOptions.model || argv.model;

  const cfg = loadConfig();
  const name = provider || cfg.provider?.default;

  if (!name) {
    console.error("Error: No provider. Create", configPath);
    process.exit(1);
  }

  const p = getProvider(cfg, name);
  if (!p) {
    console.error(`Error: Unknown provider '${name}'`);
    process.exit(1);
  }
  if (p.error) {
    console.error("Error:", p.error);
    process.exit(1);
  }

  const cmd = argv._[0];

  if (cmd === "proxy") {
    if (!p.needsProxy) {
      console.error(`Error: proxy not available for '${p.type}'`);
      process.exit(1);
    }
    const port = await findPort();
    console.log(`${name} proxy on :${port}\n`);

    exitWith(spawnProxy(p.base_url, p.token, port, p.env, true));
    return;
  }

  // Default command: run agent
  const agent = argv.agent || p.agent || DEFAULT_AGENT;

  if (!isCommandAvailable(agent)) {
    console.error(`Error: '${agent}' CLI not found in PATH`);
    process.exit(1);
  }

  if (p.needsProxy) {
    const port = await findPort();
    console.log(`${name} proxy on :${port}\n`);
    const proxy = spawnProxy(p.base_url, p.token, port, p.env, false);
    await new Promise((r) => setTimeout(r, 500));

    const agentProc = spawn(agent, argv.args || [], {
      stdio: "inherit",
      env: {
        ...process.env,
        ...p.env,
        ANTHROPIC_MODEL: model || p.model,
        ANTHROPIC_AUTH_TOKEN: "qai-proxy",
        ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}`,
      },
      detached: false,
    });

    const cleanup = () => {
      if (proxy && proxy.pid) killTree(proxy.pid);
      if (agentProc && agentProc.pid) killTree(agentProc.pid);
      process.exit(1);
    };
    agentProc.on("exit", (code) => {
      cleanup();
      process.exit(code ?? 0);
    });
    proxy.on("exit", () => {
      cleanup();
    });
    process.on("SIGINT", cleanup);
    process.on("SIGTERM", cleanup);
    process.on("SIGUSR1", cleanup);
    process.on("SIGUSR2", cleanup);
    process.on("exit", cleanup);
    process.on("uncaughtException", cleanup);
    process.on("unhandledRejection", cleanup);
  } else {
    // Build env vars based on provider type
    const envVars = {
      ...process.env,
      ...p.env,
    };

    // For ollama provider, set OLLAMA_HOST environment variable
    // Note: Some agents (like pi) may not respect this and need their own config
    if (p.type === "ollama") {
      if (p.base_url) {
        envVars.OLLAMA_HOST = p.base_url;
        envVars.ANTHROPIC_BASE_URL = p.base_url;
      }
      if (model || p.model) {
        envVars.ANTHROPIC_MODEL = model || p.model;
      }
      envVars.ANTHROPIC_AUTH_TOKEN = p.token ?? "";
    } else {
      envVars.ANTHROPIC_AUTH_TOKEN = p.token ?? "";
      if (p.base_url) {
        envVars.ANTHROPIC_BASE_URL = p.base_url;
      }
      if (model || p.model) {
        envVars.ANTHROPIC_MODEL = model || p.model;
      }
    }

    // Update pi's config if using ollama provider with pi agent
    if (p.type === "ollama" && agent === "pi") {
      updatePiOllamaConfig(p.base_url, model || p.model);
    }

    const agentProc = spawn(agent, argv.args || [], {
      stdio: "inherit",
      env: envVars,
    });
    exitWith(agentProc);
  }
}

main().catch((err) => {
  console.error("Error:", err.message);
  process.exit(1);
});
