// nt — NOS Town CLI
//
// Single launch command and plain-text task interface for NOS Town.
// Mirrors the `gt` UX from Gas Town: one command to bring everything up,
// then just type what you want.
//
// Commands:
//
//	nt up           Start MemPalace server (idempotent)
//	nt down         Stop MemPalace server
//	nt status       Show service health
//	nt prime        Print session context (for Claude Code injection)
//	nt              Interactive REPL (launches Node.js Mayor session)
//	nt <task>       One-shot task orchestration (plain text, no prefix needed)
package main

import (
	"fmt"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"time"
)

const version = "0.1.0"

// ── Entry point ───────────────────────────────────────────────────────────────

func main() {
	args := os.Args[1:]

	if len(args) == 0 {
		nosHome := mustFindNosHome()
		launchNode(nosHome, "--interactive")
		return
	}

	switch args[0] {
	case "up":
		cmdUp()
	case "down":
		cmdDown()
	case "status":
		cmdStatus()
	case "prime":
		cmdPrime()
	case "help", "--help", "-h":
		printHelp()
	case "version", "--version", "-v":
		fmt.Printf("nt %s\n", version)
	default:
		// Everything else → plain-text task
		nosHome := mustFindNosHome()
		task := strings.Join(args, " ")
		launchNode(nosHome, task)
	}
}

// ── Project root discovery ────────────────────────────────────────────────────

// findNosHome resolves the NOS Town project root via three mechanisms:
//  1. NOS_HOME environment variable
//  2. ~/.nostown/home config file (written by install-nt.sh)
//  3. Walk up from cwd looking for nos-town package.json
func findNosHome() (string, error) {
	if h := os.Getenv("NOS_HOME"); h != "" {
		return filepath.Abs(h)
	}

	homeDir, err := os.UserHomeDir()
	if err == nil {
		configFile := filepath.Join(homeDir, ".nostown", "home")
		if data, err := os.ReadFile(configFile); err == nil {
			if path := strings.TrimSpace(string(data)); path != "" {
				return path, nil
			}
		}
	}

	// Walk up from cwd
	cwd, err := os.Getwd()
	if err != nil {
		return "", fmt.Errorf("cannot determine cwd: %w", err)
	}
	dir := cwd
	for {
		pkgData, err := os.ReadFile(filepath.Join(dir, "package.json"))
		if err == nil && strings.Contains(string(pkgData), `"nos-town"`) {
			return dir, nil
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			break
		}
		dir = parent
	}

	return "", fmt.Errorf("NOS Town project not found\n" +
		"  Fix: set NOS_HOME env var, or run install-nt.sh, or cd into the project")
}

func mustFindNosHome() string {
	path, err := findNosHome()
	if err != nil {
		fmt.Fprintln(os.Stderr, "Error:", err)
		os.Exit(1)
	}
	return path
}

// ── Process state: ~/.nostown/ ────────────────────────────────────────────────

func nosTownDir() (string, error) {
	homeDir, err := os.UserHomeDir()
	if err != nil {
		return "", err
	}
	dir := filepath.Join(homeDir, ".nostown")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return "", err
	}
	return dir, nil
}

func writePID(name string, pid int) error {
	dir, err := nosTownDir()
	if err != nil {
		return err
	}
	return os.WriteFile(filepath.Join(dir, name+".pid"), []byte(strconv.Itoa(pid)), 0o644)
}

func readPID(name string) (int, error) {
	dir, err := nosTownDir()
	if err != nil {
		return 0, err
	}
	data, err := os.ReadFile(filepath.Join(dir, name+".pid"))
	if err != nil {
		return 0, err
	}
	return strconv.Atoi(strings.TrimSpace(string(data)))
}

func removePID(name string) {
	dir, err := nosTownDir()
	if err != nil {
		return
	}
	os.Remove(filepath.Join(dir, name+".pid"))
}

func isProcessAlive(pid int) bool {
	proc, err := os.FindProcess(pid)
	if err != nil {
		return false
	}
	return proc.Signal(syscall.Signal(0)) == nil
}

// ── MemPalace health check ────────────────────────────────────────────────────

func palacePort() string {
	if p := os.Getenv("MEMPALACE_PORT"); p != "" {
		return p
	}
	return "7474"
}

func isPalaceRunning(port string) bool {
	client := &http.Client{Timeout: 2 * time.Second}
	resp, err := client.Get(fmt.Sprintf("http://localhost:%s/health", port))
	if err != nil {
		return false
	}
	resp.Body.Close()
	return resp.StatusCode == 200
}

// ── nt up ────────────────────────────────────────────────────────────────────

