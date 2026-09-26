# bash completion for ask(1)
#
#   source /path/to/ask/completions/ask.bash
#
# @<TAB> behaviour depends on whether fzf is installed:
#
#   with fzf     an interactive picker opens: a highlighted list you move
#                through with the arrow keys (or keep typing to filter),
#                ENTER inserts the highlighted path, ESC cancels.
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
_ASK_FLAGS="--all-matches --api-key --apply --base-url --compact --dry-run --file \
--help --install-completion \
--include-secrets --json --max-file-bytes --max-files --max-tokens \
--max-total-bytes --model --new --no-session --quiet --reset --session \
--session-max-tokens --show-context --show-session --system --system-file \
--temperature --token-field --version -V -f -h -m -q -s"

# Chat-style verbs, accepted as the first word after `ask`.
_ASK_VERBS="/compact /new /reset /session"

# Most candidates offered for a recursive search, to keep TAB responsive.
_ASK_SEARCH_LIMIT=${_ASK_SEARCH_LIMIT:-50}

# Candidates for the picker: every tracked/untracked file, git-aware.
# Directories are included so `@somedir` can attach a whole tree.
_ask_all_paths() {
  if git rev-parse --is-inside-work-tree > /dev/null 2>&1; then
    git ls-files --cached --others --exclude-standard 2> /dev/null
  else
    find . -type f -not -path '*/.git/*' -not -path '*/node_modules/*' \
      -printf '%P\n' 2> /dev/null
  fi | LC_ALL=C sort
}

# Recursive substring search, mirroring what `ask` does when @needle is not a
# path. Prints matches, one per line.
_ask_search_paths() {
  local needle=$1
  _ask_all_paths | grep -iF -- "$needle" | head -n "$_ASK_SEARCH_LIMIT"
}

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

  chosen=$(
    _ask_all_paths | fzf \
      --height=40% \
      --reverse \
      --query="$query" \
      --select-1 \
      --exit-0 \
      --prompt="ask ${prefix} " \
      --info=inline \
      --border 2> /dev/tty
  ) || return 1

  [ -n "$chosen" ] || return 1
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
    if [[ -d $item ]]; then
      COMPREPLY+=("${prefix}${item}/")
    else
      COMPREPLY+=("${prefix}${item}")
    fi
  done < <(compgen -f -- "$partial" | LC_ALL=C sort)

  # Let bash escape spaces and other awkward characters in filenames.
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

_ask_complete() {
  local cur prev
  cur=${COMP_WORDS[COMP_CWORD]}
  prev=${COMP_WORDS[COMP_CWORD - 1]}
  COMPREPLY=()

  # Value of the flag that precedes the cursor.
  case $prev in
    -f | --file | --system-file)
      if _ask_use_fzf; then
        _ask_pick "$cur" "" && return 0
      fi
      _ask_paths "$cur" ""
      return 0
      ;;
    --token-field)
      mapfile -t COMPREPLY < <(compgen -W "max_tokens max_completion_tokens" -- "$cur")
      return 0
      ;;
    -m | --model)
      # Export ASK_MODELS="gpt-4o-mini my-gateway-model" to get suggestions.
      mapfile -t COMPREPLY < <(compgen -W "${ASK_MODELS-}" -- "$cur")
      return 0
      ;;
    -s | --system | --base-url | --api-key | --max-tokens | --temperature | \
      --max-file-bytes | --max-total-bytes | --max-files)
      # Free-form values: guessing would only get in the way.
      return 0
      ;;
  esac

  case $cur in
    @*)
      if _ask_use_fzf; then
        _ask_pick "${cur#@}" "@" && return 0
        # Picker cancelled: leave the word untouched.
        COMPREPLY=("$cur")
        return 0
      fi
      _ask_paths_or_search "${cur#@}" "@"
      ;;
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

_ask_at_widget() {
  local before=${READLINE_LINE:0:READLINE_POINT}
  local after=${READLINE_LINE:READLINE_POINT}
  local chosen

  # Not an ask command line: plain `@`.
  if [[ ! $before =~ ^[[:space:]]*(ask|askf)[[:space:]] ]]; then
    _ask_insert_at "$before" "$after"
    return 0
  fi
  # Mid-word (user@host, name@2x.png): plain `@`.
  if [[ $before =~ [^[:space:]]$ ]]; then
    _ask_insert_at "$before" "$after"
    return 0
  fi
  # No picker available: plain `@`, and TAB still completes.
  if ! _ask_use_fzf; then
    _ask_insert_at "$before" "$after"
    return 0
  fi

  chosen=$(
    _ask_all_paths | fzf --height=40% --reverse --border \
      --prompt='ask @ ' --info=inline 2> /dev/tty
  ) || chosen=""

  if [ -n "$chosen" ]; then
    # Trailing space so the question can be typed straight after.
    READLINE_LINE="${before}@${chosen} ${after}"
    READLINE_POINT=$((${#before} + ${#chosen} + 2))
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

    mapfile -t picked < <(
      _ask_all_paths | fzf --multi --height=40% --reverse --border \
        --prompt='ask @ ' --info=inline
    )
    if [ ${#picked[@]} -eq 0 ]; then
      return 1
    fi
    for item in "${picked[@]}"; do
      args+=(-f "$item")
    done
    ask "${args[@]}" "$@"
  }
fi
