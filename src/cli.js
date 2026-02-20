#!/usr/bin/env node
import { spawn, execSync } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, readFileSync } from "node:fs";
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
};

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

  return {
    ...p,
    type,
    needsProxy: def.needsProxy,
    base_url: p.base_url || def.baseUrl,
  };
}

function runLs(cfg) {
  const providers = cfg.providers || {};
  const names = Object.keys(providers);
  const defaultName = cfg.provider?.default;

  if (names.length === 0 && !isCommandAvailable("ollama")) {
    console.log("No providers configured. Create", configPath);
    return;
  }

  console.log("Providers:");

  for (const name of names) {
    const p = providers[name];
    const marker = name === defaultName ? "*" : " ";
    const type = p.provider || "zai";
    const hasToken = p.token ? "✓" : "✗";
    console.log(
      ` ${marker} ${name.padEnd(10)} ${type.padEnd(8)} token:${hasToken}`,
    );
  }

  if (isCommandAvailable("ollama")) {
    console.log(
      "   ollama     local    agents: claude, codex, droid, opencode",
    );
  }
}

function runOllama(agent, args, model) {
  if (!isCommandAvailable("ollama")) {
    console.error("Error: ollama CLI not found in PATH");
    console.error("Install ollama: https://ollama.com/download");
    process.exit(1);
  }

  const launchArgs = ["launch", agent];
  if (model) {
    launchArgs.push("--model", model);
  }
  if (args && args.length > 0) {
    launchArgs.push(...args);
  }

  const proc = spawn("ollama", launchArgs, {
    stdio: "inherit",
    detached: false,
  });

  exitWith(proc);
}

async function main() {
  const ollamaAvailable = isCommandAvailable("ollama");

  const parser = yargs(hideBin(process.argv))
    .option("provider", {
      alias: "p",
      type: "string",
      description: "Provider name",
    })
    .option("model", {
      alias: "m",
      type: "string",
      description: "Model to use (for ollama)",
    })
    .command("claude [args..]", "Launch claude")
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

  if (ollamaAvailable) {
    parser.command(
      "ollama [agent] [args..]",
      "Launch ollama integration (claude, codex, droid, opencode)",
      (yargs) => {
        yargs.positional("agent", {
          type: "string",
          describe:
            "Integration to launch (claude, codex, droid, opencode, openclaw)",
          default: "claude",
        });
      },
      (argv) => {
        runOllama(argv.agent, argv.args, argv.model);
      },
    );
  }

  const argv = await parser
    .demandCommand(1)
    .strict()
    .parserConfiguration({
      "unknown-options-as-args": true,
    })
    .help()
    .parse();

  const cfg = loadConfig();
  const name = argv.provider || cfg.provider?.default;

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
  if (!p.token) {
    console.error(`Error: No token for '${name}'`);
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

  if (cmd === "claude") {
    if (p.needsProxy) {
      const port = await findPort();
      console.log(`${name} proxy on :${port}\n`);
      const proxy = spawnProxy(p.base_url, p.token, port, p.env, false);
      await new Promise((r) => setTimeout(r, 500));

      const claude = spawn("claude", argv.args || [], {
        stdio: "inherit",
        env: {
          ...process.env,
          ...p.env,
          ANTHROPIC_MODEL: p.model,
          ANTHROPIC_AUTH_TOKEN: "qai-proxy",
          ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}`,
        },
        detached: false,
      });

      const cleanup = () => {
        if (proxy && proxy.pid) killTree(proxy.pid);
        if (claude && claude.pid) killTree(claude.pid);
        process.exit(1);
      };
      claude.on("exit", (code) => {
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
      const claude = spawn("claude", argv.args || [], {
        stdio: "inherit",
        env: {
          ...process.env,
          ...p.env,
          ANTHROPIC_AUTH_TOKEN: p.token,
          ...(p.base_url && { ANTHROPIC_BASE_URL: p.base_url }),
        },
      });
      exitWith(claude);
    }
  }
}

main().catch((err) => {
  console.error("Error:", err.message);
  process.exit(1);
});
