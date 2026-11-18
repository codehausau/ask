# termcn OpenTUI themes

The 40 theme definitions in `src/themes/` are vendored from the
`@termcn/opentui` source registry at revision
https://github.com/shadcn-labs/termcn/tree/5a02dae79542add57ba392d2b51785138d0c3b6e/apps/web/registry/bases/opentui/themes
(registry documentation: https://termcn.dev/docs/theming/opentui).
Only their type-import paths were changed. `src/themes/types.ts` contains the
theme-only interfaces from the corresponding `ui/types.ts`, without React context
interfaces. Colors are adapted to ask's UI roles in `src/themes.ts`; spacing,
border shapes and typography remain controlled by ask's existing layout.
No React provider, registry CLI, runtime library, or network theme lookup is used.

## MIT License

Copyright (c) 2026 Aniket Pawar

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
