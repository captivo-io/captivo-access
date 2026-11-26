package main

import (
	"path"
	"regexp"
	"strings"
)

// CommandPolicy is a resource's command list as the data plane enforces it: an ALLOW list
// (only what it names may run) or a DENY list (everything may run except what it names).
// The console compiles it from the resource's command list and sends it with the target.
//
// What it is and is not. Where the command arrives whole and structured (an SSH exec
// request, a Kubernetes exec argv, a Redis or MongoDB command) the match is exact and
// is a real control. On an interactive shell the data plane only sees what was typed, and
// the shell expands it afterwards (aliases, history, completion, variables, scripts), so
// there the list is a guardrail that catches the typed line, not a boundary: say so
// wherever it is offered.
type CommandPolicy struct {
	Mode    string   `json:"mode"` // "allow" | "deny"
	Entries []string `json:"entries"`
	Name    string   `json:"name,omitempty"`
}

// Active reports whether the policy restricts anything.
func (p *CommandPolicy) Active() bool {
	return p != nil && (p.Mode == "deny" && len(p.Entries) > 0 || p.Mode == "allow")
}

// A line is cut into the commands it is made of at every separator a shell would run
// as a separate command, and command substitutions are opened up so what is inside is
// looked at too.
var (
	cmdSeparators   = regexp.MustCompile(`\|\||&&|[;|&\n\r]`)
	cmdSubstitution = regexp.MustCompile("\\$\\(|`|<\\(|>\\(")
	cmdWordSplit    = regexp.MustCompile(`[\s;|&()<>` + "`" + `'"{}]+`)
)

// Check returns whether a typed or sent command line may run, and why not.
func (p *CommandPolicy) Check(line string) (bool, string) {
	if !p.Active() {
		return true, ""
	}
	line = strings.TrimSpace(line)
	if line == "" {
		return true, ""
	}
	if p.Mode == "allow" {
		return p.checkAllow(line)
	}
	return p.checkDeny(line)
}

// ALLOW: every command in the line must be listed. A line that hides one from view
// (command substitution, process substitution) cannot be checked, so it is refused.
func (p *CommandPolicy) checkAllow(line string) (bool, string) {
	if cmdSubstitution.MatchString(line) {
		return false, "a command substitution cannot be checked against the allow list"
	}
	for _, seg := range cmdSeparators.Split(line, -1) {
		seg = strings.TrimSpace(seg)
		if seg == "" {
			continue
		}
		if !p.listed(seg) {
			return false, firstCommand(seg) + " is not on the allow list"
		}
	}
	return true, ""
}

// DENY: nothing in the line may be listed. Every word is looked at, not only the first,
// so wrappers (sudo rm, bash -c 'rm ...', xargs rm, env rm) and substitutions do not hide a
// listed command. That also refuses a line that merely mentions one (echo rm); a deny list
// errs on the side of refusing.
func (p *CommandPolicy) checkDeny(line string) (bool, string) {
	for _, seg := range cmdSeparators.Split(line, -1) {
		seg = strings.TrimSpace(seg)
		if seg == "" {
			continue
		}
		for _, e := range p.Entries {
			if entryIsPattern(e) && globMatch(normalize(e), normalize(seg)) {
				return false, "matches the deny list (" + e + ")"
			}
		}
	}
	for _, w := range cmdWordSplit.Split(line, -1) {
		if w == "" {
			continue
		}
		base := baseName(w)
		for _, e := range p.Entries {
			if !entryIsPattern(e) && strings.EqualFold(strings.TrimSpace(e), base) {
				return false, base + " is on the deny list"
			}
		}
	}
	return true, ""
}

// listed reports whether one command (no separators in it) matches an entry. An entry of
// one plain word names a command whatever its arguments; anything with a space or a *
// is matched, glob style, against the whole command with whitespace collapsed.
func (p *CommandPolicy) listed(cmd string) bool {
	n := normalize(cmd)
	name := baseName(firstCommand(cmd))
	for _, e := range p.Entries {
		if !entryIsPattern(e) {
			if strings.EqualFold(strings.TrimSpace(e), name) {
				return true
			}
			continue
		}
		if globMatch(normalize(e), n) {
			return true
		}
	}
	return false
}

func entryIsPattern(e string) bool {
	e = strings.TrimSpace(e)
	return strings.ContainsAny(e, " *?\t")
}

func normalize(s string) string { return strings.Join(strings.Fields(s), " ") }

