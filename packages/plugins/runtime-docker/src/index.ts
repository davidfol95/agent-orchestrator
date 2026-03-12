import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { dirname, join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { promisify } from "node:util";
import type {
  AttachInfo,
  PluginModule,
  Runtime,
  RuntimeCreateConfig,
  RuntimeHandle,
  RuntimeMetrics,
} from "@composio/ao-core";

const execFileAsync = promisify(execFile);
const COMMAND_TIMEOUT_MS = 30_000;
const TMUX_COMMAND_TIMEOUT_MS = 5_000;
const SHELL_READY_DELAY_MS = 800;
const SAFE_SESSION_ID = /^[a-zA-Z0-9_-]+$/;

interface DockerRuntimeOptions {
  image: string;
  shell: string;
  serviceName: string;
  startupCommand: string;
  dashboardPorts: number[];
  portRangeStart: number;
  portRangeSize: number;
  user: string | null;
  extraMounts: string[];
  environment: Record<string, string>;
}

interface LeaseRecord {
  sessionId: string;
  containerPorts: number[];
  hostPorts: number[];
}

export const manifest = {
  name: "docker",
  slot: "runtime" as const,
  description: "Runtime plugin: docker compose worker stacks with tmux control",
  version: "0.1.0",
};

function assertValidSessionId(id: string): void {
  if (!SAFE_SESSION_ID.test(id)) {
    throw new Error(`Invalid session ID "${id}": must match ${SAFE_SESSION_ID}`);
  }
}

async function run(command: string, args: string[], timeout = COMMAND_TIMEOUT_MS): Promise<string> {
  const { stdout } = await execFileAsync(command, args, { timeout });
  return stdout.trimEnd();
}

async function dockerCompose(args: string[]): Promise<string> {
  return run("docker", ["compose", ...args]);
}

async function docker(args: string[]): Promise<string> {
  return run("docker", args);
}

async function tmux(args: string[]): Promise<string> {
  return run("tmux", args, TMUX_COMMAND_TIMEOUT_MS);
}

function parseNumberArray(input: unknown): number[] {
  if (!Array.isArray(input)) return [];
  return input.flatMap((value) => {
    if (typeof value === "number" && Number.isInteger(value) && value > 0) return [value];
    if (typeof value === "string") {
      const parsed = Number.parseInt(value, 10);
      if (Number.isInteger(parsed) && parsed > 0) return [parsed];
    }
    return [];
  });
}

function parseStringArray(input: unknown): string[] {
  if (!Array.isArray(input)) return [];
  return input.filter((value): value is string => typeof value === "string" && value.length > 0);
}

function parseStringRecord(input: unknown): Record<string, string> {
  if (!input || typeof input !== "object") return {};
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(input)) {
    if (typeof value === "string") {
      result[key] = value;
    }
  }
  return result;
}

function normalizeOptions(config?: Record<string, unknown>): DockerRuntimeOptions {
  const user =
    typeof config?.["user"] === "string"
      ? config["user"]
      : typeof process.getuid === "function" && typeof process.getgid === "function"
        ? `${process.getuid()}:${process.getgid()}`
        : null;

  return {
    image:
      typeof config?.["image"] === "string" && config["image"].length > 0
        ? config["image"]
        : "node:20-bookworm",
    shell:
      typeof config?.["shell"] === "string" && config["shell"].length > 0
        ? config["shell"]
        : "/bin/bash",
    serviceName:
      typeof config?.["serviceName"] === "string" && config["serviceName"].length > 0
        ? config["serviceName"]
        : "worker",
    startupCommand:
      typeof config?.["startupCommand"] === "string" && config["startupCommand"].length > 0
        ? config["startupCommand"]
        : "while true; do sleep 3600; done",
    dashboardPorts: parseNumberArray(config?.["dashboardPorts"]),
    portRangeStart:
      typeof config?.["portRangeStart"] === "number" && Number.isInteger(config["portRangeStart"])
        ? config["portRangeStart"]
        : 38000,
    portRangeSize:
      typeof config?.["portRangeSize"] === "number" && Number.isInteger(config["portRangeSize"])
        ? config["portRangeSize"]
        : 4000,
    user,
    extraMounts: parseStringArray(config?.["extraMounts"]),
    environment: parseStringRecord(config?.["environment"]),
  };
}