func cmdUp() {
	nosHome := mustFindNosHome()
	port := palacePort()

	fmt.Println("NOS Town starting...")

	// Check existing PID
	if pid, err := readPID("palace"); err == nil && isProcessAlive(pid) {
		if isPalaceRunning(port) {
			fmt.Printf("  ✓ MemPalace     localhost:%s (pid %d, already running)\n", port, pid)
			fmt.Println("\nReady. Run 'nt' for interactive session or 'nt <task>'.")
			return
		}
		// Stale PID: process alive but palace not responding — kill and restart
		proc, _ := os.FindProcess(pid)
		proc.Signal(syscall.SIGTERM)
		time.Sleep(500 * time.Millisecond)
		removePID("palace")
	}

	pid, err := startPalace(nosHome, port)
	if err != nil {
		fmt.Fprintf(os.Stderr, "  ✗ MemPalace     failed: %v\n", err)
		os.Exit(1)
	}

	// Wait up to 10s for palace to respond
	healthy := false
	for i := 0; i < 20; i++ {
		time.Sleep(500 * time.Millisecond)
		if isPalaceRunning(port) {
			healthy = true
			break
		}
	}

	if healthy {
		fmt.Printf("  ✓ MemPalace     localhost:%s (pid %d)\n", port, pid)
	} else {
		dir, _ := nosTownDir()
		logPath := filepath.Join(dir, "palace.log")
		fmt.Fprintf(os.Stderr, "  ✗ MemPalace     started (pid %d) but not responding after 10s\n", pid)
		fmt.Fprintf(os.Stderr, "    Check logs: %s\n", logPath)
		os.Exit(1)
	}

	fmt.Println("\nReady. Run 'nt' for interactive session or 'nt <task>'.")
}

func startPalace(nosHome, port string) (int, error) {
	dir, err := nosTownDir()
	if err != nil {
		return 0, err
	}

	logPath := filepath.Join(dir, "palace.log")
	logFile, err := os.OpenFile(logPath, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o644)
	if err != nil {
		return 0, fmt.Errorf("cannot open log file %s: %w", logPath, err)
	}

	palaceDir := filepath.Join(nosHome, "mempalace-server")

	// Prefer uv, fall back to python3
	var cmd *exec.Cmd
	if _, err := exec.LookPath("uv"); err == nil {
		cmd = exec.Command("uv", "run", "python", "server.py")
	} else if _, err := exec.LookPath("python3"); err == nil {
		cmd = exec.Command("python3", "server.py")
	} else {
		logFile.Close()
		return 0, fmt.Errorf("neither 'uv' nor 'python3' found in PATH")
	}

	cmd.Dir = palaceDir
	cmd.Stdout = logFile
	cmd.Stderr = logFile
	cmd.Env = append(buildEnv(nosHome),
		fmt.Sprintf("MEMPALACE_PORT=%s", port),
	)
	// Detach from the terminal so palace outlives this process
	cmd.SysProcAttr = &syscall.SysProcAttr{Setsid: true}

	if err := cmd.Start(); err != nil {
		logFile.Close()
		return 0, err
	}

	pid := cmd.Process.Pid
	if err := writePID("palace", pid); err != nil {
		fmt.Fprintf(os.Stderr, "Warning: could not write palace.pid: %v\n", err)
	}

	// Detach the wait — process is now independent
	go cmd.Wait() //nolint:errcheck

	return pid, nil
}

// ── nt down ──────────────────────────────────────────────────────────────────

func cmdDown() {
	fmt.Println("NOS Town stopping...")

	pid, err := readPID("palace")
	if err != nil {
		fmt.Println("  - MemPalace     not running")
		return
	}

	if !isProcessAlive(pid) {
		fmt.Printf("  - MemPalace     not running (stale pid %d)\n", pid)
		removePID("palace")
		return
	}

	proc, _ := os.FindProcess(pid)
	if err := proc.Signal(syscall.SIGTERM); err != nil {
		fmt.Fprintf(os.Stderr, "  ✗ MemPalace     kill failed: %v\n", err)
	} else {
		removePID("palace")
		fmt.Printf("  ✓ MemPalace     stopped (pid %d)\n", pid)
	}
}

// ── nt status ────────────────────────────────────────────────────────────────