// globMatch matches s against a pattern where * is any run of characters (including none).
func globMatch(pattern, s string) bool {
	pattern = strings.ToLower(pattern)
	s = strings.ToLower(s)
	// "systemctl status *" also names "systemctl status" with nothing after it.
	if strings.HasSuffix(pattern, " *") && globMatch(strings.TrimSuffix(pattern, " *"), s) {
		return true
	}
	ok, err := path.Match(strings.ReplaceAll(pattern, "/", "\x00"), strings.ReplaceAll(s, "/", "\x00"))
	if err == nil && ok {
		return true
	}
	// path.Match's * stops at "/", mapped away above, so only the plain star case is left to
	// check the long way for patterns path.Match rejects (a bad bracket).
	return err != nil && simpleGlob(pattern, s)
}

func simpleGlob(p, s string) bool {
	parts := strings.Split(p, "*")
	if len(parts) == 1 {
		return p == s
	}
	if !strings.HasPrefix(s, parts[0]) {
		return false
	}
	s = s[len(parts[0]):]
	for i := 1; i < len(parts)-1; i++ {
		j := strings.Index(s, parts[i])
		if j < 0 {
			return false
		}
		s = s[j+len(parts[i]):]
	}
	return strings.HasSuffix(s, parts[len(parts)-1])
}

// firstCommand is the word that starts a command, after leading environment assignments
// (FOO=bar cmd) and the wrappers that only run another command (sudo, env, nice, time).
func firstCommand(cmd string) string {
	words := strings.Fields(cmd)
	for i := 0; i < len(words); i++ {
		w := words[i]
		if strings.Contains(w, "=") && !strings.HasPrefix(w, "-") && !strings.HasPrefix(w, "/") {
			continue
		}
		switch baseName(w) {
		case "sudo", "env", "nice", "nohup", "time", "command", "exec", "doas":
			// A flag of the wrapper may follow; the command is the first word that is not one.
			j := i + 1
			for j < len(words) && strings.HasPrefix(words[j], "-") {
				j++
			}
			if j < len(words) {
				i = j - 1
				continue
			}
		}
		return w
	}
	return ""
}

func baseName(w string) string {
	w = strings.Trim(w, `'"\`)
	if i := strings.LastIndex(w, "/"); i >= 0 {
		w = w[i+1:]
	}
	return strings.TrimSpace(w)
}

// CheckArgv is Check for a command that arrives already split: a Kubernetes exec argv, a
// Redis or MongoDB command. There is no shell to expand anything, so the words are matched
// as they are: the first word against name entries (case-insensitively), the joined words
// against pattern entries. Nothing is cut at ; | & because they are data here, not syntax.
func (p *CommandPolicy) CheckArgv(argv []string) (bool, string) {
	if !p.Active() || len(argv) == 0 {
		return true, ""
	}
	line := normalize(strings.Join(argv, " "))
	name := baseName(argv[0])
	listed := false
	for _, e := range p.Entries {
		if entryIsPattern(e) {
			if globMatch(normalize(e), line) {
				listed = true
				break
			}
			continue
		}
		if strings.EqualFold(strings.TrimSpace(e), name) {
			listed = true
			break
		}
	}
	if p.Mode == "allow" {
		if !listed {
			return false, name + " is not on the allow list"
		}
		return true, ""
	}
	if listed {
		return false, name + " is on the deny list"
	}
	return true, ""
}

var shellNames = map[string]bool{"sh": true, "bash": true, "dash": true, "zsh": true, "ash": true, "ksh": true}

// CheckExec is the check for a command run in a container (kubectl exec -- argv...). The argv
// is exact, so the first word is matched as it is; but the usual way round a list is a
// wrapper (sh -c '...', env rm, xargs rm), so a deny list also looks at every word, and a
// shell's -c script is checked as the shell line it is.
func (p *CommandPolicy) CheckExec(argv []string) (bool, string) {
	if !p.Active() || len(argv) == 0 {
		return true, ""
	}
	if ok, why := p.CheckArgv(argv); !ok {
		return false, why
	}
	if p.Mode == "deny" {
		if ok, why := p.Check(strings.Join(argv, " ")); !ok {
			return false, why
		}
	}
	if shellNames[baseName(argv[0])] {
		for i := 1; i < len(argv)-1; i++ {
			if strings.HasPrefix(argv[i], "-") && strings.Contains(argv[i], "c") {
				return p.Check(argv[i+1])
			}
		}
	}
	return true, ""
}