function yamlString(value: string): string {
  return JSON.stringify(value);
}

function getProjectBaseDir(environment: Record<string, string>): string {
  const dataDir = environment["AO_DATA_DIR"];
  if (!dataDir) {
    throw new Error("AO_DATA_DIR is required for the docker runtime");
  }
  return resolve(dataDir, "..");
}

function getLeaseDir(projectBaseDir: string): string {
  return join(projectBaseDir, "docker-port-leases");
}

function getLeasePath(projectBaseDir: string, sessionName: string): string {
  return join(getLeaseDir(projectBaseDir), `${sessionName}.json`);
}

function getComposeDir(projectBaseDir: string, sessionName: string): string {
  return join(projectBaseDir, "docker", sessionName);
}

function readLease(leasePath: string): LeaseRecord | null {
  if (!existsSync(leasePath)) return null;
  try {
    const parsed = JSON.parse(readFileSync(leasePath, "utf-8")) as Partial<LeaseRecord>;
    if (
      !parsed.sessionId ||
      !Array.isArray(parsed.containerPorts) ||
      !Array.isArray(parsed.hostPorts)
    ) {
      return null;
    }
    const containerPorts = parseNumberArray(parsed.containerPorts);
    const hostPorts = parseNumberArray(parsed.hostPorts);
    if (containerPorts.length !== hostPorts.length) return null;
    return { sessionId: parsed.sessionId, containerPorts, hostPorts };
  } catch {
    return null;
  }
}

function writeLease(leasePath: string, lease: LeaseRecord): void {
  mkdirSync(dirname(leasePath), { recursive: true });
  writeFileSync(leasePath, JSON.stringify(lease, null, 2), "utf-8");
}

async function isHostPortAvailable(port: number): Promise<boolean> {
  return await new Promise((resolvePromise) => {
    const server = createServer();
    server.once("error", () => resolvePromise(false));
    server.once("listening", () => {
      server.close(() => resolvePromise(true));
    });
    server.listen(port, "127.0.0.1");
  });
}

function hashInt(value: string): number {
  return Number.parseInt(createHash("sha256").update(value).digest("hex").slice(0, 8), 16);
}

async function allocateHostPorts(
  projectBaseDir: string,
  sessionName: string,
  containerPorts: number[],
  rangeStart: number,
  rangeSize: number,
): Promise<LeaseRecord | null> {
  if (containerPorts.length === 0) return null;

  const leasePath = getLeasePath(projectBaseDir, sessionName);
  const existing = readLease(leasePath);
  if (
    existing &&
    JSON.stringify(existing.containerPorts) === JSON.stringify(containerPorts) &&
    existing.hostPorts.length === containerPorts.length
  ) {
    return existing;
  }

  const leaseDir = getLeaseDir(projectBaseDir);
  mkdirSync(leaseDir, { recursive: true });
  const usedPorts = new Set<number>();
  for (const file of readdirSync(leaseDir)) {
    if (!file.endsWith(".json") || file === `${sessionName}.json`) continue;
    const lease = readLease(join(leaseDir, file));
    for (const port of lease?.hostPorts ?? []) {
      usedPorts.add(port);
    }
  }

  const blockSize = containerPorts.length;
  const totalBlocks = Math.floor(rangeSize / blockSize);
  if (totalBlocks <= 0) {
    throw new Error("docker runtime port range is too small for the requested dashboard ports");
  }

  const startIndex = hashInt(`${projectBaseDir}:${sessionName}`) % totalBlocks;
  for (let probe = 0; probe < totalBlocks; probe++) {
    const blockIndex = (startIndex + probe) % totalBlocks;
    const blockStart = rangeStart + blockIndex * blockSize;
    const hostPorts = containerPorts.map((_, offset) => blockStart + offset);
    if (hostPorts.some((port) => usedPorts.has(port))) continue;
    const availability = await Promise.all(hostPorts.map((port) => isHostPortAvailable(port)));
    if (!availability.every(Boolean)) continue;
    const lease = { sessionId: sessionName, containerPorts, hostPorts };
    writeLease(leasePath, lease);
    return lease;
  }

  throw new Error("Failed to allocate deterministic host ports for docker runtime");
}

