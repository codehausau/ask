# bash completion for ask(1)
#
#   source /path/to/ask/completions/ask.bash
#
# @<TAB> behaviour depends on whether fzf is installed:
#
#   with fzf     an interactive picker opens: a highlighted list you move
#                through with the arrow keys (or keep typing to filter),
#                TAB or ENTER inserts the highlighted path, ESC cancels.
#   without fzf  plain bash completion: one match completes, several list.
#                Add `bind 'TAB: menu-complete'` to cycle through them.
#
# Other completions, both modes:
#   -<TAB>               flags
#   --token-field <TAB>  the two valid values
#   -m <TAB>             models from $ASK_MODELS, if set
#   -f / --system-file   plain paths
#
# Nothing is completed for the free-text question, so TAB stays out of the way
# while you type the actual prompt.
#
# Set ASK_FZF=0 to force plain completion even when fzf is installed.

# Kept in sync with src/options.ts by test/completion.test.ts.
_ASK_FLAGS="--all-matches --allow-insecure-http --api-key --apply --base-url --compact --create \
--diff --dry-run --file \
--help --install-completion \
--include-secrets --json --max-file-bytes --max-files --max-tokens \
--list-sessions --list-skills --max-total-bytes --model --new --no-color \
--no-next \
--no-session \
--quiet --raw --reset \
--session \
--force --session-max-tokens --show-context --show-session --skill --switch \
--system --write \
--system-file \
--temperature --token-field --version -V -f -h -m -q -s"

# Chat-style verbs, accepted as the first word after `ask`.
_ASK_VERBS="/compact /create /diff /new /reset /session /sessions /skills /switch /write"

# Most candidates offered for a recursive search, to keep TAB responsive.
_ASK_SEARCH_LIMIT=${_ASK_SEARCH_LIMIT:-50}

# Match src/git.ts's subprocess policy without changing the interactive shell's
# environment. Completion runs before the CLI, so it needs its own safe wrapper.
_ask_git() (
  export LC_ALL=C
  local name
  local -u upper
  while IFS= read -r name; do
    upper=$name
    case "$upper" in
      SHELLOPTS|BASHOPTS)
        # Bash makes these readonly; removing the export is sufficient.
        export -n "${name?}" || return 1
        ;;
      GIT_*|LD_*|DYLD_*|OPENAI_*|ASK_*|NODE_OPTIONS|BASH_ENV|ENV|CDPATH|IFS)
        unset -v "$name" || return 1
        ;;
    esac
  done < <(compgen -e)
  GIT_TERMINAL_PROMPT=0 GIT_NO_LAZY_FETCH=1 GIT_ATTR_NOSYSTEM=1 command git \
    --no-pager --no-optional-locks --no-lazy-fetch --literal-pathspecs \
    -c core.fsmonitor=false "$@"
)

