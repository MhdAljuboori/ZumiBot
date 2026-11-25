import { describe, expect, it } from 'vitest'
import {
  INTERPRETERS,
  SAFE_HEADS,
  cdTarget,
  checkFolder,
  checkPrefix,
  commandParts,
  continueText,
  coveredBy,
  folderCoveredBy,
  folderOfRule,
  folderRuleError,
  homeAsFolder,
  isAllowRule,
  isGitPart,
  isSafePart,
  prefixOfRule,
  prefixRuleError,
  ruleOfFolder,
  ruleOfPrefix,
  suggestPrefix
} from '@zumibot/shared/allowRules'

describe('constants', () => {
  it('lists the interpreters and safe heads', () => {
    expect(INTERPRETERS).toEqual(
      (
        'sh bash zsh dash fish python python3 node deno bun ruby perl php npx env sudo eval exec xargs ssh ' +
        'ksh csh tcsh pwsh powershell cmd source . ' +
        'timeout nohup command busybox nice time stdbuf setsid doas su watch nsenter chroot unshare flock ionice taskset'
      ).split(' ')
    )
    expect(SAFE_HEADS).toEqual('cd echo tail head grep ls cat wc sort sleep true pwd printf awk sed cut tr'.split(' '))
  })
})

describe('commandParts', () => {
  it('splits on ; at top level', () => {
    expect(commandParts('git branch -D a c; git push origin :a :b')).toEqual(['git branch -D a c', 'git push origin :a :b'])
  })
  it('splits lines and pipes, drops assignments, keeps redirections in a part', () => {
    expect(commandParts('C=/r; cd $C\ngit branch -D a\ngit push origin :a 2>&1 | tail -1')).toEqual([
      'cd $C',
      'git branch -D a',
      'git push origin :a 2>&1',
      'tail -1'
    ])
  })
  it('keeps separators inside double quotes', () => {
    expect(commandParts('git commit -m "a; b | c" && echo ok')).toEqual(['git commit -m "a; b | c"', 'echo ok'])
  })
  it('does not split inside $(...) and drops a pure assignment', () => {
    expect(commandParts("x=$(awk '{print $3}' f); git push origin :$x")).toEqual(['git push origin :$x'])
  })
  it('drops for/done and strips do', () => {
    expect(commandParts('for b in a c; do git branch -D "$b"; done')).toEqual(['git branch -D "$b"'])
  })
  it('strips if/then/fi', () => {
    expect(commandParts('if git diff --quiet; then echo same; fi')).toEqual(['git diff --quiet', 'echo same'])
  })
  it('skips a heredoc body', () => {
    expect(commandParts('cat <<EOF > f\nrm -rf /\nEOF\ngit status')).toEqual(['cat <<EOF > f', 'git status'])
  })
  it('skips <<-EOF bodies with an indented terminator', () => {
    expect(commandParts('cat <<-EOF\n\trm -rf /\n\tEOF\ngit status')).toEqual(['cat <<-EOF', 'git status'])
  })
  it('skips quoted heredoc delimiters', () => {
    expect(commandParts("cat <<'END' > f\nrm x; rm y\nEND\ngit status")).toEqual(["cat <<'END' > f", 'git status'])
    expect(commandParts('cat <<"END"\nrm x\nEND\nls')).toEqual(['cat <<"END"', 'ls'])
  })
  it('skips two heredocs on one line, in order', () => {
    expect(commandParts('cat <<A <<B\nrm a\nA\nrm b\nB\nls')).toEqual(['cat <<A <<B', 'ls'])
  })
  it('treats an unterminated heredoc body as body', () => {
    expect(commandParts('cat <<EOF\nrm x\ngit push')).toEqual(['cat <<EOF'])
  })
  it('does not take a here-string for a heredoc', () => {
    expect(commandParts('cat <<< hi\ngit status')).toEqual(['cat <<< hi', 'git status'])
  })
  it('strips leading NAME=value words', () => {
    expect(commandParts('FOO=1 git push origin :a')).toEqual(['git push origin :a'])
    expect(commandParts('A=1 B="x y" git push')).toEqual(['git push'])
  })
  it('does not split a redirection &', () => {
    expect(commandParts('make 2>&1')).toEqual(['make 2>&1'])
    expect(commandParts('make >&2')).toEqual(['make >&2'])
    expect(commandParts('make &>f')).toEqual(['make &>f'])
    expect(commandParts('make &>>f; ls')).toEqual(['make &>>f', 'ls'])
    expect(commandParts('make >| f')).toEqual(['make >| f'])
  })
  it('splits a lone & and |&', () => {
    expect(commandParts('sleep 1 & git push')).toEqual(['sleep 1', 'git push'])
    expect(commandParts('a |& b')).toEqual(['a', 'b'])
    expect(commandParts('a || b && c')).toEqual(['a', 'b', 'c'])
  })
  it('honours single quotes, escapes and ANSI-C quotes', () => {
    expect(commandParts("echo 'a; b' ; ls")).toEqual(["echo 'a; b'", 'ls'])
    expect(commandParts('echo a\\; b; ls')).toEqual(['echo a\\; b', 'ls'])
    expect(commandParts('echo "a \\" ; b"; ls')).toEqual(['echo "a \\" ; b"', 'ls'])
    expect(commandParts("echo $'a\\'; b'; ls")).toEqual(["echo $'a\\'; b'", 'ls'])
  })
  it('does not split inside nested $(...), ${...}, backticks or process substitution', () => {
    expect(commandParts('echo $(a; (b; c) | d "x)" ); ls')).toEqual(['echo $(a; (b; c) | d "x)" )', 'ls'])
    expect(commandParts('echo "$(a; b)" ; ls')).toEqual(['echo "$(a; b)"', 'ls'])
    expect(commandParts('echo ${x:-a;b}; ls')).toEqual(['echo ${x:-a;b}', 'ls'])
    expect(commandParts('echo `a; b` ; ls')).toEqual(['echo `a; b`', 'ls'])
    expect(commandParts('diff <(a; b) <(c | d)')).toEqual(['diff <(a; b) <(c | d)'])
  })
  it('joins a backslash-newline continuation', () => {
    expect(commandParts('git push \\\n  origin :a')).toEqual(['git push    origin :a'])
  })
  it('ignores comments', () => {
    expect(commandParts('git status # rm -rf /; x\nls')).toEqual(['git status', 'ls'])
    expect(commandParts('# only a comment')).toEqual([])
    expect(commandParts('echo a#b; ls')).toEqual(['echo a#b', 'ls'])
  })
  it('keeps the commands of a subshell and a brace group', () => {
    expect(commandParts('(cd x; git push)')).toEqual(['cd x', 'git push'])
    expect(commandParts('{ git a; git b; }')).toEqual(['git a', 'git b'])
    expect(commandParts('if (cd x; git push); then ls; fi')).toEqual(['cd x', 'git push', 'ls'])
  })
  it('strips while/until/! and drops case and arithmetic', () => {
    expect(commandParts('while read x; do echo $x; done')).toEqual(['read x', 'echo $x'])
    expect(commandParts('! git diff --quiet')).toEqual(['git diff --quiet'])
    expect(commandParts('(( i++ )); ls')).toEqual(['ls'])
  })
  it('dedupes, keeping order', () => {
    expect(commandParts('git a; git b; git a')).toEqual(['git a', 'git b'])
  })
  it('returns nothing for empty input', () => {
    expect(commandParts('')).toEqual([])
    expect(commandParts('  \n ; ')).toEqual([])
  })
  it('drops a part that is only a redirection after a keyword', () => {
    expect(commandParts('while read l; do rm "$l"; done < f')).toEqual(['read l', 'rm "$l"'])
    expect(commandParts('while read l; do rm "$l"; done < f').some((p) => p.startsWith('<'))).toBe(false)
    expect(commandParts('for a in x; do rm $a; done > out')).toEqual(['rm $a'])
    expect(commandParts('if a; then b; fi 2>&1')).toEqual(['a', 'b'])
  })
  it('keeps the command behind a leading redirection, without the redirection', () => {
    expect(commandParts('>out git push')).toEqual(['git push'])
    expect(commandParts('2>/dev/null git push x')).toEqual(['git push x'])
  })
  it('survives unbalanced quotes and groups', () => {
    expect(commandParts('echo "a; b')).toEqual(['echo "a; b'])
    expect(commandParts('echo $(a; b')).toEqual(['echo $(a; b'])
    expect(commandParts("echo 'a; b")).toEqual(["echo 'a; b"])
  })
})

