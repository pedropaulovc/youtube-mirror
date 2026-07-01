import { execSync, execFileSync, spawn } from "child_process";
import { existsSync, rmSync, mkdirSync, createWriteStream } from "fs";
import { basename, join } from "path";
import { createServer } from "net";
import { platform } from "os";

const LOCK_FILE = join(process.cwd(), ".next", "dev", "lock");
const NEXT_CACHE = join(process.cwd(), ".next");
const IS_WINDOWS = platform() === "win32";

/**
 * Kills zombie Next.js dev server for THIS project only.
 * Detects the lock file and finds node processes with this project's path.
 * Also wipes .next cache to ensure clean restart.
 */
function killZombieNextProcess() {
  if (!existsSync(LOCK_FILE)) {
    return;
  }

  const pids = IS_WINDOWS ? findZombiePidsWindows() : findZombiePidsUnix();

  if (pids.length === 0) {
    return;
  }

  console.log(
    `Found zombie Next.js process(es) for this project: PIDs ${pids.join(", ")}`
  );

  for (const pid of pids) {
    try {
      if (IS_WINDOWS) {
        execSync(`taskkill /PID ${pid} /T /F`, {
          stdio: ["pipe", "pipe", "pipe"],
        });
      } else {
        killProcessTree(pid);
      }
    } catch {
      // Process may have already exited
    }
  }

  console.log(`Killed ${pids.length} zombie process(es)`);

  // Small delay to ensure port is released
  execSync(IS_WINDOWS
    ? "pwsh.exe -NoProfile -Command Start-Sleep -Milliseconds 500"
    : "sleep 0.5",
    { stdio: "ignore" }
  );

  // Wipe .next cache for clean restart
  try {
    rmSync(NEXT_CACHE, { recursive: true, force: true });
    console.log("Wiped .next cache");
  } catch {
    // Ignore if already deleted or inaccessible
  }
}

function findZombiePidsWindows() {
  const projectPath = process.cwd().replace(/\//g, "\\");
  const escapedProjectPathForPwsh = projectPath.replace(/'/g, "''");
  const psCommand =
    `$projectPath = '${escapedProjectPathForPwsh}'; ` +
    `$escapedProjectPath = [regex]::Escape($projectPath); ` +
    "Get-CimInstance Win32_Process | " +
    "Where-Object { $_.Name -eq 'node.exe' -and $_.CommandLine -match $escapedProjectPath -and $_.CommandLine -match 'next\\W+dev' } | " +
    "Select-Object -ExpandProperty ProcessId";
  try {
    const output = execSync(`pwsh.exe -NoProfile -Command "${psCommand}"`, {
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    });
    return output
      .trim()
      .split(/\r?\n/)
      .filter((pid) => /^\d+$/.test(pid.trim()))
      .map((pid) => pid.trim());
  } catch {
    return [];
  }
}

/**
 * Recursively kills a process and all its descendants (Unix equivalent of taskkill /T).
 */
function killProcessTree(pid) {
  try {
    const children = execFileSync("ps", ["-o", "pid", "--no-headers", "--ppid", pid], {
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    });
    for (const childPid of children.trim().split(/\n/).map(p => p.trim()).filter(p => /^\d+$/.test(p))) {
      killProcessTree(childPid);
    }
  } catch {
    // No children or ps failed
  }
  try {
    process.kill(Number(pid), "SIGKILL");
  } catch {
    // Already exited
  }
}

function findZombiePidsUnix() {
  const projectPath = process.cwd();
  try {
    const psOutput = execFileSync("ps", ["ax", "-o", "pid,args"], {
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    });
    return psOutput
      .split(/\n/)
      .filter((line) => line.includes(projectPath) && /\bnext\s+dev\b/.test(line))
      .map((line) => line.trim().split(/\s+/)[0])
      .filter((pid) => /^\d+$/.test(pid) && pid !== String(process.pid));
  } catch {
    return [];
  }
}

/**
 * Maps worktree directory name to port number.
 * a=3010, b=3020, c=3030, ...
 * Supports both "project-a" and bare "a" patterns.
 * Anything else gets a dynamic port starting at 4000.
 */
function getPortForWorktree() {
  const dirName = basename(process.cwd());

  const match = dirName.match(/(?:^|-)([a-zA-Z])$/);
  if (match) {
    const letter = match[1].toUpperCase().charCodeAt(0);
    const port = 3010 + (letter - 65) * 10;
    return { port, strict: true };
  }

  return { port: 4000, strict: false };
}

/**
 * Check if a port is available by attempting to bind to it on all interfaces.
 */
function isPortAvailable(port) {
  return new Promise((resolve) => {
    const server = createServer();
    server.once("error", () => resolve(false));
    server.once("listening", () => {
      server.close(() => resolve(true));
    });
    server.listen(port, "::");
  });
}

/**
 * Find an available port starting from the given port.
 */
async function findAvailablePort(startPort) {
  for (let port = startPort; port < startPort + 100; port++) {
    if (await isPortAvailable(port)) {
      return port;
    }
  }
  throw new Error(`No available port found in range ${startPort}-${startPort + 99}`);
}

async function main() {
  killZombieNextProcess();

  const { port: desiredPort, strict } = getPortForWorktree();
  const dirName = basename(process.cwd());

  if (strict) {
    const available = await isPortAvailable(desiredPort);
    if (!available) {
      console.error(
        `\nPort ${desiredPort} is already in use!\n` +
          `   Worktree ${dirName} requires port ${desiredPort}.\n` +
          `   Kill the process using this port and try again.\n`
      );
      process.exit(1);
    }
    console.log(`Starting dev server on port ${desiredPort} (worktree ${dirName})`);
    startNextDev(desiredPort);
  } else {
    const port = await findAvailablePort(desiredPort);
    console.log(`Starting dev server on port ${port}`);
    startNextDev(port);
  }
}

function startNextDev(port) {
  const logsDir = join(process.cwd(), "logs");
  mkdirSync(logsDir, { recursive: true });
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-").replace("T", "_").slice(0, 19);
  const logPath = join(logsDir, `run-dev-${timestamp}.log`);
  const logStream = createWriteStream(logPath, { flags: "a" });

  console.log(`Logging to ${logPath}`);
  logStream.write(`=== Dev server started at ${new Date().toISOString()} on port ${port} ===\n`);

  const child = spawn("npx", ["next", "dev", "--turbopack", "--port", String(port)], {
    stdio: ["inherit", "pipe", "pipe"],
    shell: true,
  });

  child.stdout.on("data", (chunk) => {
    process.stdout.write(chunk);
    logStream.write(chunk);
  });
  child.stderr.on("data", (chunk) => {
    process.stderr.write(chunk);
    logStream.write(chunk);
  });

  child.on("close", (code) => {
    logStream.write(`\n=== Dev server exited with code ${code} at ${new Date().toISOString()} ===\n`);
    logStream.end();
    process.exit(code ?? 1);
  });

  for (const sig of ["SIGINT", "SIGTERM"]) {
    process.on(sig, () => child.kill(sig));
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
