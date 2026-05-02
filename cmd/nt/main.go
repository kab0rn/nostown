// nt is the NOSTown operator CLI.
//
// The human shell is the Queen: a persistent tmux-backed operator session.
// Gas City bridge commands are non-interactive and JSON-safe.
package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
)

const (
	version     = "0.1.0"
	queenSess   = "nt-queen"
	queenTarget = "nt-queen:0.0"
)

type dotEnvEntry struct {
	key   string
	value string
}

func main() {
	args := os.Args[1:]
	if len(args) == 0 {
		cmdQueenAttach()
		return
	}

	switch args[0] {
	case "queen", "q":
		runQueen(args[1:])
	case "hive":
		runHive(args[1:])
	case "gascity":
		launchBridgeNode(append([]string{"gascity"}, args[1:]...))
	case "swarm":
		launchBridgeNode(append([]string{"swarm"}, args[1:]...))
	case "status":
		cmdHiveStatus()
	case "prime":
		cmdPrime()
	case "historian":
		nosHome := mustFindNosHome()
		launchNode(nosHome, append([]string{"historian"}, args[1:]...))
	case "bootstrap":
		cmdBootstrap(args[1:])
	case "help", "--help", "-h":
		printHelp()
	case "version", "--version", "-v":
		fmt.Printf("nt %s\n", version)
	default:
		// Plain text no longer drives the legacy role runtime from the wrapper.
		// Bring up the Queen shell and let the operator choose bridge actions.
		cmdQueenAttach()
	}
}

func runQueen(args []string) {
	sub := "attach"
	if len(args) > 0 {
		sub = args[0]
	}
	switch sub {
	case "attach", "at":
		cmdQueenAttach()
	case "start":
		if err := startQueen(false); err != nil {
			fatal(err)
		}
		fmt.Printf("Queen started. Attach with: nt queen attach\n")
	case "stop":
		if err := killQueen(); err != nil {
			fatal(err)
		}
		fmt.Printf("Queen stopped.\n")
	case "restart":
		_ = killQueen()
		if err := startQueen(true); err != nil {
			fatal(err)
		}
		fmt.Printf("Queen restarted. Attach with: nt queen attach\n")
	case "status":
		cmdQueenStatus()
	default:
		fatal(fmt.Errorf("unknown queen command %q", sub))
	}
}

func runHive(args []string) {
	if len(args) == 0 || args[0] == "status" {
		cmdHiveStatus()
		return
	}
	fatal(fmt.Errorf("unknown hive command %q", args[0]))
}

func cmdQueenAttach() {
	if err := ensureQueen(); err != nil {
		fatal(err)
	}
	if os.Getenv("TMUX") != "" {
		if err := runInteractive("tmux", "switch-client", "-t", queenSess); err == nil {
			return
		}
	}
	if err := runInteractive("tmux", "attach-session", "-t", queenSess); err != nil {
		fatal(err)
	}
}

func cmdQueenStatus() {
	if !hasSession(queenSess) {
		fmt.Println("Queen is not running")
		return
	}
	cmd := paneCommand()
	state := "running"
	if isShell(cmd) || cmd == "" {
		state = "stale"
	}
	fmt.Printf("Queen is %s\n", state)
	fmt.Printf("  Session: %s\n", queenSess)
	fmt.Printf("  Pane:    %s\n", cmd)
}

func cmdHiveStatus() {
	nosHome, err := findNosHome()
	if err != nil {
		nosHome = "(not found)"
	} else {
		applyDotEnv(nosHome)
	}
	fmt.Printf("NOSTown Hive\n")
	fmt.Printf("    Queen       %s\n", queenStatusText())
	fmt.Printf("    Comb        %s\n", filepath.Join(nosHome, "comb"))
	fmt.Printf("    Project     %s\n", nosHome)
	fmt.Printf("    Groq        %s\n", configured(os.Getenv("GROQ_API_KEY") != ""))
	fmt.Printf("    DeepSeek    %s\n", configured(os.Getenv("DEEPSEEK_API_KEY") != ""))
}

func cmdPrime() {
	nosHome, err := findNosHome()
	if err != nil {
		nosHome = "(not found — set NOS_HOME)"
	}
	fmt.Printf(`# NOSTown Queen Context

Queen: operator shell
Hive: local NOSTown runtime
Comb: %s

## Interaction model

  nt                 Attach to the Queen shell
  nt queen attach    Attach to the persistent Queen shell
  nt hive status     Show runtime status
  nt swarm <bead>    Run pure swarm consensus

## Gas City bridge

Gas City stays static. Add only city.toml configuration:

[[agent]]
name = "nostown"
scope = "city"
min_active_sessions = 0
max_active_sessions = 1
work_query = "printf ''"
sling_query = "nt gascity swarm --bead {} --mode apply --json"

Bridge protocol terms stay generic: worker, judge, arbiter, consensus.

Project: %s
`, filepath.Join(nosHome, "comb"), nosHome)
}