function buildDashboardMetadata(lease: LeaseRecord | null): Record<string, string> {
  if (!lease || lease.hostPorts.length === 0) return {};
  const dashboardUrls = Object.fromEntries(
    lease.containerPorts.map((containerPort, index) => [
      String(containerPort),
      `http://127.0.0.1:${lease.hostPorts[index]}`,
    ]),
  );

  return {
    dashboardPort: String(lease.hostPorts[0]),
    dashboardUrl: `http://127.0.0.1:${lease.hostPorts[0]}`,
    dashboardUrls: JSON.stringify(dashboardUrls),
  };
}

function sanitizeComposeProject(sessionName: string, projectBaseDir: string): string {
  const suffix = createHash("sha256").update(projectBaseDir).digest("hex").slice(0, 8);
  return `ao-${suffix}-${sessionName}`
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .slice(0, 63);
}

function splitMount(mount: string): { source: string; target: string; readOnly: boolean } {
  const [source, target, mode] = mount.split(":");
  if (!source || !target) {
    throw new Error(`Invalid docker extraMount entry: ${mount}`);
  }
  return { source, target, readOnly: mode === "ro" };
}

function buildComposeFile(params: {
  options: DockerRuntimeOptions;
  environment: Record<string, string>;
  workspacePath: string;
  lease: LeaseRecord | null;
}): string {
  const { options, environment, workspacePath, lease } = params;
  const mounts = [
    { source: workspacePath, target: workspacePath, readOnly: false },
    { source: environment["AO_DATA_DIR"]!, target: environment["AO_DATA_DIR"]!, readOnly: false },
    ...options.extraMounts.map(splitMount),
  ];
  const envEntries = { ...options.environment, ...environment };
  const lines = [
    "services:",
    `  ${options.serviceName}:`,
    `    image: ${yamlString(options.image)}`,
    `    working_dir: ${yamlString(workspacePath)}`,
    "    tty: true",
    "    stdin_open: true",
    "    init: true",
  ];

  if (options.user) {
    lines.push(`    user: ${yamlString(options.user)}`);
  }

  lines.push(
    `    command: [${yamlString(options.shell)}, "-lc", ${yamlString(options.startupCommand)}]`,
  );
  lines.push("    environment:");
  for (const [key, value] of Object.entries(envEntries)) {
    lines.push(`      ${key}: ${yamlString(value)}`);
  }

  lines.push("    volumes:");
  for (const mount of mounts) {
    lines.push("      - type: bind");
    lines.push(`        source: ${yamlString(resolve(mount.source))}`);
    lines.push(`        target: ${yamlString(mount.target)}`);
    if (mount.readOnly) {
      lines.push("        read_only: true");
    }
  }

  if (lease && lease.hostPorts.length > 0) {
    lines.push("    ports:");
    for (let index = 0; index < lease.hostPorts.length; index++) {
      lines.push(
        `      - ${yamlString(`${lease.hostPorts[index]}:${lease.containerPorts[index]}`)}`,
      );
    }
  }

  return `${lines.join("\n")}\n`;
}