func cmdStatus() {
	nosHome, err := findNosHome()
	if err != nil {
		nosHome = "(not found)"
	}

	port := palacePort()
	agentID := envOrDefault("NOS_AGENT_ID", "mayor_01")
	rig := envOrDefault("NOS_RIG", "default")

	palaceSymbol := "✗"
	palaceDetail := "offline"
	if isPalaceRunning(port) {
		palaceSymbol = "✓"
		palaceDetail = "ok"
	}

	pidStr := ""
	if pid, err := readPID("palace"); err == nil {
		if isProcessAlive(pid) {
			pidStr = fmt.Sprintf(" pid %d", pid)
		} else {
			pidStr = fmt.Sprintf(" stale pid %d", pid)
		}
	}

	fmt.Printf("NOS Town Status\n")
	fmt.Printf("  %s MemPalace   localhost:%s (%s%s)\n", palaceSymbol, port, palaceDetail, pidStr)
	fmt.Printf("    Mayor       %s\n", agentID)
	fmt.Printf("    Rig         %s\n", rig)
	fmt.Printf("    Project     %s\n", nosHome)
}

// ── nt prime ─────────────────────────────────────────────────────────────────

func cmdPrime() {
	nosHome, err := findNosHome()
	if err != nil {
		nosHome = "(not found — set NOS_HOME)"
	}

	port := palacePort()
	agentID := envOrDefault("NOS_AGENT_ID", "mayor_01")
	rig := envOrDefault("NOS_RIG", "default")

	palaceStatus := "offline — run 'nt up'"
	if isPalaceRunning(port) {
		palaceStatus = "ok"
	}

	fmt.Printf(`# NOS Town Context

Mayor: %s  |  Rig: %s  |  Palace: localhost:%s (%s)

## Interaction model

Just type what you want — no syntax or command prefixes:

  nt add pagination to the witness vote API
  nt fix the convoy signature check
  nt refactor the KG query cache

## Commands

  nt up           Start MemPalace server (idempotent)
  nt down         Stop MemPalace server
  nt status       Show service health
  nt prime        Print this context
  nt <task>       Orchestrate a task (one-shot)
  nt              Interactive REPL

## Architecture

  Mayor (orchestrator)    src/roles/mayor.ts
  MemPalace (memory)      mempalace-server/server.py  :%s
  Convoys (message bus)   src/convoys/
  KG (model routing)      src/kg/
  Full docs:              docs/

## Project

  %s
`, agentID, rig, port, palaceStatus, port, nosHome)
}

// ── Launch Node.js ────────────────────────────────────────────────────────────

// launchNode runs `npx tsx src/index.ts <arg>` with stdin/stdout/stderr
// connected to the terminal, then exits with the same code as Node.js.
func launchNode(nosHome, arg string) {
	entrypoint := filepath.Join(nosHome, "src", "index.ts")

	cmd := exec.Command("npx", "tsx", entrypoint, arg)
	cmd.Dir = nosHome
	cmd.Stdin = os.Stdin
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	cmd.Env = buildEnv(nosHome)

	if err := cmd.Run(); err != nil {
		if exitErr, ok := err.(*exec.ExitError); ok {
			os.Exit(exitErr.ExitCode())
		}
		os.Exit(1)
	}
}

// ── Helpers ───────────────────────────────────────────────────────────────────

// buildEnv merges the current environment with any KEY=VALUE pairs from
// $NOS_HOME/.env, skipping keys that are already set in the environment.
func buildEnv(nosHome string) []string {
	env := os.Environ()

	envFile := filepath.Join(nosHome, ".env")
	data, err := os.ReadFile(envFile)
	if err != nil {
		return env
	}

	for _, line := range strings.Split(string(data), "\n") {
		line = strings.TrimSpace(line)
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		idx := strings.IndexByte(line, '=')
		if idx < 1 {
			continue
		}
		key := strings.TrimSpace(line[:idx])
		if key == "" || os.Getenv(key) != "" {
			continue // already set in environment — don't override
		}
		env = append(env, line)
	}

	return env
}

func envOrDefault(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}

func printHelp() {
	fmt.Print(`NOS Town — Groq-native multi-agent orchestration

Usage:
  nt                      Interactive session (REPL)
  nt <task>               Orchestrate any task — plain text, no syntax
  nt up                   Start MemPalace server
  nt down                 Stop MemPalace server
  nt status               Show service health
  nt prime                Print session context

Examples:
  nt add rate limiting to the polecat dispatch loop
  nt fix the convoy signature verification
  nt refactor the KG query cache to use LRU eviction
  nt what models are in the routing table?

Environment:
  GROQ_API_KEY            Required — Groq Cloud API key
  NOS_HOME                NOS Town project root (set by install-nt.sh)
  NOS_AGENT_ID            Mayor agent ID (default: mayor_01)
  NOS_RIG                 Active rig name (default: default)
  MEMPALACE_URL           MemPalace URL (default: http://localhost:7474)
  MEMPALACE_PORT          MemPalace port (default: 7474)
`)
}