func cmdBootstrap(args []string) {
	nosHome := mustFindNosHome()
	routingTable := filepath.Join(nosHome, "docs", "internal-runtime", "ROUTING.md")
	if len(args) > 1 && args[0] == "--routing-table" {
		routingTable = args[1]
	}
	bootstrapScript := filepath.Join(nosHome, "src", "historian", "bootstrap-kg.ts")
	cmd := exec.Command("npx", "tsx", bootstrapScript, "--routing-table", routingTable)
	cmd.Dir = nosHome
	cmd.Stdin = os.Stdin
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	cmd.Env = buildEnv(nosHome)
	exitWith(cmd.Run())
}

func ensureQueen() error {
	if !hasSession(queenSess) {
		fmt.Println("Queen session not running, starting...")
		return startQueen(true)
	}
	if isShell(paneCommand()) {
		fmt.Println("Queen runtime exited, respawning...")
		return respawnQueen()
	}
	return nil
}

func startQueen(_ bool) error {
	if _, err := exec.LookPath("tmux"); err != nil {
		return fmt.Errorf("tmux is required for nt queen attach: %w", err)
	}
	if hasSession(queenSess) {
		return fmt.Errorf("Queen session already running")
	}
	nosHome := mustFindNosHome()
	applyDotEnv(nosHome)
	return run("tmux", "new-session", "-d", "-s", queenSess, "-c", nosHome, queenCommand(nosHome))
}

func respawnQueen() error {
	nosHome := mustFindNosHome()
	applyDotEnv(nosHome)
	return run("tmux", "respawn-pane", "-k", "-t", queenTarget, "-c", nosHome, queenCommand(nosHome))
}

func killQueen() error {
	if !hasSession(queenSess) {
		return nil
	}
	return run("tmux", "kill-session", "-t", queenSess)
}

func queenCommand(nosHome string) string {
	name, args := nodeInvocation(nosHome, []string{"queen-shell"})
	parts := []string{"cd", shellQuote(nosHome), "&&", "exec", "env", "NOS_HOME=" + shellQuote(nosHome), shellQuote(name)}
	for _, arg := range args {
		parts = append(parts, shellQuote(arg))
	}
	return strings.Join(parts, " ")
}

func hasSession(name string) bool {
	return exec.Command("tmux", "has-session", "-t", name).Run() == nil
}

func paneCommand() string {
	var stdout bytes.Buffer
	cmd := exec.Command("tmux", "display-message", "-p", "-t", queenTarget, "#{pane_current_command}")
	cmd.Stdout = &stdout
	if err := cmd.Run(); err != nil {
		return ""
	}
	return strings.TrimSpace(stdout.String())
}

func isShell(cmd string) bool {
	switch filepath.Base(cmd) {
	case "sh", "bash", "zsh", "fish", "tcsh", "csh":
		return true
	default:
		return false
	}
}

func queenStatusText() string {
	if !hasSession(queenSess) {
		return "stopped"
	}
	if isShell(paneCommand()) {
		return "stale"
	}
	return "running"
}

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
	return "", fmt.Errorf("NOSTown project not found; set NOS_HOME, run install-nt.sh, or cd into the project")
}

func mustFindNosHome() string {
	path, err := findNosHome()
	if err != nil {
		fatal(err)
	}
	return path
}

func launchNode(nosHome string, args []string) {
	name, cmdArgs := nodeInvocation(nosHome, args)
	cmd := exec.Command(name, cmdArgs...)
	cmd.Dir = nosHome
	cmd.Stdin = os.Stdin
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	cmd.Env = buildEnv(nosHome)
	exitWith(cmd.Run())
}

func launchBridgeNode(args []string) {
	nosHome, err := findNosHome()
	if err != nil {
		writeBridgeError(args, err)
		os.Exit(1)
	}
	name, cmdArgs := nodeInvocation(nosHome, args)
	cmd := exec.Command(name, cmdArgs...)
	cmd.Dir = nosHome
	cmd.Stdin = os.Stdin
	cmd.Env = buildEnv(nosHome)
	if isBridgeWatch(args) {
		cmd.Stdout = os.Stdout
		cmd.Stderr = os.Stderr
		err = cmd.Run()
		if err == nil {
			return
		}
		if exitErr, ok := err.(*exec.ExitError); ok {
			os.Exit(exitErr.ExitCode())
		}
		writeBridgeError(args, err)
		os.Exit(1)
	}

	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	err = cmd.Run()
	if stderr.Len() > 0 {
		_, _ = os.Stderr.Write(stderr.Bytes())
	}
	if err == nil {
		_, _ = os.Stdout.Write(stdout.Bytes())
		return
	}
	if stdoutLooksJson(stdout.Bytes()) {
		_, _ = os.Stdout.Write(stdout.Bytes())
		if exitErr, ok := err.(*exec.ExitError); ok {
			os.Exit(exitErr.ExitCode())
		}
		os.Exit(1)
	}
	if stdout.Len() > 0 {
		fmt.Fprintf(os.Stderr, "[nt gascity] discarded non-json stdout from failed bridge command: %s\n", strings.TrimSpace(limitString(stdout.String(), 500)))
	}
	writeBridgeError(args, err)
	os.Exit(1)
}