# Candidates for the picker and the search fallback: every file, plus every
# directory that contains one, so `@somedir` can attach a whole tree. Directories
# are derived from the file list rather than walked separately, which keeps them
# consistent with .gitignore.
_ask_all_paths0() {
  local file parent
  while IFS= read -r -d '' file; do
    file=${file#./}
    [ -n "$file" ] || continue
    printf '%s\0' "$file"
    parent=$file
    while [[ $parent == */* ]]; do
      parent=${parent%/*}
      [ -n "$parent" ] && printf '%s/\0' "$parent"
    done
  done < <(
    if _ask_git rev-parse --is-inside-work-tree > /dev/null 2>&1; then
      _ask_git ls-files --cached --others --exclude-standard -z 2> /dev/null
    else
      find . -type f -not -path '*/.git/*' -not -path '*/node_modules/*' -print0 2> /dev/null
    fi
  ) | LC_ALL=C sort -zu
}

# Line-oriented search helpers cannot represent embedded newlines. Pickers use
# the NUL stream directly, including Git names that would otherwise be C-quoted.
_ask_all_paths() {
  local file
  while IFS= read -r -d '' file; do
    [[ $file == *$'\n'* ]] && continue
    printf '%s\n' "$file"
  done < <(_ask_all_paths0)
}

# Recursive substring search, mirroring what `ask` does when @needle is not a
# path. Prints matches, one per line.
_ask_search_paths() {
  local needle=$1
  _ask_all_paths | grep -iF -- "$needle" | head -n "$_ASK_SEARCH_LIMIT"
}

# Shared fzf options.
#
# TAB accepts in the single-select pickers, so it finishes the completion and
# closes the menu exactly as ENTER does — that is what a shell user's fingers
# expect. `askf` deliberately does not include it: there TAB is how you select
# more than one file, which is the whole point of that helper.
_ASK_FZF_COMMON=(--height=40% --reverse --border --info=inline --read0 --print0)
_ASK_FZF_SINGLE=("${_ASK_FZF_COMMON[@]}" --bind=tab:accept)

# True when an interactive fzf picker should be used. Requires fzf, a terminal
# to draw on, and no explicit opt-out — the terminal check also keeps the test
# harness (which captures output through a pipe) on the plain path.
_ask_use_fzf() {
  [ "${ASK_FZF-1}" != "0" ] && command -v fzf > /dev/null 2>&1 && [ -t 2 ]
}

# Open the picker, pre-filtered by $1, and put the chosen path in COMPREPLY
# with the $2 prefix. Returns non-zero if nothing was chosen.
_ask_pick() {
  local query=$1 prefix=$2 chosen

  IFS= read -r -d '' chosen < <(
    _ask_all_paths0 | fzf "${_ASK_FZF_SINGLE[@]}" \
      --query="$query" \
      --select-1 \
      --exit-0 \
      --prompt="ask ${prefix} " 2> /dev/tty
  ) || return 1

  [ -n "$chosen" ] || return 1
  if [[ -z $prefix && $chosen == -* ]]; then chosen=./$chosen; fi
  COMPREPLY=("${prefix}${chosen}")
  compopt -o filenames 2> /dev/null
  return 0
}

# Fill COMPREPLY with path matches for $1, each prefixed with $2.
_ask_paths() {
  local partial=$1 prefix=$2 item

  # Sorted, because compgen returns raw directory order.
  while IFS= read -r item; do
    [ -n "$item" ] || continue
    # compgen is line-oriented: never offer fragments of a newline filename.
    [[ -e $item || -L $item ]] || continue
    if [[ -d $item ]]; then
      if [[ -z $prefix && $item == -* ]]; then item=./$item; fi
      COMPREPLY+=("${prefix}${item}/")
    else
      if [[ -z $prefix && $item == -* ]]; then item=./$item; fi
      COMPREPLY+=("${prefix}${item}")
    fi
  done < <(compgen -f -- "$partial" | LC_ALL=C sort)

  # Filename/directory behaviour; _ask_complete applies explicit shell quoting.
  compopt -o filenames 2> /dev/null

  # A lone directory match: no trailing space, so you can keep descending.
  if [[ ${#COMPREPLY[@]} -eq 1 && ${COMPREPLY[0]} == */ ]]; then
    compopt -o nospace 2> /dev/null
  fi
}

# Plain-bash fallback for @refs: prefix completion, then a tree search.
_ask_paths_or_search() {
  local partial=$1 prefix=$2 item

  _ask_paths "$partial" "$prefix"

  # Nothing matched as a prefix, so fall back to a tree search — the same
  # thing `ask @needle` does. Only for bare names: a partial path like
  # `@src/` is already unambiguous.
  if [ ${#COMPREPLY[@]} -eq 0 ] && [ -n "$partial" ] && [[ $partial != */* ]]; then
    while IFS= read -r item; do
      [ -n "$item" ] && COMPREPLY+=("${prefix}${item}")
    done < <(_ask_search_paths "$partial")
  fi
}

# Readline's default filename quoting does not escape every shell metacharacter
# (notably $ and closing parentheses). Quote ourselves at a verified unquoted
# boundary, and tell readline not to quote the already-escaped word a second time.
_ask_quote_completions() {
  local i
  for ((i = 0; i < ${#COMPREPLY[@]}; i++)); do
    printf -v 'COMPREPLY[i]' '%q' "${COMPREPLY[i]}"
  done
  compopt -o noquote 2> /dev/null
  return 0
}

_ask_complete() {
  local cur prev word before
  cur=${COMP_WORDS[COMP_CWORD]}
  prev=${COMP_WORDS[COMP_CWORD - 1]}
  COMPREPLY=()
  # %q is for an unquoted word. Quoted or nested shell syntax stays untouched;
  # users can complete an unquoted prefix before adding their quoted question.
  case "$cur" in
    *\"*|*\'*|*\`*|*\$*) return 0 ;;
  esac
  word=$cur
  if [[ $prev == @ && ${COMP_LINE:0:COMP_POINT} == *"@$cur" ]]; then word=@$cur; fi
  before=${COMP_LINE:0:COMP_POINT-${#word}}
  _ask_at_unquoted_boundary "$before" || return 0

  # Value of the flag that precedes the cursor.
  case $prev in
    -f | --file | --system-file)
      if _ask_use_fzf; then
        if _ask_pick "$cur" ""; then _ask_quote_completions; return 0; fi
      fi
      _ask_paths "$cur" ""
      _ask_quote_completions
      return 0
      ;;
    --skill)
      # Skill names from the same directories the CLI searches.
      local dir names=()
      for dir in ${ASK_SKILLS_DIR//:/ } ./.ask/skills ./.agents/skills \
        "${XDG_CONFIG_HOME:-$HOME/.config}/ask/skills" "$HOME/.claude/skills"; do
        [ -d "$dir" ] || continue
        local entry
        for entry in "$dir"/*/SKILL.md; do
          [ -f "$entry" ] || continue
          entry=${entry%/SKILL.md}
          names+=("${entry##*/}")
        done
      done
      mapfile -t COMPREPLY < <(
        printf '%s\n' "${names[@]}" | LC_ALL=C sort -u | grep -i -- "^${cur}" || true
      )
      _ask_quote_completions
      return 0
      ;;
    --token-field)
      mapfile -t COMPREPLY < <(compgen -W "max_tokens max_completion_tokens" -- "$cur")
      return 0
      ;;
    -m | --model)
      # Export ASK_MODELS="gpt-4o-mini my-gateway-model" to get suggestions.
      # compgen -W evaluates shell expansions in its word list. Model names are
      # data, so split whitespace without evaluation and quote the matches.
      local model models=()
      IFS=$' \t\n' read -r -d '' -a models < <(printf '%s\0' "${ASK_MODELS-}")
      for model in "${models[@]}"; do
        [[ $model == "$cur"* ]] && COMPREPLY+=("$model")
      done
      _ask_quote_completions
      return 0
      ;;
    -s | --system | --base-url | --api-key | --max-tokens | --temperature | \
      --max-file-bytes | --max-total-bytes | --max-files)
      # Free-form values: guessing would only get in the way.
      return 0
      ;;
  esac

  # With Bash's default COMP_WORDBREAKS, @pick arrives as separate @ and pick
  # words. Filename completion still replaces the whole @-prefixed word, so
  # reconstruct the lookup while keeping @ in the returned candidate.
  # Do not change COMP_WORDBREAKS globally: that would affect other commands.
  local ref=0 query=""
  if [[ $prev == @ && ${COMP_LINE:0:COMP_POINT} == *"@$cur" ]]; then
    ref=1; query=$cur
  elif [[ $cur == @* ]]; then
    ref=1; query=${cur#@}
  fi
  if ((ref)); then
    if _ask_use_fzf; then
      _ask_pick "$query" "@" || COMPREPLY=()
    else
      _ask_paths_or_search "$query" "@"
    fi
    _ask_quote_completions
    return 0
  fi

  case $cur in
    -*)
      mapfile -t COMPREPLY < <(compgen -W "$_ASK_FLAGS" -- "$cur")
      ;;
    /*)
      # Verbs are only meaningful as the first word; elsewhere a /path is
      # more likely what was meant.
      if [ "$COMP_CWORD" -eq 1 ]; then
        mapfile -t COMPREPLY < <(compgen -W "$_ASK_VERBS" -- "$cur")
      else
        _ask_paths "$cur" ""
      fi
      ;;
    "")
      # TAB on an empty first word: show the verbs, so they are discoverable
      # without having to know that `/` is the trigger. Later words are the
      # free-text question, where suggestions would only be noise.
      if [ "$COMP_CWORD" -eq 1 ]; then
        mapfile -t COMPREPLY < <(compgen -W "$_ASK_VERBS" -- "$cur")
      fi
      ;;
  esac
  _ask_quote_completions
  return 0
}

complete -F _ask_complete ask

# --- typing `@` opens the picker (opt-in) ----------------------------------
#
# Enable with `ASK_AT_KEY=1` before sourcing this file. `@` becomes a readline
# widget, the same mechanism as fzf's own CTRL-T binding, so it is deliberately
# conservative: the picker only opens at the start of a word on an `ask`/`askf`
# command line. Everywhere else — `ssh user@host`, `git@github.com`, any other
# command — it inserts a literal `@` and gets out of the way.

_ask_insert_at() {
  local before=$1 after=$2
  READLINE_LINE="${before}@${after}"
  READLINE_POINT=$((${#before} + 1))
}

# %q is safe only at an unquoted shell-word boundary. Recognise simple words
# and quotes, but decline shell expansions/operators rather than trying to
# parse nested shell syntax. In those contexts typing @ stays literal.
_ask_at_unquoted_boundary() {
  local text=$1 char quote="" escaped=0 boundary=0 i
  for ((i = 0; i < ${#text}; i++)); do
    char=${text:i:1}
    [[ $char == $'\n' ]] && return 1
    if ((escaped)); then
      escaped=0
      boundary=0
      continue
    fi
    case "$quote" in
      single)
        [[ $char == "'" ]] && quote=""
        ;;
      double)
        case "$char" in
          '"') quote="" ;;
          \\) escaped=1 ;;
          '$'|'`') return 1 ;;
        esac
        ;;
      *)
        boundary=0
        case "$char" in
          "'") quote=single ;;
          '"') quote=double ;;
          \\) escaped=1 ;;
          ' '|$'\t') boundary=1 ;;
          '$'|'`'|';'|'|'|'&'|'('|')'|'<'|'>'|'#') return 1 ;;
        esac
        ;;
    esac
  done
  [[ -z $quote && $escaped == 0 && $boundary == 1 ]]
}

_ask_insert_ref() {
  local before=$1 after=$2 chosen=$3
  # This becomes executable shell input on ENTER, not just display text.
  printf -v chosen '%q' "$chosen"
  READLINE_LINE="${before}@${chosen} ${after}"
  READLINE_POINT=$((${#before} + ${#chosen} + 2))
}

_ask_at_widget() {
  local before=${READLINE_LINE:0:READLINE_POINT}
  local after=${READLINE_LINE:READLINE_POINT}
  local chosen

  # Not an ask command line: plain `@`.
  if [[ ! $before =~ ^[[:space:]]*(ask|askf)[[:space:]] ]]; then
    _ask_insert_at "$before" "$after"
    return 0
  fi
  # Mid-word, quoted prompt, or shell expression: plain `@`.
  if ! _ask_at_unquoted_boundary "$before"; then
    _ask_insert_at "$before" "$after"
    return 0
  fi
  # No picker available: plain `@`, and TAB still completes.
  if ! _ask_use_fzf; then
    _ask_insert_at "$before" "$after"
    return 0
  fi

  IFS= read -r -d '' chosen < <(
    _ask_all_paths0 | fzf "${_ASK_FZF_SINGLE[@]}" --prompt='ask @ ' 2> /dev/tty
  ) || chosen=""

  if [ -n "$chosen" ]; then
    # Trailing space so the question can be typed straight after.
    _ask_insert_ref "$before" "$after" "$chosen"
  else
    # Cancelled: behave as if `@` had simply been typed.
    _ask_insert_at "$before" "$after"
  fi
}

if [[ $- == *i* ]] && [ "${ASK_AT_KEY-0}" = "1" ]; then
  bind -x '"@": _ask_at_widget' 2> /dev/null
  bind -m vi-insert -x '"@": _ask_at_widget' 2> /dev/null
fi

# Optional multi-file picker: `askf <question>` opens fzf, TAB selects several
# files, and the question is passed through. Defined only if fzf is installed.
if command -v fzf > /dev/null 2>&1; then
  askf() {
    local -a picked=() args=()
    local item

    while IFS= read -r -d '' item; do
      picked+=("$item")
    done < <(
      # No tab:accept here: TAB toggles selection, which is why askf exists.
      _ask_all_paths0 | fzf "${_ASK_FZF_COMMON[@]}" --multi --prompt='ask @ '
    )
    if [ ${#picked[@]} -eq 0 ]; then
      return 1
    fi
    for item in "${picked[@]}"; do
      args+=("--file=$item")
    done
    ask "${args[@]}" "$@"
  }
fi