function shellEscape(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function buildDockerExecShellCommand(
  composeProject: string,
  composeFile: string,
  serviceName: string,
  shellPath: string,
): string {
  return `docker compose -p ${shellEscape(composeProject)} -f ${shellEscape(composeFile)} exec ${shellEscape(serviceName)} ${shellEscape(shellPath)}`;
}

async function writeTmuxMessage(target: string, message: string): Promise<void> {
  await tmux(["send-keys", "-t", target, "C-u"]);
  if (message.includes("\n") || message.length > 200) {
    const bufferName = `ao-${randomUUID()}`;
    const tmpPath = join("/tmp", `ao-docker-send-${randomUUID()}.txt`);
    writeFileSync(tmpPath, message, { encoding: "utf-8", mode: 0o600 });
    try {
      await tmux(["load-buffer", "-b", bufferName, tmpPath]);
      await tmux(["paste-buffer", "-b", bufferName, "-t", target, "-d"]);
    } finally {
      try {
        unlinkSync(tmpPath);
      } catch {
        void 0;
      }
      try {
        await tmux(["delete-buffer", "-b", bufferName]);
      } catch {
        void 0;
      }
    }
  } else {
    await tmux(["send-keys", "-t", target, "-l", message]);
  }
  await sleep(300);
  await tmux(["send-keys", "-t", target, "Enter"]);
}

async function safeTmuxKill(sessionName: string): Promise<void> {
  try {
    await tmux(["kill-session", "-t", sessionName]);
  } catch {
    void 0;
  }
}

async function safeComposeDown(composeProject: string, composeFile?: string): Promise<void> {
  try {
    const args = ["-p", composeProject];
    if (composeFile) {
      args.push("-f", composeFile);
    }
    args.push("down", "--volumes", "--remove-orphans");
    await dockerCompose(args);
    return;
  } catch {
    void 0;
  }

  try {
    const containers = await docker([
      "ps",
      "-a",
      "--filter",
      `label=com.docker.compose.project=${composeProject}`,
      "--format",
      "{{.ID}}",
    ]);
    for (const id of containers.split("\n").filter(Boolean)) {
      try {
        await docker(["rm", "-f", id]);
      } catch {
        void 0;
      }
    }
  } catch {
    void 0;
  }

  try {
    const networks = await docker([
      "network",
      "ls",
      "--filter",
      `label=com.docker.compose.project=${composeProject}`,
      "--format",
      "{{.ID}}",
    ]);
    for (const id of networks.split("\n").filter(Boolean)) {
      try {
        await docker(["network", "rm", id]);
      } catch {
        void 0;
      }
    }
  } catch {
    void 0;
  }
}

function removeLease(leaseFile: string | undefined): void {
  if (!leaseFile || !existsSync(leaseFile)) return;
  try {
    unlinkSync(leaseFile);
  } catch {
    void 0;
  }
}

function removeComposeArtifacts(composeFile: string | undefined): void {
  if (!composeFile) return;
  try {
    rmSync(dirname(composeFile), { recursive: true, force: true });
  } catch {
    void 0;
  }
}

async function isComposeServiceRunning(
  composeProject: string,
  serviceName: string,
): Promise<boolean> {
  try {
    const output = await docker([
      "ps",
      "--filter",
      `label=com.docker.compose.project=${composeProject}`,
      "--filter",
      `label=com.docker.compose.service=${serviceName}`,
      "--format",
      "{{.ID}}",
    ]);
    return output.trim().length > 0;
  } catch {
    return false;
  }
}

export function create(config?: Record<string, unknown>): Runtime {
  const options = normalizeOptions(config);

  return {
    name: "docker",

    async create(runtimeConfig: RuntimeCreateConfig): Promise<RuntimeHandle> {
      assertValidSessionId(runtimeConfig.sessionId);
      const projectBaseDir = getProjectBaseDir(runtimeConfig.environment);
      const sessionName = runtimeConfig.environment["AO_SESSION_NAME"] ?? runtimeConfig.sessionId;
      const composeProject = sanitizeComposeProject(sessionName, projectBaseDir);
      const lease = await allocateHostPorts(
        projectBaseDir,
        sessionName,
        options.dashboardPorts,
        options.portRangeStart,
        options.portRangeSize,
      );
      const composeDir = getComposeDir(projectBaseDir, sessionName);
      mkdirSync(composeDir, { recursive: true });
      const composeFile = join(composeDir, "compose.yml");
      writeFileSync(
        composeFile,
        buildComposeFile({
          options,
          environment: runtimeConfig.environment,
          workspacePath: runtimeConfig.workspacePath,
          lease,
        }),
        "utf-8",
      );

      await dockerCompose([
        "-p",
        composeProject,
        "-f",
        composeFile,
        "up",
        "-d",
        "--remove-orphans",
        options.serviceName,
      ]);

      const attachShellCommand = buildDockerExecShellCommand(
        composeProject,
        composeFile,
        options.serviceName,
        options.shell,
      );
      const envArgs: string[] = [];
      for (const [key, value] of Object.entries(runtimeConfig.environment)) {
        envArgs.push("-e", `${key}=${value}`);
      }

      try {
        await tmux([
          "new-session",
          "-d",
          "-s",
          runtimeConfig.sessionId,
          "-c",
          runtimeConfig.workspacePath,
          ...envArgs,
          attachShellCommand,
        ]);
        await sleep(SHELL_READY_DELAY_MS);
        await writeTmuxMessage(runtimeConfig.sessionId, runtimeConfig.launchCommand);
      } catch (err) {
        await safeTmuxKill(runtimeConfig.sessionId);
        await safeComposeDown(composeProject, composeFile);
        removeComposeArtifacts(composeFile);
        removeLease(getLeasePath(projectBaseDir, sessionName));
        throw err;
      }

      const metadata = buildDashboardMetadata(lease);
      return {
        id: runtimeConfig.sessionId,
        runtimeName: "docker",
        data: {
          createdAt: Date.now(),
          workspacePath: runtimeConfig.workspacePath,
          composeProject,
          composeFile,
          serviceName: options.serviceName,
          leaseFile: getLeasePath(projectBaseDir, sessionName),
          metadata: {
            ...metadata,
            dockerComposeProject: composeProject,
            dockerComposeFile: composeFile,
          },
        },
      };
    },

    async destroy(handle: RuntimeHandle): Promise<void> {
      const composeProject =
        typeof handle.data["composeProject"] === "string" ? handle.data["composeProject"] : "";
      const composeFile =
        typeof handle.data["composeFile"] === "string" ? handle.data["composeFile"] : undefined;
      const leaseFile =
        typeof handle.data["leaseFile"] === "string" ? handle.data["leaseFile"] : undefined;

      await safeTmuxKill(handle.id);
      if (composeProject) {
        await safeComposeDown(composeProject, composeFile);
      }
      removeComposeArtifacts(composeFile);
      removeLease(leaseFile);
    },

    async sendMessage(handle: RuntimeHandle, message: string): Promise<void> {
      await writeTmuxMessage(handle.id, message);
    },

    async getOutput(handle: RuntimeHandle, lines = 50): Promise<string> {
      try {
        return await tmux(["capture-pane", "-t", handle.id, "-p", "-S", `-${lines}`]);
      } catch {
        return "";
      }
    },

    async isAlive(handle: RuntimeHandle): Promise<boolean> {
      const composeProject =
        typeof handle.data["composeProject"] === "string" ? handle.data["composeProject"] : "";
      const serviceName =
        typeof handle.data["serviceName"] === "string"
          ? handle.data["serviceName"]
          : options.serviceName;
      const [tmuxAlive, containerAlive] = await Promise.all([
        tmux(["has-session", "-t", handle.id])
          .then(() => true)
          .catch(() => false),
        composeProject
          ? isComposeServiceRunning(composeProject, serviceName)
          : Promise.resolve(false),
      ]);
      return tmuxAlive && containerAlive;
    },

    async getMetrics(handle: RuntimeHandle): Promise<RuntimeMetrics> {
      const createdAt =
        typeof handle.data["createdAt"] === "number" ? handle.data["createdAt"] : Date.now();
      return { uptimeMs: Date.now() - createdAt };
    },

    async getAttachInfo(handle: RuntimeHandle): Promise<AttachInfo> {
      return {
        type: "tmux",
        target: handle.id,
        command: `tmux attach -t ${handle.id}`,
      };
    },
  };
}

export default { manifest, create } satisfies PluginModule<Runtime>;