func nodeInvocation(nosHome string, args []string) (string, []string) {
	distEntrypoint := filepath.Join(nosHome, "dist", "index.js")
	if _, err := os.Stat(distEntrypoint); err == nil {
		return "node", append([]string{distEntrypoint}, args...)
	}
	srcEntrypoint := filepath.Join(nosHome, "src", "index.ts")
	return "npx", append([]string{"tsx", srcEntrypoint}, args...)
}

func isBridgeWatch(args []string) bool {
	return len(args) >= 2 && args[0] == "gascity" && args[1] == "watch"
}

func stdoutLooksJson(data []byte) bool {
	trimmed := bytes.TrimSpace(data)
	if len(trimmed) == 0 {
		return false
	}
	var payload any
	return json.Unmarshal(trimmed, &payload) == nil
}

func limitString(value string, max int) string {
	if len(value) <= max {
		return value
	}
	return value[:max] + "..."
}

func buildEnv(nosHome string) []string {
	env := os.Environ()
	if os.Getenv("NOS_HOME") == "" {
		env = append(env, "NOS_HOME="+nosHome)
	}
	for _, entry := range readDotEnv(nosHome) {
		if os.Getenv(entry.key) != "" {
			continue
		}
		env = append(env, entry.key+"="+entry.value)
	}
	return env
}

func applyDotEnv(nosHome string) {
	for _, entry := range readDotEnv(nosHome) {
		if os.Getenv(entry.key) != "" {
			continue
		}
		_ = os.Setenv(entry.key, entry.value)
	}
}

func readDotEnv(nosHome string) []dotEnvEntry {
	data, err := os.ReadFile(filepath.Join(nosHome, ".env"))
	if err != nil {
		return nil
	}
	var entries []dotEnvEntry
	for _, line := range strings.Split(string(data), "\n") {
		if entry, ok := parseDotEnvLine(line); ok {
			entries = append(entries, entry)
		}
	}
	return entries
}

func parseDotEnvLine(line string) (dotEnvEntry, bool) {
	line = strings.TrimSpace(line)
	if line == "" || strings.HasPrefix(line, "#") {
		return dotEnvEntry{}, false
	}
	idx := strings.IndexByte(line, '=')
	if idx < 1 {
		return dotEnvEntry{}, false
	}
	key := strings.TrimSpace(line[:idx])
	if !isDotEnvKey(key) {
		return dotEnvEntry{}, false
	}
	return dotEnvEntry{key: key, value: strings.TrimSpace(line[idx+1:])}, true
}

func isDotEnvKey(key string) bool {
	if key == "" {
		return false
	}
	for i, r := range key {
		if r == '_' || (r >= 'A' && r <= 'Z') || (r >= 'a' && r <= 'z') || (i > 0 && r >= '0' && r <= '9') {
			continue
		}
		return false
	}
	return true
}

func writeBridgeError(args []string, err error) {
	fmt.Fprintf(os.Stderr, "[nt gascity] %s\n", err)
	payload := map[string]any{
		"ok":     false,
		"schema": "gascity.swarm.result.v1",
		"status": "error",
		"error":  err.Error(),
	}
	if len(args) > 0 {
		payload["command"] = args[0]
	}
	data, jsonErr := json.Marshal(payload)
	if jsonErr != nil {
		fmt.Println(`{"ok":false,"schema":"gascity.swarm.result.v1","status":"error","error":"bridge launch failed"}`)
		return
	}
	fmt.Println(string(data))
}

func run(name string, args ...string) error {
	cmd := exec.Command(name, args...)
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	return cmd.Run()
}

func runInteractive(name string, args ...string) error {
	cmd := exec.Command(name, args...)
	cmd.Stdin = os.Stdin
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	return cmd.Run()
}

func shellQuote(s string) string {
	return "'" + strings.ReplaceAll(s, "'", "'\"'\"'") + "'"
}

func configured(ok bool) string {
	if ok {
		return "configured"
	}
	return "not configured"
}

func exitWith(err error) {
	if err == nil {
		return
	}
	if exitErr, ok := err.(*exec.ExitError); ok {
		os.Exit(exitErr.ExitCode())
	}
	os.Exit(1)
}

func fatal(err error) {
	fmt.Fprintln(os.Stderr, "Error:", err)
	os.Exit(1)
}

func printHelp() {
	fmt.Print(`NOSTown — Queen CLI and Gas City swarm bridge

Usage:
  nt                         Attach to Queen shell
  nt queen attach            Start/attach Queen shell
  nt queen start|stop|restart|status
  nt hive status             Show local runtime status
  nt swarm <bead>            Run pure swarm consensus
  nt gascity swarm --bead <id> --mode pure|apply --json
  nt gascity swarm --stdin --json
  nt gascity watch --mode apply
  nt gascity doctor

Gas City city.toml:
  [[agent]]
  name = "nostown"
  scope = "city"
  min_active_sessions = 0
  max_active_sessions = 1
  work_query = "printf ''"
  sling_query = "nt gascity swarm --bead {} --mode apply --json"
`)
}
