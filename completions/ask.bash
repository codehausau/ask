# bash completion for ask(1)
#
#   source /path/to/ask/completions/ask.bash
#
# Completes:
#   @<TAB>            paths, keeping the @ prefix (directories get a trailing /)
#   -<TAB>            flags
#   --token-field <TAB>  the two valid values
#   -m <TAB>          models from $ASK_MODELS, if set
#   -f / --system-file   plain paths
#
# Nothing is completed for the free-text question, so TAB stays out of the way
# while you type the actual prompt.

# Kept in sync with src/options.ts by test/completion.test.ts.
_ASK_FLAGS="--all-matches --api-key --base-url --dry-run --file --help \
--include-secrets --json --max-file-bytes --max-files --max-tokens \
--max-total-bytes --model --quiet --show-context --system --system-file \
--temperature --token-field --version -V -f -h -m -q -s"

# Most candidates offered for a recursive search, to keep TAB responsive.
_ASK_SEARCH_LIMIT=${_ASK_SEARCH_LIMIT:-50}

# Recursive search, mirroring what `ask` itself does when @needle is not a path.
# Case-insensitive substring match on the path; git-aware when available.
_ask_search() {
  local needle=$1 prefix=$2 item
  local -a found=()

  if git rev-parse --is-inside-work-tree > /dev/null 2>&1; then
    mapfile -t found < <(
      git ls-files --cached --others --exclude-standard 2> /dev/null |
        grep -iF -- "$needle" | LC_ALL=C sort | head -n "$_ASK_SEARCH_LIMIT"
    )
  else
    mapfile -t found < <(
      find . -type f -not -path '*/.git/*' -not -path '*/node_modules/*' \
        -printf '%P\n' 2> /dev/null |
        grep -iF -- "$needle" | LC_ALL=C sort | head -n "$_ASK_SEARCH_LIMIT"
    )
  fi

  for item in "${found[@]}"; do
    [ -n "$item" ] && COMPREPLY+=("${prefix}${item}")
  done
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
  compopt -o filenames 2>/dev/null

  # A lone directory match: no trailing space, so you can keep descending.
  if [[ ${#COMPREPLY[@]} -eq 1 && ${COMPREPLY[0]} == */ ]]; then
    compopt -o nospace 2>/dev/null
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
      _ask_paths "${cur#@}" "@"
      # Nothing matched as a prefix, so fall back to a tree search — the same
      # thing `ask @needle` does. Only for bare names: a partial path like
      # `@src/` is already unambiguous.
      if [ ${#COMPREPLY[@]} -eq 0 ] && [ -n "${cur#@}" ] && [[ ${cur#@} != */* ]]; then
        _ask_search "${cur#@}" "@"
      fi
      ;;
    -*)
      mapfile -t COMPREPLY < <(compgen -W "$_ASK_FLAGS" -- "$cur")
      ;;
  esac
  return 0
}

complete -F _ask_complete ask

# Optional fuzzy picker — the closest thing to an editor's @-mention search.
# Defined only if fzf is installed.
#
#   askf review this for me
#
# Opens fzf (TAB to select several), then runs ask with the picked paths
# attached via -f, so filenames containing spaces survive.
if command -v fzf > /dev/null 2>&1; then
  askf() {
    local -a picked=() args=()
    local item

    mapfile -t picked < <(fzf --multi --height=40% --reverse --prompt='ask @ ')
    if [ ${#picked[@]} -eq 0 ]; then
      return 1
    fi
    for item in "${picked[@]}"; do
      args+=(-f "$item")
    done
    ask "${args[@]}" "$@"
  }
fi