describe('suggestPrefix', () => {
  it('keeps subcommands and flags, stops at the first argument', () => {
    expect(suggestPrefix('git push -q origin --delete i18n-update-1794831697271')).toBe('git push -q origin --delete')
    expect(suggestPrefix('gh pr view 208 --repo $R')).toBe('gh pr view')
    expect(suggestPrefix('git worktree remove --force /tmp/oc-batch')).toBe('git worktree remove --force')
    expect(suggestPrefix('git branch -D a c')).toBe('git branch -D')
  })
  it('keeps at least the first word', () => {
    expect(suggestPrefix('./run.sh x')).toBe('./run.sh')
    expect(suggestPrefix('ls')).toBe('ls')
  })
  it('stops at a flag with a value', () => {
    expect(suggestPrefix('gh pr list --repo=a/b')).toBe('gh pr list')
  })
  it('keeps the value of git -C and git -c, then the subcommand', () => {
    expect(suggestPrefix('git -C /repo branch -D x')).toBe('git -C /repo branch -D')
    expect(suggestPrefix('git -c core.pager=x log')).toBe('git -c core.pager=x log')
    expect(suggestPrefix('git -C "my repo" push origin x')).toBe('git -C "my repo" push origin')
    expect(suggestPrefix('git -C /a -c k=v status -s')).toBe('git -C /a -c k=v status -s')
  })
  it('never stops right after git -C or -c', () => {
    expect(suggestPrefix('git -C /repo')).toBe('git -C /repo')
    expect(checkPrefix(suggestPrefix('git -C /repo'), 'git -C /repo')).toBeTruthy()
  })
  it('keeps every git global option, with = or a value word, then the subcommand', () => {
    expect(suggestPrefix('git --work-tree=/x push origin :b')).toBe('git --work-tree=/x push origin')
    expect(suggestPrefix('git --git-dir /x/.git push')).toBe('git --git-dir /x/.git push')
    expect(suggestPrefix('git --git-dir=/x/.git --work-tree=/x status -s')).toBe('git --git-dir=/x/.git --work-tree=/x status -s')
    expect(suggestPrefix('git --no-pager log -p')).toBe('git --no-pager log -p')
    expect(suggestPrefix('git --namespace ns fetch')).toBe('git --namespace ns fetch')
    expect(suggestPrefix('/usr/bin/git --work-tree=/x push origin x')).toBe('/usr/bin/git --work-tree=/x push origin')
  })
  it('suggests a prefix checkPrefix accepts for git with global options', () => {
    for (const part of ['git --work-tree=/x push origin :b', 'git --git-dir /x/.git push', 'git --no-pager log -p']) {
      expect(checkPrefix(suggestPrefix(part), part), part).toBeNull()
    }
  })
  it('always returns a word-boundary prefix of the part, even with odd spacing', () => {
    const part = 'git  push   origin --delete x'
    const p = suggestPrefix(part)
    expect(part === p || part.startsWith(p + ' ')).toBe(true)
  })
})

