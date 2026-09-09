import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseEnv, promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

const execute = promisify(execFile);
const roots: string[] = [];
const windowsEnv = { ...process.env };
for (const key of Object.keys(windowsEnv)) {
  if (key.toLowerCase() === "psmodulepath") delete windowsEnv[key];
}
afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

describe.skipIf(process.platform !== "win32")("Windows initialization wizard", () => {
  it.each([false, true])("fetches models and saves configuration (existing .env: %s)", async (hasExisting) => {
    const root = await mkdtemp(join(tmpdir(), "code-agent-init-"));
    roots.push(root);
    if (hasExisting) await writeFile(join(root, ".env"), 'OTHER="keep#this"\nCODE_AGENT_MODEL=old\n');
    let receivedPath = "";
    let receivedAuthorization = "";
    const server = createServer((request, response) => {
      receivedPath = request.url ?? "";
      receivedAuthorization = request.headers.authorization ?? "";
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ data: [{ id: "model-b" }, { id: "model-a" }, { id: "model-b" }] }));
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    try {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("No server address");
      const baseUrl = `http://127.0.0.1:${address.port}/v1`;
      const quote = (value: string) => "'" + value.replace(/'/g, "''") + "'";
      const command = `
        $global:answers = [Collections.Generic.Queue[string]]::new()
        @(${quote(baseUrl + "/")}, 'invalid', '99', '2') | ForEach-Object { $global:answers.Enqueue($_) }
        function Read-Host {
          param([string]$Prompt, [switch]$AsSecureString)
          if ($AsSecureString) { return ConvertTo-SecureString 'test#key=123' -AsPlainText -Force }
          return $global:answers.Dequeue()
        }
        & ${quote(resolve("scripts/init-config.ps1"))} -ConfigRoot ${quote(root)}
      `;
      const result = await execute("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", command], { env: windowsEnv });
      expect(receivedPath).toBe("/v1/models");
      expect(receivedAuthorization).toBe("Bearer test#key=123");
      expect(result.stdout).toContain("Enter one of the listed numbers.");
      expect(result.stdout + result.stderr).not.toContain("test#key=123");
      expect(parseEnv(await readFile(join(root, ".env"), "utf8"))).toEqual({
        ...(hasExisting ? { OTHER: "keep#this" } : {}), CODE_AGENT_BASE_URL: baseUrl,
        CODE_AGENT_API_KEY: "test#key=123", CODE_AGENT_MODEL: "model-b"
      });
    } finally {
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
  }, 15000);

  it("leaves existing .env intact and hides provider errors when fetching fails", async () => {
    const root = await mkdtemp(join(tmpdir(), "code-agent-init-"));
    roots.push(root);
    await writeFile(join(root, ".env"), "CODE_AGENT_MODEL=original\n");
    const quote = (value: string) => "'" + value.replace(/'/g, "''") + "'";
    const command = `
      function Read-Host {
        param([string]$Prompt, [switch]$AsSecureString)
        if ($AsSecureString) { return ConvertTo-SecureString 'secret-test' -AsPlainText -Force }
        if ($Prompt -like 'Base URL*') { return 'https://example.invalid/v1' }
        return 'q'
      }
      function Invoke-RestMethod { throw 'Provider echoed secret-test' }
      & ${quote(resolve("scripts/init-config.ps1"))} -ConfigRoot ${quote(root)}
    `;
    try {
      await execute("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", command], { env: windowsEnv });
      throw new Error("Expected failure");
    } catch (error) {
      const result = error as { code: number; stdout: string; stderr: string };
      expect(result.code).toBe(1);
      expect(result.stdout).toContain("Could not fetch");
      expect(result.stdout + result.stderr).not.toContain("secret-test");
    }
    expect(await readFile(join(root, ".env"), "utf8")).toBe("CODE_AGENT_MODEL=original\n");
  }, 15000);
});
