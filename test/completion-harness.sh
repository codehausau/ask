#!/usr/bin/env bash
# Test harness: drive the completion function without an interactive shell.
#
#   harness.sh <completion-script> <comp-cword> <word>...
#
# Prints the resulting COMPREPLY entries, one per line.

# shellcheck source=completions/ask.bash
source "$1" || exit 1
cword=$2
shift 2

COMP_WORDS=("$@")
COMP_CWORD=$cword
COMP_LINE="${COMP_WORDS[*]}"
COMP_POINT=${#COMP_LINE}

_ask_complete

if [ ${#COMPREPLY[@]} -gt 0 ]; then
  printf '%s\n' "${COMPREPLY[@]}"
fi