describe('checkPrefix', () => {
  it('accepts a prefix of a part', () => {
    expect(checkPrefix('git branch -D', 'cd x; git branch -D a')).toBeNull()
    expect(checkPrefix('git branch -D a', 'git branch -D a')).toBeNull()
    expect(checkPrefix('git branch', 'git branch -D a')).toBeNull()
  })
  it('rejects a prefix off a word boundary', () => {
    expect(checkPrefix('git bra', 'git branch -D a')).toBeTruthy()
    expect(checkPrefix('git branch -', 'git branch -D a')).toBeTruthy()
  })
  it('rejects a prefix that is not part of the command', () => {
    expect(checkPrefix('git push origin', 'git branch -D a')).toBeTruthy()
  })
  it('rejects a prefix that spans two parts', () => {
    expect(checkPrefix('git a; git b', 'git a; git b')).toBeTruthy()
  })
  it('rejects *, empty, control chars, too long, untrimmed', () => {
    const cmd = 'git branch -D a'
    expect(checkPrefix('git *', cmd)).toBeTruthy()
    expect(checkPrefix('*', cmd)).toBeTruthy()
    expect(checkPrefix('', cmd)).toBeTruthy()
    expect(checkPrefix('a\nb', cmd)).toBeTruthy()
    expect(checkPrefix('a\rb', cmd)).toBeTruthy()
    expect(checkPrefix('a\0b', cmd)).toBeTruthy()
    expect(checkPrefix('a\tb', 'a\tb c')).toBeTruthy()
    expect(checkPrefix(' git', cmd)).toBeTruthy()
    expect(checkPrefix('git ', cmd)).toBeTruthy()
    const long = 'x'.repeat(301)
    expect(checkPrefix(long, long)).toBeTruthy()
    expect(checkPrefix('x'.repeat(300), 'x'.repeat(300))).toBeNull()
  })
  it('rejects characters that could break the rule syntax', () => {
    expect(checkPrefix('echo (', 'echo (')).toBeTruthy()
    expect(checkPrefix('echo )', 'echo )')).toBeTruthy()
    expect(checkPrefix('echo \\', 'echo \\ x')).toBeTruthy()
  })
  it('rejects non-strings', () => {
    expect(checkPrefix(undefined as unknown as string, 'git a')).toBeTruthy()
    expect(checkPrefix('git', undefined as unknown as string)).toBeTruthy()
  })
  it('rejects an interpreter first word, saying Auto ignores such rules', () => {
    expect(checkPrefix('sh -c', "sh -c 'x'")).toMatch(/Auto ignores/)
    for (const i of INTERPRETERS) expect(checkPrefix(i, `${i} x`), i).toBeTruthy()
    expect(checkPrefix('/bin/bash', '/bin/bash x')).toMatch(/Auto ignores/)
    expect(checkPrefix('python3.11', 'python3.11 x')).toMatch(/Auto ignores/)
  })
  it('refuses a first word that is an interpreter in disguise', () => {
    expect(checkPrefix('BASH -c', 'BASH -c x')).toMatch(/Auto ignores/)
    expect(checkPrefix('Bash', 'Bash x')).toBeTruthy()
    expect(checkPrefix('bash.exe -c', 'bash.exe -c x')).toBeTruthy()
    expect(checkPrefix('/bin/BASH -c', '/bin/BASH -c x')).toBeTruthy()
    expect(checkPrefix('Python3.exe', 'Python3.exe x')).toBeTruthy()
    expect(checkPrefix('cmd.exe /c', 'cmd.exe /c x')).toBeTruthy()
    expect(checkPrefix('run.bat', 'run.bat x')).toBeNull()
  })
  it('refuses a first word that expands or substitutes', () => {
    expect(checkPrefix('$SHELL -c', '$SHELL -c x')).toBeTruthy()
    expect(checkPrefix('${SH} -c', '${SH} -c x')).toBeTruthy()
    expect(checkPrefix('`echo sh` x', '`echo sh` x')).toBeTruthy()
    expect(checkPrefix("'sh' -c", "'sh' -c x")).toBeTruthy()
    expect(checkPrefix('"sh" -c', '"sh" -c x')).toBeTruthy()
  })
  it.each([
    ['ksh -c', 'ksh -c x'],
    ['pwsh -c', 'pwsh -c x'],
    ['. ./x', '. ./x'],
    ['source ./x', 'source ./x'],
    ['timeout 30', 'timeout 30 git push'],
    ['nohup', 'nohup git push'],
    ['nice -n', 'nice -n 5 git push'],
    ['command', 'command git push'],
    ['busybox', 'busybox sh'],
    ['doas', 'doas git push'],
    ['su', 'su -c x'],
    ['watch', 'watch git push']
  ])('refuses the shell or wrapper prefix %s, saying why', (prefix, command) => {
    const m = checkPrefix(prefix, command)
    expect(m).toMatch(/Auto ignores/)
    expect(m).toMatch(/run any command/)
  })
  it('refuses git -C and git -c with nothing after them', () => {
    expect(checkPrefix('git -C', 'git -C /r status')).toBeTruthy()
    expect(checkPrefix('git -c', 'git -c a=b log')).toBeTruthy()
    expect(checkPrefix('git -C /r', 'git -C /r status')).toBeTruthy()
    expect(checkPrefix('git -C /r status', 'git -C /r status')).toBeNull()
    expect(checkPrefix('git -c a=b log', 'git -c a=b log')).toBeNull()
  })
  it('refuses git with no subcommand, alone or after any global options', () => {
    expect(checkPrefix('git', 'git branch -D a')).toMatch(/subcommand/)
    expect(checkPrefix('git --work-tree=/x', 'git --work-tree=/x push')).toMatch(/subcommand/)
    expect(checkPrefix('git --git-dir /x', 'git --git-dir /x push')).toMatch(/subcommand/)
    expect(checkPrefix('git --git-dir', 'git --git-dir /x push')).toMatch(/subcommand/)
    expect(checkPrefix('git --no-pager', 'git --no-pager log')).toMatch(/subcommand/)
    expect(checkPrefix('/usr/bin/git', '/usr/bin/git push')).toMatch(/subcommand/)
    expect(checkPrefix('GIT.exe', 'GIT.exe push')).toMatch(/subcommand/)
  })
  it('accepts git global options followed by the subcommand', () => {
    expect(checkPrefix('git --work-tree=/x push', 'git --work-tree=/x push origin :b')).toBeNull()
    expect(checkPrefix('git --git-dir /x push', 'git --git-dir /x push')).toBeNull()
    expect(checkPrefix('git --no-pager log', 'git --no-pager log -p')).toBeNull()
  })
  it('allows a first word that only starts like an interpreter', () => {
    expect(checkPrefix('shellcheck', 'shellcheck x')).toBeNull()
    expect(checkPrefix('node_modules/.bin/tsc', 'node_modules/.bin/tsc -v')).toBeNull()
  })
})

