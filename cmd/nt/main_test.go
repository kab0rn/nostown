package main

import (
	"bytes"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func TestBareNtStartsAndAttachesQueen(t *testing.T) {
	tmp := t.TempDir()
	logPath := filepath.Join(tmp, "tmux.log")
	runNtHelper(t, tmp, logPath, nil)

	log := readLog(t, logPath)
	assertLogContains(t, log, "has-session -t nt-queen")
	assertLogContains(t, log, "new-session -d -s nt-queen")
	assertLogContains(t, log, "attach-session -t nt-queen")
}

func TestQueenAttachRespawnsStalePane(t *testing.T) {
	tmp := t.TempDir()
	logPath := filepath.Join(tmp, "tmux.log")
	runNtHelper(t, tmp, logPath, []string{"queen", "attach"},
		"NT_FAKE_TMUX_HAS_SESSION=1",
		"NT_FAKE_TMUX_PANE=zsh",
	)

	log := readLog(t, logPath)
	assertLogContains(t, log, "display-message -p -t nt-queen:0.0 #{pane_current_command}")
	assertLogContains(t, log, "respawn-pane -k -t nt-queen:0.0")
	assertLogContains(t, log, "attach-session -t nt-queen")
}

func TestQueenStatusReportsStopped(t *testing.T) {
	tmp := t.TempDir()
	logPath := filepath.Join(tmp, "tmux.log")
	out := runNtHelper(t, tmp, logPath, []string{"queen", "status"})
	if !strings.Contains(out, "Queen is not running") {
		t.Fatalf("expected stopped status, got:\n%s", out)
	}
}

func TestGasCityMissingHomeEmitsJson(t *testing.T) {
	tmp := t.TempDir()
	writeFakeTmux(t, tmp)
	cmd := helperCmd(t, tmp, []string{"gascity", "doctor"})
	cmd.Dir = t.TempDir()
	cmd.Env = mergeEnv(os.Environ(),
		"GO_WANT_NT_HELPER_PROCESS=1",
		"PATH="+tmp+string(os.PathListSeparator)+os.Getenv("PATH"),
		"HOME="+t.TempDir(),
		"NOS_HOME=",
		"TMUX=",
	)
	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	err := cmd.Run()
	if err == nil {
		t.Fatal("expected missing NOS_HOME to fail")
	}
	var payload map[string]any
	if jsonErr := json.Unmarshal(stdout.Bytes(), &payload); jsonErr != nil {
		t.Fatalf("stdout was not JSON: %v\nstdout=%s\nstderr=%s", jsonErr, stdout.String(), stderr.String())
	}
	if payload["ok"] != false || payload["status"] != "error" {
		t.Fatalf("unexpected payload: %#v", payload)
	}
	if !strings.Contains(stderr.String(), "[nt gascity]") {
		t.Fatalf("expected bridge diagnostic on stderr, got %q", stderr.String())
	}
}

func TestGasCityChildCrashSynthesizesJson(t *testing.T) {
	tmp := t.TempDir()
	writeFakeTmux(t, tmp)
	writeFakeNpx(t, tmp, `#!/bin/sh
printf 'node exploded\n' >&2
exit 42
`)
	cmd := helperCmd(t, tmp, []string{"gascity", "swarm", "--bead", "gc-1", "--json"})
	cmd.Env = mergeEnv(os.Environ(),
		"GO_WANT_NT_HELPER_PROCESS=1",
		"PATH="+tmp+string(os.PathListSeparator)+os.Getenv("PATH"),
		"NOS_HOME="+t.TempDir(),
		"TMUX=",
	)
	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	err := cmd.Run()
	if err == nil {
		t.Fatal("expected fake npx crash to fail")
	}
	var payload map[string]any
	if jsonErr := json.Unmarshal(stdout.Bytes(), &payload); jsonErr != nil {
		t.Fatalf("stdout was not JSON: %v\nstdout=%s\nstderr=%s", jsonErr, stdout.String(), stderr.String())
	}
	if payload["ok"] != false || payload["status"] != "error" {
		t.Fatalf("unexpected payload: %#v", payload)
	}
	if !strings.Contains(stderr.String(), "node exploded") {
		t.Fatalf("expected child stderr to be preserved, got %q", stderr.String())
	}
}

func TestGasCityChildJsonErrorPassesThrough(t *testing.T) {
	tmp := t.TempDir()
	writeFakeTmux(t, tmp)
	writeFakeNpx(t, tmp, `#!/bin/sh
printf '{"ok":false,"schema":"gascity.swarm.result.v1","status":"error","error":"provider missing"}\n'
printf 'provider missing\n' >&2
exit 1
`)
	cmd := helperCmd(t, tmp, []string{"gascity", "swarm", "--bead", "gc-1", "--json"})
	cmd.Env = mergeEnv(os.Environ(),
		"GO_WANT_NT_HELPER_PROCESS=1",
		"PATH="+tmp+string(os.PathListSeparator)+os.Getenv("PATH"),
		"NOS_HOME="+t.TempDir(),
		"TMUX=",
	)
	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	err := cmd.Run()
	if err == nil {
		t.Fatal("expected fake npx JSON failure to fail")
	}
	if strings.Contains(stdout.String(), "bridge launch failed") {
		t.Fatalf("expected child JSON to pass through, got %s", stdout.String())
	}
	var payload map[string]any
	if jsonErr := json.Unmarshal(stdout.Bytes(), &payload); jsonErr != nil {
		t.Fatalf("stdout was not JSON: %v\nstdout=%s\nstderr=%s", jsonErr, stdout.String(), stderr.String())
	}
	if payload["error"] != "provider missing" {
		t.Fatalf("unexpected payload: %#v", payload)
	}
	if !strings.Contains(stderr.String(), "provider missing") {
		t.Fatalf("expected child stderr to be preserved, got %q", stderr.String())
	}
}

func TestHiveStatusLoadsDotEnv(t *testing.T) {
	tmp := t.TempDir()
	logPath := filepath.Join(tmp, "tmux.log")
	nosHome := t.TempDir()
	if err := os.WriteFile(filepath.Join(nosHome, ".env"), []byte("GROQ_API_KEY=from-dotenv\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	out := runNtHelper(t, tmp, logPath, []string{"hive", "status"}, "NOS_HOME="+nosHome)
	if !strings.Contains(out, "Groq        configured") {
		t.Fatalf("expected hive status to load .env, got:\n%s", out)
	}
}

func TestDotEnvParserUsesSafeKeyValueLines(t *testing.T) {
	entry, ok := parseDotEnvLine(" GROQ_API_KEY = from-dotenv ")
	if !ok {
		t.Fatal("expected dotenv entry")
	}
	if entry.key != "GROQ_API_KEY" || entry.value != "from-dotenv" {
		t.Fatalf("unexpected entry: %#v", entry)
	}

	if _, ok := parseDotEnvLine("source ./anything"); ok {
		t.Fatal("expected shell syntax to be ignored")
	}
	if _, ok := parseDotEnvLine("export GROQ_API_KEY=from-dotenv"); ok {
		t.Fatal("expected shell export syntax to be ignored")
	}
	if _, ok := parseDotEnvLine("BAD-KEY=value"); ok {
		t.Fatal("expected unsafe dotenv key to be ignored")
	}
	if _, ok := parseDotEnvLine("# comment"); ok {
		t.Fatal("expected comments to be ignored")
	}
}

func TestBootstrapUsesInternalRuntimeRoutingByDefault(t *testing.T) {
	tmp := t.TempDir()
	writeFakeTmux(t, tmp)
	writeFakeNpx(t, tmp, `#!/bin/sh
printf '%s\n' "$*" > "$NT_FAKE_NPX_LOG"
exit 0
`)
	logPath := filepath.Join(tmp, "npx.log")
	nosHome := t.TempDir()
	if err := os.MkdirAll(filepath.Join(nosHome, "src", "historian"), 0o755); err != nil {
		t.Fatal(err)
	}
	cmd := helperCmd(t, tmp, []string{"bootstrap"})
	cmd.Env = mergeEnv(os.Environ(),
		"GO_WANT_NT_HELPER_PROCESS=1",
		"PATH="+tmp+string(os.PathListSeparator)+os.Getenv("PATH"),
		"NOS_HOME="+nosHome,
		"NT_FAKE_NPX_LOG="+logPath,
		"TMUX=",
	)
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("nt helper failed: %v\n%s", err, out)
	}
	log := readLog(t, logPath)
	want := filepath.Join(nosHome, "docs", "internal-runtime", "ROUTING.md")
	if !strings.Contains(log, want) {
		t.Fatalf("expected bootstrap to use internal runtime routing path %q, got:\n%s", want, log)
	}
}

func TestNodeInvocationPrefersBuiltDistEntrypoint(t *testing.T) {
	nosHome := t.TempDir()
	if err := os.MkdirAll(filepath.Join(nosHome, "dist"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(nosHome, "dist", "index.js"), []byte(""), 0o644); err != nil {
		t.Fatal(err)
	}

	name, args := nodeInvocation(nosHome, []string{"gascity", "doctor"})
	if name != "node" {
		t.Fatalf("expected node, got %s", name)
	}
	if len(args) != 3 || args[0] != filepath.Join(nosHome, "dist", "index.js") {
		t.Fatalf("unexpected args: %#v", args)
	}
}

func TestNodeInvocationFallsBackToTsxSource(t *testing.T) {
	nosHome := t.TempDir()
	name, args := nodeInvocation(nosHome, []string{"gascity", "doctor"})
	if name != "npx" {
		t.Fatalf("expected npx, got %s", name)
	}
	if len(args) != 4 || args[0] != "tsx" || args[1] != filepath.Join(nosHome, "src", "index.ts") {
		t.Fatalf("unexpected args: %#v", args)
	}
}

func TestNtHelperProcess(t *testing.T) {
	if os.Getenv("GO_WANT_NT_HELPER_PROCESS") != "1" {
		return
	}
	idx := -1
	for i, arg := range os.Args {
		if arg == "--" {
			idx = i
			break
		}
	}
	if idx < 0 {
		os.Exit(2)
	}
	os.Args = append([]string{"nt"}, os.Args[idx+1:]...)
	main()
	os.Exit(0)
}

func runNtHelper(t *testing.T, tmp string, logPath string, args []string, env ...string) string {
	t.Helper()
	writeFakeTmux(t, tmp)
	root := repoRoot(t)
	cmd := helperCmd(t, tmp, args)
	cmd.Env = mergeEnv(os.Environ(),
		"GO_WANT_NT_HELPER_PROCESS=1",
		"NOS_HOME="+root,
		"PATH="+tmp+string(os.PathListSeparator)+os.Getenv("PATH"),
		"NT_FAKE_TMUX_LOG="+logPath,
		"TMUX=",
	)
	cmd.Env = mergeEnv(cmd.Env, env...)
	cmd.Dir = root
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("nt helper failed: %v\n%s", err, out)
	}
	return string(out)
}

func helperCmd(t *testing.T, _tmp string, args []string) *exec.Cmd {
	t.Helper()
	cmdArgs := append([]string{"-test.run=TestNtHelperProcess", "--"}, args...)
	return exec.Command(os.Args[0], cmdArgs...)
}

func mergeEnv(base []string, overrides ...string) []string {
	next := append([]string{}, base...)
	for _, override := range overrides {
		key := override
		if idx := strings.IndexByte(override, '='); idx >= 0 {
			key = override[:idx]
		}
		filtered := next[:0]
		for _, item := range next {
			if strings.HasPrefix(item, key+"=") {
				continue
			}
			filtered = append(filtered, item)
		}
		next = append(filtered, override)
	}
	return next
}

func writeFakeTmux(t *testing.T, dir string) {
	t.Helper()
	path := filepath.Join(dir, "tmux")
	script := `#!/bin/sh
printf '%s\n' "$*" >> "$NT_FAKE_TMUX_LOG"
case "$1" in
  has-session)
    if [ "$NT_FAKE_TMUX_HAS_SESSION" = "1" ]; then exit 0; fi
    exit 1
    ;;
  display-message)
    printf '%s\n' "${NT_FAKE_TMUX_PANE:-tsx}"
    exit 0
    ;;
  *)
    exit 0
    ;;
esac
`
	if runtime.GOOS == "windows" {
		t.Skip("shell-script tmux fake is POSIX-only")
	}
	if err := os.WriteFile(path, []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
}

func writeFakeNpx(t *testing.T, dir string, script string) {
	t.Helper()
	if runtime.GOOS == "windows" {
		t.Skip("shell-script npx fake is POSIX-only")
	}
	if err := os.WriteFile(filepath.Join(dir, "npx"), []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
}

func repoRoot(t *testing.T) string {
	t.Helper()
	root, err := filepath.Abs("../..")
	if err != nil {
		t.Fatal(err)
	}
	return root
}

func readLog(t *testing.T, path string) string {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	return string(data)
}

func assertLogContains(t *testing.T, log string, want string) {
	t.Helper()
	if !strings.Contains(log, want) {
		t.Fatalf("expected tmux log to contain %q, got:\n%s", want, log)
	}
}
