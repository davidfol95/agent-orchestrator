import { beforeEach, describe, expect, it, vi } from "vitest";
import * as childProcess from "node:child_process";
import * as net from "node:net";
import * as fs from "node:fs";

vi.mock("node:child_process", () => {
  const mockExecFile = vi.fn();
  (mockExecFile as unknown as Record<PropertyKey, unknown>)[
    Symbol.for("nodejs.util.promisify.custom")
  ] = vi.fn();
  return { execFile: mockExecFile };
});

vi.mock("node:net", () => ({
  createServer: vi.fn(),
}));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    writeFileSync: vi.fn(actual.writeFileSync),
    mkdirSync: vi.fn(actual.mkdirSync),
    rmSync: vi.fn(actual.rmSync),
    unlinkSync: vi.fn(actual.unlinkSync),
  };
});

const mockExecFileCustom = (childProcess.execFile as unknown as Record<PropertyKey, unknown>)[
  Symbol.for("nodejs.util.promisify.custom")
] as ReturnType<typeof vi.fn>;

function queueStdout(stdout = ""): void {
  mockExecFileCustom.mockResolvedValueOnce({ stdout: `${stdout}\n`, stderr: "" });
}

function mockPortAvailable(): void {
  vi.mocked(net.createServer).mockImplementationOnce(() => {
    const server = {
      once: vi.fn((event: string, handler: () => void) => {
        if (event === "listening") process.nextTick(handler);
        return server;
      }),
      listen: vi.fn(),
      close: vi.fn((handler?: () => void) => handler?.()),
    };
    return server as unknown as net.Server;
  });
}

import { create } from "../index.js";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("runtime-docker", () => {
  it("creates compose stack, tmux shell, and dashboard metadata", async () => {
    mockPortAvailable();
    queueStdout();
    queueStdout();
    queueStdout();
    queueStdout();
    queueStdout();

    const runtime = create({ image: "node:20-bookworm", dashboardPorts: [3000] });
    const handle = await runtime.create({
      sessionId: "hash-app-1",
      workspacePath: "/tmp/worktree",
      launchCommand: "pnpm test",
      environment: {
        AO_DATA_DIR: "/tmp/project/sessions",
        AO_SESSION_NAME: "app-1",
        AO_SESSION: "app-1",
      },
    });

    expect(handle.runtimeName).toBe("docker");
    expect(handle.data["composeProject"]).toBeDefined();
    expect((handle.data["metadata"] as Record<string, string>)["dashboardUrl"]).toMatch(
      /^http:\/\/127\.0\.0\.1:/,
    );
    expect(mockExecFileCustom).toHaveBeenCalledWith(
      "docker",
      expect.arrayContaining([
        "compose",
        "-f",
        expect.stringContaining("compose.yml"),
        "up",
        "-d",
        "--remove-orphans",
        "worker",
      ]),
      expect.any(Object),
    );
    expect(mockExecFileCustom).toHaveBeenCalledWith(
      "tmux",
      expect.arrayContaining(["new-session", "-d", "-s", "hash-app-1"]),
      expect.any(Object),
    );
  });

  it("releases the compose stack and artifacts on destroy", async () => {
    queueStdout();
    queueStdout();

    const runtime = create();
    await runtime.destroy({
      id: "hash-app-1",
      runtimeName: "docker",
      data: {
        composeProject: "ao-test-app-1",
        composeFile: "/tmp/project/docker/app-1/compose.yml",
        leaseFile: "/tmp/project/docker-port-leases/app-1.json",
      },
    });

    expect(mockExecFileCustom).toHaveBeenCalledWith(
      "tmux",
      ["kill-session", "-t", "hash-app-1"],
      expect.any(Object),
    );
    expect(mockExecFileCustom).toHaveBeenCalledWith(
      "docker",
      [
        "compose",
        "-p",
        "ao-test-app-1",
        "-f",
        "/tmp/project/docker/app-1/compose.yml",
        "down",
        "--volumes",
        "--remove-orphans",
      ],
      expect.any(Object),
    );
    expect(vi.mocked(fs.rmSync)).toHaveBeenCalled();
  });
});