describe('rules', () => {
  it('builds and parses', () => {
    expect(ruleOfPrefix('git branch -D')).toBe('Bash(git branch -D:*)')
    expect(prefixOfRule('Bash(git branch -D:*)')).toBe('git branch -D')
    expect(prefixOfRule(ruleOfPrefix('git push origin :a'))).toBe('git push origin :a')
  })
  it('returns null for anything else', () => {
    expect(prefixOfRule('Bash(git:*) x')).toBeNull()
    expect(prefixOfRule('Bash(a*b:*)')).toBeNull()
    expect(prefixOfRule('Edit(x)')).toBeNull()
    expect(prefixOfRule('Bash(git)')).toBeNull()
    expect(prefixOfRule('Bash(:*)')).toBeNull()
    expect(prefixOfRule('Bash(*:*)')).toBeNull()
    expect(prefixOfRule('Bash(a\nb:*)')).toBeNull()
    expect(prefixOfRule('Bash(a:*)\n')).toBeNull()
    expect(prefixOfRule('Bash(a) (b:*)')).toBeNull()
    expect(prefixOfRule(' Bash(a:*)')).toBeNull()
    expect(prefixOfRule('Bash( a:*)')).toBeNull()
    expect(prefixOfRule(`Bash(${'x'.repeat(301)}:*)`)).toBeNull()
    expect(prefixOfRule(5 as unknown as string)).toBeNull()
  })
})

