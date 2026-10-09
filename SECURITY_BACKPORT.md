# Security backport

This branch packages the upstream `micromatch/braces` 3.0.3 source with a focused defense for GHSA-vfj7-8cjw-p6xm.

The backport bounds parser, AST, expansion, and flattening nesting depth before recursive processing. Inputs that exceed the bound fail with `RangeError` instead of exhausting the JavaScript stack.

Upstream source: https://github.com/micromatch/braces/tree/3.0.3

The package version is `3.0.4-security.0` so dependency scanners do not mistake this patched build for the vulnerable unmodified 3.0.3 release. The upstream MIT license is retained.
