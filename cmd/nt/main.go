// nt — NOS Town CLI
//
// Single launch command and plain-text task interface for NOS Town.
// Mirrors the `gt` UX from Gas Town: one command to bring everything up,
// then just type what you want.
//
// Commands:
//
//	nt status       Show service health
//	nt prime        Print session context (for Claude Code injection)
//	nt              Interactive REPL (launches Node.js Mayor session)
//	nt <task>       One-shot task orchestration (plain text, no prefix needed)
package main

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
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

// ── nt status ─────────────────────────────────────────────────────────────────

func cmdStatus() {
	nosHome, err := findNosHome()
	if err != nil {
		nosHome = "(not found)"
	}

	agentID := envOrDefault("NOS_AGENT_ID", "mayor_01")
	rig := envOrDefault("NOS_RIG", "default")
	kgPath := envOrDefault("NOS_KG_PATH", "kg/knowledge_graph.sqlite")

	fmt.Printf("NOS Town Status\n")
	fmt.Printf("    Mayor       %s\n", agentID)
	fmt.Printf("    Rig         %s\n", rig)
	fmt.Printf("    KG          %s\n", kgPath)
	fmt.Printf("    Project     %s\n", nosHome)
}

// ── nt prime ──────────────────────────────────────────────────────────────────

func cmdPrime() {
	nosHome, err := findNosHome()
	if err != nil {
		nosHome = "(not found — set NOS_HOME)"
	}

	agentID := envOrDefault("NOS_AGENT_ID", "mayor_01")
	rig := envOrDefault("NOS_RIG", "default")
	kgPath := envOrDefault("NOS_KG_PATH", "kg/knowledge_graph.sqlite")

	fmt.Printf(`# NOS Town Context

Mayor: %s  |  Rig: %s  |  KG: %s

## Interaction model

Just type what you want — no syntax or command prefixes:

  nt add pagination to the witness vote API
  nt fix the convoy signature check
  nt refactor the KG query cache

## Commands

  nt status       Show service health
  nt prime        Print this context
  nt <task>       Orchestrate a task (one-shot)
  nt              Interactive REPL

## Architecture

  Mayor (orchestrator)    src/roles/mayor.ts
  Convoys (message bus)   src/convoys/
  KG (model routing)      src/kg/   [%s]
  Full docs:              docs/

## Project

  %s
`, agentID, rig, kgPath, kgPath, nosHome)
}

// ── Launch Node.js ─────────────────────────────────────────────────────────────

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
  NOS_KG_PATH             KG SQLite path (default: kg/knowledge_graph.sqlite)
`)
}