describe('coveredBy', () => {
  const rules = ['Bash(git branch -D:*)', 'Edit(x)', 'Bash(a*b:*)']
  it('returns the first covering rule', () => {
    expect(coveredBy('git branch -D a', rules)).toBe('Bash(git branch -D:*)')
    expect(coveredBy('git branch -D', rules)).toBe('Bash(git branch -D:*)')
  })
  it('needs a word boundary', () => {
    expect(coveredBy('git branch -Dx', rules)).toBeNull()
  })
  it('ignores malformed rules', () => {
    expect(coveredBy('a*b c', rules)).toBeNull()
    expect(coveredBy('x', [])).toBeNull()
  })
})

describe('isSafePart', () => {
  it('is true for a safe first word', () => {
    expect(isSafePart('cd $C')).toBe(true)
    expect(isSafePart('tail -1')).toBe(true)
    expect(isSafePart('echo ok 2>&1')).toBe(true)
    expect(isSafePart('grep x f > /dev/null')).toBe(true)
  })
  it('is false otherwise', () => {
    expect(isSafePart('git status')).toBe(false)
    expect(isSafePart('/bin/echo x')).toBe(false)
    expect(isSafePart('')).toBe(false)
  })
  it('is false when a safe head still writes or runs something', () => {
    expect(isSafePart('echo x > f')).toBe(false)
    expect(isSafePart('cat a >> b')).toBe(false)
    expect(isSafePart('echo $(rm -rf x)')).toBe(false)
    expect(isSafePart('echo `rm x`')).toBe(false)
    expect(isSafePart('sed -i s/a/b/ f')).toBe(false)
    expect(isSafePart('sed -n 1p f')).toBe(true)
    expect(isSafePart('sort -o f g')).toBe(false)
  })
})

describe('continueText', () => {
  it('names one rule for the chat', () => {
    expect(continueText(['Bash(a:*)'], 'chat', 'loc', null)).toBe('I allowed `Bash(a:*)` for this chat. Continue.')
  })
  it('lists three rules for the agent and addresses the member', () => {
    expect(continueText(['Bash(a:*)', 'Bash(b:*)', 'Bash(c:*)'], 'agent', 'loc', 'loc')).toBe(
      '@loc I allowed `Bash(a:*)`, `Bash(b:*)` and `Bash(c:*)` for loc. Continue.'
    )
  })
  it('joins two rules with and', () => {
    expect(continueText(['Bash(a:*)', 'Bash(b:*)'], 'agent', 'loc', null)).toBe(
      'I allowed `Bash(a:*)` and `Bash(b:*)` for loc. Continue.'
    )
  })
  it('addresses the member even for a chat-scope rule', () => {
    expect(continueText(['Bash(a:*)'], 'chat', 'loc', 'ui')).toBe('@ui I allowed `Bash(a:*)` for this chat. Continue.')
  })
})

describe('cdTarget', () => {
  it('gives the absolute folder a cd goes to, normalised', () => {
    expect(cdTarget('cd /a/b')).toBe('/a/b')
    expect(cdTarget('cd /a/b/')).toBe('/a/b')
    expect(cdTarget('cd /a/./b/../c')).toBe('/a/c')
    expect(cdTarget('cd //a//b')).toBe('/a/b')
    expect(cdTarget("cd '/a b/c'")).toBe('/a b/c')
    expect(cdTarget('cd "/a/b"')).toBe('/a/b')
    expect(cdTarget('cd /')).toBe('/')
    expect(cdTarget('cd /a/../..')).toBe('/')
  })
  it('is null for anything it cannot read for sure', () => {
    for (const part of ['cd rel', 'cd ../x', 'cd ~/x', 'cd ~', 'cd $HOME/x', 'cd "/a/$X"', 'cd /a/`x`', 'cd', 'cd /a /b', 'cd -P /a', 'cd /a\\ b', "cd '/a'b", 'pushd /a', 'ls /a', 'cdx /a'])
      expect(cdTarget(part)).toBeNull()
  })
})

describe('folder rules', () => {
  it('builds and parses', () => {
    expect(ruleOfFolder('/a/b')).toBe('Read(//a/b/**)')
    expect(folderOfRule('Read(//a/b/**)')).toBe('/a/b')
    expect(folderOfRule(ruleOfFolder('/x/my repo'))).toBe('/x/my repo')
  })
  it('returns null for anything else', () => {
    for (const rule of [
      'Read(/a/b/**)', // one slash: relative to the settings file, not absolute
      'Read(//a/b/**) ',
      ' Read(//a/b/**)',
      'Read(//**)',
      'Read(///**)',
      'Read(//a/../b/**)',
      'Read(//a/./b/**)',
      'Read(//a/b/)',
      'Read(//a/b)',
      'Read(//a*/b/**)',
      'Read(//a/[b]/**)',
      'Read(//a/b\nc/**)',
      'Edit(//a/b/**)',
      'Bash(a:*)',
      `Read(//a/${'x'.repeat(300)}/**)`
    ])
      expect(folderOfRule(rule)).toBeNull()
    expect(folderOfRule(5 as unknown as string)).toBeNull()
  })
  it('isAllowRule takes both kinds and nothing else', () => {
    expect(isAllowRule('Bash(git push:*)')).toBe(true)
    expect(isAllowRule('Read(//a/b/**)')).toBe(true)
    expect(isAllowRule('Read(/a/b/**)')).toBe(false)
    expect(isAllowRule('Edit(x)')).toBe(false)
    expect(isAllowRule('Bash(*)')).toBe(false)
  })
})

describe('folderCoveredBy', () => {
  const rules = ['Bash(git push:*)', 'Read(//a/b/**)', 'Read(/x/**)']
  it('returns the rule whose folder holds the target', () => {
    expect(folderCoveredBy('/a/b', rules)).toBe('Read(//a/b/**)')
    expect(folderCoveredBy('/a/b/c', rules)).toBe('Read(//a/b/**)')
  })
  it('needs a folder boundary and ignores malformed rules', () => {
    expect(folderCoveredBy('/a/bc', rules)).toBeNull()
    expect(folderCoveredBy('/a', rules)).toBeNull()
    expect(folderCoveredBy('/x/y', rules)).toBeNull()
  })
})

describe('checkFolder', () => {
  const command = 'cd /work/repo && gh pr view 1; cd /home/u && ls; cd /etc && ls; cd / && ls'
  it('accepts a folder the command changes into', () => {
    expect(checkFolder('/work/repo', command, '/home/u')).toBeNull()
    expect(checkFolder('/work/repo', command)).toBeNull()
  })
  it('refuses a folder the command does not change into', () => {
    expect(checkFolder('/work/repo/sub', command, '/home/u')).toMatch(/changes into/)
    expect(checkFolder('/other/x', command)).toMatch(/changes into/)
  })
  it('refuses the root, a top folder, and the home folder or one that holds it', () => {
    expect(checkFolder('/', command)).toMatch(/narrower/)
    expect(checkFolder('/etc', command)).toMatch(/narrower/)
    expect(checkFolder('/home/u', command, '/home/u')).toMatch(/home folder/)
    expect(checkFolder('/home/u', command, '/home/u/')).toMatch(/home folder/)
  })
  it('refuses a folder of a bad shape', () => {
    expect(checkFolder('', command)).not.toBeNull()
    expect(checkFolder('work/repo', command)).not.toBeNull()
    expect(checkFolder('/work/../work/repo', command)).not.toBeNull()
    expect(checkFolder('/work/repo/', command)).not.toBeNull()
    expect(checkFolder('/a/b*', 'cd /a/b*')).not.toBeNull()
    expect(checkFolder('/a/[b]', "cd '/a/[b]'")).not.toBeNull()
    expect(checkFolder('/a/b(c)', "cd '/a/b(c)'")).not.toBeNull()
    expect(checkFolder(5 as unknown as string, command)).not.toBeNull()
  })
})

describe('isGitPart', () => {
  it('spots git, whatever its path or case', () => {
    expect(isGitPart('git push origin x')).toBe(true)
    expect(isGitPart('/usr/bin/git status')).toBe(true)
    expect(isGitPart('GIT.exe log')).toBe(true)
    expect(isGitPart('gh pr view 1')).toBe(false)
    expect(isGitPart('gitk')).toBe(false)
    expect(isGitPart('')).toBe(false)
  })
})

describe('continueText with a folder rule', () => {
  it('names it like any rule', () => {
    expect(continueText(['Bash(gh pr merge:*)', 'Read(//a/b/**)'], 'agent', 'loc', null)).toBe(
      'I allowed `Bash(gh pr merge:*)` and `Read(//a/b/**)` for loc. Continue.'
    )
  })
})

describe('rule errors with no refused command (Agent Studio)', () => {
  it('prefixRuleError checks the shape, the program and git, not a command', () => {
    expect(prefixRuleError('gh pr merge')).toBeNull()
    expect(prefixRuleError('git push origin')).toBeNull()
    expect(prefixRuleError('')).toMatch(/empty/)
    expect(prefixRuleError('a*')).toMatch(/\*/)
    expect(prefixRuleError('sh -c')).toMatch(/Auto ignores/)
    expect(prefixRuleError('git -C /repo')).toMatch(/git subcommand/)
  })
  it('folderRuleError checks the shape and the home folder, not a command', () => {
    expect(folderRuleError('/work/repo')).toBeNull()
    expect(folderRuleError('/home/u/repo', '/home/u')).toBeNull()
    expect(folderRuleError('/home/u', '/home/u')).toMatch(/home folder/)
    expect(folderRuleError('/home', '/home/u')).toMatch(/narrower/)
    expect(folderRuleError('work/repo')).toMatch(/absolute/)
    expect(folderRuleError('/work/repo/')).toMatch(/plainly/)
  })
  // Git Bash's cd and the CLI's rule matching both spell C:\Users\me as /c/Users/me, so that is the folder to refuse.
  it('folderRuleError refuses a Windows home folder in the form a rule names it, whatever the case', () => {
    const home = 'C:\\Users\\me'
    expect(folderRuleError('/c/Users/me', home)).toMatch(/home folder/)
    expect(folderRuleError('/c/Users', home)).toMatch(/home folder/)
    expect(folderRuleError('/C/users/ME', home)).toMatch(/home folder/)
    expect(folderRuleError('/c/Users/me/repo', home)).toBeNull()
    expect(folderRuleError('/d/Users/me', home)).toBeNull()
    expect(folderRuleError('/c/Users/me', 'C:/Users/me/')).toMatch(/home folder/)
  })
  it('homeAsFolder spells a home folder as a folder rule does, or null when it cannot', () => {
    expect(homeAsFolder('/home/u/')).toBe('/home/u')
    expect(homeAsFolder('C:\\Users\\me')).toBe('/c/Users/me')
    expect(homeAsFolder('d:/Users/me')).toBe('/d/Users/me')
    expect(homeAsFolder('\\\\server\\share\\me')).toBeNull()
    expect(homeAsFolder('me')).toBeNull()
  })
})
